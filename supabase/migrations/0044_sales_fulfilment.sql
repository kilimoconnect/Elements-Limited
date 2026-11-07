-- =========================================================================
-- Elements ERP - Migration 0044: payment-first sales with truck fulfilment
--
--   Sales Officer submits a Sales Request
--     -> ONE Branch/Sales Manager approval: verifies receipt, records it once
--        as a customer advance, commits the funds, reserves stock and creates
--        the official Sales Order (status approved)
--     -> the officer fulfils the order with one or more truck shipments:
--        loading order, actual loading, dispatch (stock out + that truck's
--        commercial invoice + application of the committed advance), and
--        collection / delivery evidence.
--
-- Accounting reuses the existing engines:
--   * verified payment  : customer receipt (kind 'advance')  Dr bank / Cr 2150
--   * truck invoice      : a posted sale (post_sale)          Dr 1140 / Cr 4100, 2120; COGS
--   * advance applied    : receipt allocation to that invoice Dr 2150 / Cr 1140
-- An order commitment is not cash; applying it records no new cash.
-- Stock is reserved by the open order lines (computed, never double counted)
-- and leaves stock only when a truck is dispatched.
-- =========================================================================

-- ---------------------------------------------------------------------------
-- 1. Accounts, numbering and permissions-facing columns on existing tables
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select id from public.companies loop
    perform public._ensure_system_account(c.id, '2150', 'Customer Advances', 'liability', '2100', 'credit', true);
    perform public._ensure_doc_sequence(c.id, 'sales_request', 'SRQ');
    perform public._ensure_doc_sequence(c.id, 'sales_order', 'SO');
    perform public._ensure_doc_sequence(c.id, 'sales_shipment', 'SHP');
    perform public._ensure_doc_sequence(c.id, 'loading_order', 'LO');
    perform public._ensure_doc_sequence(c.id, 'delivery_note', 'DN');
    perform public._ensure_doc_sequence(c.id, 'advance_refund', 'ARF');
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = '_ensure_company_defaults_0043') then
    alter function public.ensure_company_defaults(uuid) rename to _ensure_company_defaults_0043;
  end if;
end $$;
create or replace function public.ensure_company_defaults(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._ensure_company_defaults_0043(p_company);
  perform public._ensure_system_account(p_company, '2150', 'Customer Advances', 'liability', '2100', 'credit', true);
  perform public._ensure_doc_sequence(p_company, 'sales_request', 'SRQ');
  perform public._ensure_doc_sequence(p_company, 'sales_order', 'SO');
  perform public._ensure_doc_sequence(p_company, 'sales_shipment', 'SHP');
  perform public._ensure_doc_sequence(p_company, 'loading_order', 'LO');
  perform public._ensure_doc_sequence(p_company, 'delivery_note', 'DN');
  perform public._ensure_doc_sequence(p_company, 'advance_refund', 'ARF');
end; $$;
revoke all on function public.ensure_company_defaults(uuid) from public, anon, authenticated;
grant execute on function public.ensure_company_defaults(uuid) to service_role;
revoke all on function public._ensure_company_defaults_0043(uuid) from public, anon, authenticated;
grant execute on function public._ensure_company_defaults_0043(uuid) to service_role;

-- The cashier role becomes the Sales Officer (grants come from db:seed:upgrade).
update public.roles set name = 'Sales Officer',
  description = 'Submits sales requests with payment evidence and fulfils approved orders truck by truck.'
 where code = 'CASHIER' and name in ('Sales / Cashier', 'Cashier');

-- Receipts: an 'advance' receipt is money received before invoicing (credits 2150).
alter table public.customer_receipts
  add column if not exists receipt_kind       text not null default 'invoice',
  add column if not exists payment_method     text,
  add column if not exists verified_by        uuid references auth.users(id) on delete set null,
  add column if not exists verified_at        timestamptz,
  add column if not exists verification_basis text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customer_receipts_kind_check') then
    alter table public.customer_receipts add constraint customer_receipts_kind_check check (receipt_kind in ('invoice','advance'));
  end if;
end $$;
-- One payment can be recorded once: same receiving account + transaction reference.
create unique index if not exists customer_receipts_no_duplicate_reference
  on public.customer_receipts(company_id, payment_account_id, lower(btrim(reference)))
  where reference is not null and btrim(reference) <> '' and document_status <> 'voided';

-- Truck invoices are ordinary sales linked to their order and shipment.
alter table public.sales
  add column if not exists sales_order_id uuid,
  add column if not exists shipment_id    uuid;
-- Shipment invoice lines carry exact net / tax so the invoices of an order
-- add up to the approved order value (rounding settled on the last truck).
alter table public.sale_lines
  add column if not exists fixed_net numeric(18,2),
  add column if not exists fixed_tax numeric(18,2);

-- Next-order promotion rewards can be earned by an approved order.
alter table public.promotion_rewards alter column earned_sale_id drop not null;
alter table public.promotion_rewards add column if not exists earned_order_id uuid;
create unique index if not exists promotion_rewards_one_per_order
  on public.promotion_rewards(promotion_id, earned_order_id) where earned_order_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Sales Requests (preliminary; no stock, revenue or receipt)
-- ---------------------------------------------------------------------------
create table if not exists public.sales_requests (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete restrict,
  branch_id          uuid not null references public.branches(id) on delete restrict,
  document_number    text,
  status             text not null default 'draft' check (status in ('draft','pending_approval','returned','rejected','converted')),
  customer_id        uuid not null references public.customers(id) on delete restrict,
  contact_name       text,
  contact_phone      text,
  fulfilment_location text,
  fulfilment_mode    text not null default 'collection' check (fulfilment_mode in ('collection','delivery')),
  destination        text,
  consignee_name     text,
  consignee_phone    text,
  notes              text,
  order_discount     numeric(18,2) not null default 0 check (order_discount >= 0),
  subtotal           numeric(18,2) not null default 0,
  discount_total     numeric(18,2) not null default 0,
  net_total          numeric(18,2) not null default 0,
  tax_total          numeric(18,2) not null default 0,
  grand_total        numeric(18,2) not null default 0,
  decision_reason    text,
  decided_by         uuid references auth.users(id) on delete set null,
  decided_at         timestamptz,
  submitted_by       uuid references auth.users(id) on delete set null,
  submitted_at       timestamptz,
  sales_order_id     uuid,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id) on delete set null,
  updated_at         timestamptz not null default now()
);
create unique index if not exists sales_requests_docnum on public.sales_requests(company_id, document_number) where document_number is not null;
create index if not exists sales_requests_queue on public.sales_requests(company_id, branch_id, status);

create table if not exists public.sales_request_lines (
  id                  uuid primary key default gen_random_uuid(),
  request_id          uuid not null references public.sales_requests(id) on delete cascade,
  line_no             integer not null,
  product_id          uuid not null references public.products(id) on delete restrict,
  description         text,
  quantity            numeric(18,4) not null check (quantity > 0),
  unit_price          numeric(18,2) not null check (unit_price >= 0),
  original_price      numeric(18,2) not null default 0,
  discount            numeric(18,2) not null default 0 check (discount >= 0),
  tax_code_id         uuid references public.tax_codes(id) on delete set null,
  tax_rate            numeric(9,4) not null default 0,
  tax_type            text,
  tax_name            text,
  tax_inclusive       boolean not null default false,
  track_inventory     boolean not null default true,
  is_free             boolean not null default false,
  promotion_id        uuid references public.sales_promotions(id) on delete set null,
  promotion_reward_id uuid references public.promotion_rewards(id) on delete set null,
  check (not is_free or (unit_price = 0 and discount = 0))
);
create index if not exists sales_request_lines_req on public.sales_request_lines(request_id);

-- New payments reported by the officer: evidence only until the manager verifies them.
create table if not exists public.sales_request_payments (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references public.sales_requests(id) on delete cascade,
  payment_method     text not null check (payment_method in ('bank_transfer','mobile_money','cash','cheque','card','other')),
  payment_account_id uuid not null references public.payment_accounts(id) on delete restrict,
  payment_date       date not null,
  amount             numeric(18,2) not null check (amount > 0),
  reference          text not null check (btrim(reference) <> ''),
  receipt_id         uuid references public.customer_receipts(id) on delete restrict,
  created_at         timestamptz not null default now()
);
create index if not exists sales_request_payments_req on public.sales_request_payments(request_id);

-- Existing verified customer funds the officer wants to use.
create table if not exists public.sales_request_funds (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.sales_requests(id) on delete cascade,
  receipt_id uuid not null references public.customer_receipts(id) on delete restrict,
  amount     numeric(18,2) not null check (amount > 0),
  unique (request_id, receipt_id)
);

-- ---------------------------------------------------------------------------
-- 3. Sales Orders, fund commitments, shipments, exceptions, amendments
-- ---------------------------------------------------------------------------
create table if not exists public.sales_orders (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete restrict,
  branch_id           uuid not null references public.branches(id) on delete restrict,
  request_id          uuid not null unique references public.sales_requests(id) on delete restrict,
  document_number     text not null,
  status              text not null default 'approved' check (status in ('approved','in_fulfilment','completed','cancelled')),
  on_hold             boolean not null default false,
  hold_reason         text,
  customer_id         uuid not null references public.customers(id) on delete restrict,
  contact_name        text, contact_phone text,
  fulfilment_location text,
  fulfilment_mode     text not null check (fulfilment_mode in ('collection','delivery')),
  destination         text, consignee_name text, consignee_phone text,
  notes               text,
  order_discount      numeric(18,2) not null default 0,
  subtotal            numeric(18,2) not null default 0,
  discount_total      numeric(18,2) not null default 0,
  net_total           numeric(18,2) not null default 0,
  tax_total           numeric(18,2) not null default 0,
  grand_total         numeric(18,2) not null default 0,
  approved_by         uuid not null references auth.users(id) on delete restrict,
  approved_at         timestamptz not null default now(),
  verification_basis  text,
  completed_at        timestamptz,
  cancelled_at        timestamptz, cancelled_by uuid references auth.users(id) on delete set null, cancel_reason text,
  created_at          timestamptz not null default now()
);
create unique index if not exists sales_orders_docnum on public.sales_orders(company_id, document_number);
create index if not exists sales_orders_open on public.sales_orders(company_id, branch_id, status);
alter table public.sales_requests drop constraint if exists sales_requests_order_fk;
alter table public.sales_requests add constraint sales_requests_order_fk foreign key (sales_order_id) references public.sales_orders(id) on delete restrict;

create table if not exists public.sales_order_lines (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.sales_orders(id) on delete restrict,
  request_line_id  uuid references public.sales_request_lines(id) on delete set null,
  line_no          integer not null,
  product_id       uuid not null references public.products(id) on delete restrict,
  description      text,
  quantity         numeric(18,4) not null check (quantity >= 0),   -- approved quantity
  unit_price       numeric(18,2) not null check (unit_price >= 0),
  original_price   numeric(18,2) not null default 0,
  discount         numeric(18,2) not null default 0 check (discount >= 0),
  tax_code_id      uuid references public.tax_codes(id) on delete set null,
  tax_rate         numeric(9,4) not null default 0,
  tax_type         text, tax_name text,
  tax_inclusive    boolean not null default false,
  track_inventory  boolean not null default true,
  is_free          boolean not null default false,
  promotion_id     uuid references public.sales_promotions(id) on delete set null,
  net_amount       numeric(18,2) not null default 0,
  tax_amount       numeric(18,2) not null default 0,
  line_total       numeric(18,2) not null default 0,
  qty_allocated    numeric(18,4) not null default 0 check (qty_allocated >= 0),  -- on active, undispatched trucks
  qty_dispatched   numeric(18,4) not null default 0 check (qty_dispatched >= 0),
  qty_delivered    numeric(18,4) not null default 0 check (qty_delivered >= 0),
  invoiced_net     numeric(18,2) not null default 0,
  invoiced_tax     numeric(18,2) not null default 0,
  check (qty_dispatched + qty_allocated <= quantity + 0.00005)
);
create index if not exists sales_order_lines_order on public.sales_order_lines(order_id);
create index if not exists sales_order_lines_product on public.sales_order_lines(product_id);

-- Verified funds committed to an order (not cash; cash was the receipt).
create table if not exists public.sales_order_funds (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.sales_orders(id) on delete restrict,
  receipt_id      uuid not null references public.customer_receipts(id) on delete restrict,
  amount_committed numeric(18,2) not null check (amount_committed > 0),
  amount_applied  numeric(18,2) not null default 0 check (amount_applied >= 0),
  amount_released numeric(18,2) not null default 0 check (amount_released >= 0),
  created_at      timestamptz not null default now(),
  check (amount_applied + amount_released <= amount_committed + 0.001)
);
create index if not exists sales_order_funds_order on public.sales_order_funds(order_id);
create index if not exists sales_order_funds_receipt on public.sales_order_funds(receipt_id);

create table if not exists public.customer_advance_refunds (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete restrict,
  branch_id          uuid not null references public.branches(id) on delete restrict,
  document_number    text not null,
  receipt_id         uuid not null references public.customer_receipts(id) on delete restrict,
  payment_account_id uuid not null references public.payment_accounts(id) on delete restrict,
  amount             numeric(18,2) not null check (amount > 0),
  reference          text,
  reason             text not null,
  refunded_by        uuid not null references auth.users(id) on delete restrict,
  refunded_at        timestamptz not null default now()
);

create table if not exists public.sales_shipments (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete restrict,
  branch_id             uuid not null references public.branches(id) on delete restrict,
  order_id              uuid not null references public.sales_orders(id) on delete restrict,
  document_number       text not null,
  status                text not null default 'planned'
                          check (status in ('planned','loading_order_issued','loaded','dispatched','in_transit','delivered','collected','cancelled')),
  dispatch_location     text,
  consignee_name        text, consignee_phone text, destination text,
  transporter_name      text, transporter_contact text,
  driver_name           text, driver_phone text, driver_licence text,
  vehicle_registration  text, trailer_registration text,
  collector_name        text, collector_phone text, collector_id_number text,
  planned_loading_date  date, planned_dispatch_date date,
  loading_order_number  text,
  loading_order_at      timestamptz,
  loaded_at             timestamptz, loaded_by uuid references auth.users(id) on delete set null,
  dispatch_checked      boolean not null default false,
  dispatched_at         timestamptz, dispatched_by uuid references auth.users(id) on delete set null,
  delivery_note_number  text,
  invoice_sale_id       uuid references public.sales(id) on delete restrict,
  delivered_at          timestamptz, delivery_recorded_by uuid references auth.users(id) on delete set null,
  recipient_name        text, recipient_phone text, delivery_notes text,
  payment_flag          boolean not null default false,
  cancelled_at          timestamptz, cancelled_by uuid references auth.users(id) on delete set null, cancel_reason text,
  client_request_id     text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now()
);
create unique index if not exists sales_shipments_docnum on public.sales_shipments(company_id, document_number);
create unique index if not exists sales_shipments_lo on public.sales_shipments(company_id, loading_order_number) where loading_order_number is not null;
create unique index if not exists sales_shipments_dn on public.sales_shipments(company_id, delivery_note_number) where delivery_note_number is not null;
create unique index if not exists sales_shipments_request on public.sales_shipments(company_id, client_request_id) where client_request_id is not null;
create index if not exists sales_shipments_order on public.sales_shipments(order_id);

create table if not exists public.sales_shipment_lines (
  id            uuid primary key default gen_random_uuid(),
  shipment_id   uuid not null references public.sales_shipments(id) on delete restrict,
  order_line_id uuid not null references public.sales_order_lines(id) on delete restrict,
  qty_planned   numeric(18,4) not null check (qty_planned >= 0),
  qty_loaded    numeric(18,4) check (qty_loaded >= 0),
  qty_dispatched numeric(18,4) not null default 0,
  qty_accepted  numeric(18,4),
  qty_short     numeric(18,4) not null default 0,
  qty_damaged   numeric(18,4) not null default 0,
  batch_reference text,
  unique (shipment_id, order_line_id)
);

create table if not exists public.sales_order_exceptions (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.sales_orders(id) on delete restrict,
  shipment_id uuid references public.sales_shipments(id) on delete restrict,
  kind        text not null check (kind in ('delivery_shortage','delivery_damage','payment_reversed','other')),
  description text not null,
  status      text not null default 'open' check (status in ('open','resolved')),
  raised_by   uuid references auth.users(id) on delete set null,
  raised_at   timestamptz not null default now(),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolution  text
);
create index if not exists sales_order_exceptions_open on public.sales_order_exceptions(order_id) where status = 'open';

create table if not exists public.sales_order_amendments (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.sales_orders(id) on delete restrict,
  kind         text not null check (kind in ('change_lines','delivery','cancel_remaining')),
  changes      jsonb not null default '{}'::jsonb,
  reason       text not null,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by uuid not null references auth.users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  decided_by   uuid references auth.users(id) on delete set null,
  decided_at   timestamptz,
  decision_reason text,
  value_change numeric(18,2)
);

-- Timeline: request submission to truck delivery, with the named user.
create table if not exists public.sales_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  request_id  uuid references public.sales_requests(id) on delete restrict,
  order_id    uuid references public.sales_orders(id) on delete restrict,
  shipment_id uuid references public.sales_shipments(id) on delete restrict,
  event_type  text not null,
  note        text,
  user_id     uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists sales_events_request on public.sales_events(request_id);
create index if not exists sales_events_order on public.sales_events(order_id);

-- Document versions and attachments for requests and truck shipments.
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.document_versions'::regclass and contype = 'c'
             and (pg_get_constraintdef(oid) ilike '%owner_type%' or pg_get_constraintdef(oid) ilike '%rebag_sheet%') loop
    execute format('alter table public.document_versions drop constraint %I', c.conname);
  end loop;
  alter table public.document_versions add constraint document_versions_owner_v3 check (owner_type in (
    'import_receipt','stock_transfer','stock_transfer_receipt','rebag_order','stock_transfer_dispatch','sales_shipment'));
  alter table public.document_versions add constraint document_versions_kind_v2 check (kind in (
    'delivery_note','goods_received_note','rebag_sheet','loading_order','commercial_invoice'));

  alter table public.document_attachments drop constraint if exists document_attachments_owner_v3;
  alter table public.document_attachments drop constraint if exists document_attachments_category_v3;
  alter table public.document_attachments add constraint document_attachments_owner_v4 check (owner_type in (
    'import_shipment','import_receipt','cost_invoice','purchase','stock_transfer','stock_transfer_receipt','rebag_order','stock_transfer_dispatch',
    'sale','sales_request','sales_shipment'));
  alter table public.document_attachments add constraint document_attachments_category_v4 check (category in (
    'bill_of_lading','packing_list','customs_entry','supplier_invoice','cost_invoice','delivery_note','proof_of_delivery','photo','other',
    'driver_licence','cargo_papers','loading_photo','weighbridge_ticket','transport_invoice','signed_delivery_note','offloading_photo',
    'proof_of_payment','collection_authority','collection_acknowledgement'));
end $$;

create or replace function public._document_owner(p_owner_type text, p_owner_id uuid,
  out company_id uuid, out branch_ids uuid[], out view_permission text)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_owner_type = 'import_shipment' then
    select s.company_id, array[s.branch_id], 'imports.view' into company_id, branch_ids, view_permission from public.import_shipments s where s.id = p_owner_id;
  elsif p_owner_type = 'import_receipt' then
    select r.company_id, array[r.branch_id], 'imports.view' into company_id, branch_ids, view_permission from public.import_receipts r where r.id = p_owner_id;
  elsif p_owner_type = 'cost_invoice' then
    select c.company_id, null::uuid[], 'documents.view_financial' into company_id, branch_ids, view_permission from public.cost_invoices c where c.id = p_owner_id;
  elsif p_owner_type = 'purchase' then
    select p.company_id, null::uuid[], 'documents.view_financial' into company_id, branch_ids, view_permission from public.purchases p where p.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view' into company_id, branch_ids, view_permission
      from public.stock_transfers t where t.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer_receipt' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view' into company_id, branch_ids, view_permission
      from public.stock_transfer_receipts r join public.stock_transfers t on t.id = r.transfer_id where r.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer_dispatch' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view' into company_id, branch_ids, view_permission
      from public.stock_transfer_dispatches d join public.stock_transfers t on t.id = d.transfer_id where d.id = p_owner_id;
  elsif p_owner_type = 'rebag_order' then
    select o.company_id, array[o.branch_id], 'rebagging.view' into company_id, branch_ids, view_permission from public.rebag_orders o where o.id = p_owner_id;
  elsif p_owner_type = 'sale' then
    select s.company_id, array[s.branch_id], 'sales.view' into company_id, branch_ids, view_permission from public.sales s where s.id = p_owner_id;
  elsif p_owner_type = 'sales_request' then
    select s.company_id, array[s.branch_id], 'sales.view' into company_id, branch_ids, view_permission from public.sales_requests s where s.id = p_owner_id;
  elsif p_owner_type = 'sales_shipment' then
    select s.company_id, array[s.branch_id], 'sales.view' into company_id, branch_ids, view_permission from public.sales_shipments s where s.id = p_owner_id;
  end if;
  if company_id is null then raise exception 'Document owner not found' using errcode = 'P0001'; end if;
end; $$;

-- RLS: read by company access; every write goes through these functions (service role).
do $$
declare t text;
begin
  foreach t in array array['sales_requests','sales_orders','sales_shipments','sales_events','customer_advance_refunds'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_company_access(company_id))', t||'_select', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
create or replace function public._rls_child_policy(child text, parent text, fk text)
returns void language plpgsql as $$
begin
  execute format('alter table public.%I enable row level security', child);
  execute format('alter table public.%I force row level security', child);
  execute format('drop policy if exists %I on public.%I', child||'_select', child);
  execute format($f$create policy %I on public.%I for select to authenticated
    using (exists (select 1 from public.%I p
      where p.id = public.%I.%I and public.has_company_access(p.company_id)))$f$,
    child||'_select', child, parent, child, fk);
end $$;
select public._rls_child_policy('sales_request_lines', 'sales_requests', 'request_id');
select public._rls_child_policy('sales_request_payments', 'sales_requests', 'request_id');
select public._rls_child_policy('sales_request_funds', 'sales_requests', 'request_id');
select public._rls_child_policy('sales_order_lines', 'sales_orders', 'order_id');
select public._rls_child_policy('sales_order_funds', 'sales_orders', 'order_id');
select public._rls_child_policy('sales_order_exceptions', 'sales_orders', 'order_id');
select public._rls_child_policy('sales_order_amendments', 'sales_orders', 'order_id');
select public._rls_child_policy('sales_shipment_lines', 'sales_shipments', 'shipment_id');
drop function if exists public._rls_child_policy(text, text, text);
do $$
declare t text;
begin
  foreach t in array array['sales_request_lines','sales_request_payments','sales_request_funds','sales_order_lines','sales_order_funds',
                           'sales_order_exceptions','sales_order_amendments','sales_shipment_lines'] loop
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------
-- Line amounts exactly as post_sale computes them.
create or replace function public._sale_line_amounts(p_qty numeric, p_price numeric, p_discount numeric, p_rate numeric, p_inclusive boolean,
  out net numeric, out tax numeric, out total numeric)
language plpgsql immutable as $$
declare base numeric(18,2);
begin
  base := round(p_qty * p_price - p_discount, 2);
  if base < 0 then raise exception 'Line discount exceeds line value' using errcode = 'P0001'; end if;
  if p_inclusive and p_rate > 0 then
    net := round(base / (1 + p_rate / 100.0), 2); tax := round(base - net, 2); total := base;
  else
    net := base; tax := round(base * p_rate / 100.0, 2); total := round(net + tax, 2);
  end if;
end; $$;

-- Stock still promised to open orders at a branch (approved minus dispatched).
create or replace function public.sales_reserved_qty(p_company uuid, p_branch uuid, p_product uuid, p_exclude_order uuid default null)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(greatest(l.quantity - l.qty_dispatched, 0)), 0)
    from public.sales_order_lines l join public.sales_orders o on o.id = l.order_id
   where o.company_id = p_company and o.branch_id = p_branch and l.product_id = p_product and l.track_inventory
     and o.status in ('approved','in_fulfilment') and (p_exclude_order is null or o.id <> p_exclude_order);
$$;

-- Verified customer money not yet committed, refunded or applied elsewhere.
create or replace function public.customer_receipt_available(p_receipt uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select case when r.document_status = 'posted' and r.receipt_kind = 'advance' then
           r.amount
           - coalesce((select sum(f.amount_committed - f.amount_released) from public.sales_order_funds f where f.receipt_id = r.id), 0)
           - coalesce((select sum(x.amount) from public.customer_advance_refunds x where x.receipt_id = r.id), 0)
         else 0 end
    from public.customer_receipts r where r.id = p_receipt;
$$;

create or replace function public._sales_event(p_company uuid, p_request uuid, p_order uuid, p_shipment uuid, p_type text, p_note text, p_user uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.sales_events(company_id, request_id, order_id, shipment_id, event_type, note, user_id)
  values (p_company, p_request, p_order, p_shipment, p_type, p_note, p_user);
$$;

-- Records a manager-verified payment once, as a customer advance (Dr bank / Cr 2150).
create or replace function public._post_advance_receipt(p_company uuid, p_branch uuid, p_customer uuid, p_account uuid,
  p_method text, p_date date, p_amount numeric, p_reference text, p_user uuid, p_basis text, p_notes text)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; docnum text; dup text;
begin
  if coalesce(btrim(p_basis), '') = '' then
    raise exception 'Record how the receipt was verified (bank statement, mobile money record...)' using errcode = '23514';
  end if;
  select document_number into dup from public.customer_receipts
   where company_id = p_company and payment_account_id = p_account and lower(btrim(reference)) = lower(btrim(p_reference))
     and document_status <> 'voided' limit 1;
  if dup is not null then
    raise exception 'Payment reference % on this account is already recorded as receipt %; use that receipt instead', p_reference, dup using errcode = '23505';
  end if;
  perform public.assert_period_open(p_company, p_date);
  docnum := public.next_document_number(p_company, p_branch, 'sales_receipt');
  insert into public.customer_receipts(company_id, branch_id, document_status, document_number, document_date, customer_id, payment_account_id,
      amount, reference, notes, created_by, posted_by, posted_at, receipt_kind, payment_method, verified_by, verified_at, verification_basis)
    values (p_company, p_branch, 'posted', docnum, p_date, p_customer, p_account, p_amount, btrim(p_reference), p_notes, p_user, p_user, now(),
      'advance', p_method, p_user, now(), btrim(p_basis))
    returning id into rid;
  perform public.create_journal(p_company, p_branch, p_date, 'customer_receipt', rid, docnum, 'Customer advance '||docnum, p_user,
    jsonb_build_array(
      jsonb_build_object('account_id', public.resolve_payment_ledger(p_company, p_account), 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', public.account_id_by_code(p_company, '2150'), 'debit', 0, 'credit', p_amount)));
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (p_company, 'customer_receipt', rid, 'draft', 'posted', p_user);
  return rid;
end; $$;

-- ---------------------------------------------------------------------------
-- 5. post_sale: unchanged, except that fulfilment invoice lines may carry an
--    exact net / tax (fixed_net / fixed_tax) so a split order reconciles.
-- ---------------------------------------------------------------------------
create or replace function public.post_sale(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s public.sales; ln record; pay record; docnum text;
  v_subtotal numeric(18,2):=0; v_disc numeric(18,2):=0; v_net numeric(18,2):=0;
  v_tax numeric(18,2):=0; v_grand numeric(18,2):=0; v_cogs numeric(18,2):=0;
  base numeric(18,2); net numeric(18,2); tax numeric(18,2); ltotal numeric(18,2);
  paid numeric(18,2); outstanding numeric(18,2); linecogs numeric(18,2);
  jlines jsonb := '[]'::jsonb;
begin
  select * into s from public.sales where id=p_id for update;
  if not found then raise exception 'Sale not found' using errcode='P0001'; end if;
  if s.document_status <> 'draft' then raise exception 'Sale already %', s.document_status using errcode='P0001'; end if;
  if not public.claim_idempotency(p_idem, 'post_sale', p_id) then return p_id; end if;
  perform public.assert_period_open(s.company_id, s.document_date);
  if not exists (select 1 from public.sale_lines where sale_id=p_id) then
    raise exception 'Sale has no lines' using errcode='P0001';
  end if;

  docnum := public.next_document_number(s.company_id, s.branch_id, 'sales_invoice');

  for ln in select * from public.sale_lines where sale_id=p_id order by line_no loop
    if ln.fixed_net is not null then
      net := ln.fixed_net; tax := coalesce(ln.fixed_tax, 0); ltotal := round(net + tax, 2);
    else
      base := round(ln.quantity * ln.unit_price - ln.discount, 2);
      if base < 0 then raise exception 'Line discount exceeds line value' using errcode='P0001'; end if;
      if ln.tax_inclusive and ln.tax_rate > 0 then
        net := round(base / (1 + ln.tax_rate/100.0), 2);
        tax := round(base - net, 2);
        ltotal := base;
      else
        net := base;
        tax := round(base * ln.tax_rate/100.0, 2);
        ltotal := round(net + tax, 2);
      end if;
    end if;
    v_subtotal := v_subtotal + round(ln.quantity * ln.unit_price, 2);
    v_disc := v_disc + ln.discount;
    v_net := v_net + net;
    v_tax := v_tax + tax;
    v_grand := v_grand + ltotal;

    linecogs := 0;
    if ln.track_inventory then
      linecogs := public.record_stock_movement(s.company_id, s.branch_id, ln.product_id,
        'sale','sale', s.id, docnum, 0, ln.quantity, 0, p_user);
      v_cogs := v_cogs + linecogs;
    end if;
    update public.sale_lines set net_amount=net, tax_amount=tax, line_total=ltotal,
      unit_cost = case when ln.quantity>0 then round(linecogs/ln.quantity,4) else 0 end, cogs=linecogs
      where id=ln.id;
  end loop;

  select coalesce(sum(amount),0) into paid from public.sale_payments where sale_id=p_id;
  if paid > v_grand + 0.001 then raise exception 'Payments exceed the sale total' using errcode='P0001'; end if;
  outstanding := round(v_grand - paid, 2);
  if outstanding > 0 and s.customer_id is null then
    raise exception 'A credit balance requires a customer' using errcode='P0001';
  end if;

  for pay in
    select public.resolve_payment_ledger(s.company_id, payment_account_id) as acc, sum(amount) as amt
    from public.sale_payments where sale_id=p_id group by 1
  loop
    jlines := jlines || jsonb_build_object('account_id', pay.acc, 'debit', pay.amt, 'credit', 0, 'memo','Payment received');
  end loop;
  if outstanding > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'1140'),'debit',outstanding,'credit',0,'memo','Accounts receivable');
  end if;
  if v_net > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'4100'),'debit',0,'credit',v_net,'memo','Sales revenue');
  end if;
  if v_tax > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'2120'),'debit',0,'credit',v_tax,'memo','Output VAT');
  end if;
  if v_cogs > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'5100'),'debit',v_cogs,'credit',0,'memo','Cost of goods sold');
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'1150'),'debit',0,'credit',v_cogs,'memo','Inventory');
  end if;

  perform public.create_journal(s.company_id, s.branch_id, s.document_date, 'sale', s.id, docnum,
    'Sale '||docnum, p_user, jlines);

  update public.sales set document_status='posted', document_number=docnum,
    subtotal=v_subtotal, discount_total=v_disc, net_total=v_net, tax_total=v_tax,
    grand_total=v_grand, cogs_total=v_cogs, posted_by=p_user, posted_at=now() where id=p_id;

  perform public.recalc_sale(p_id);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (s.company_id, 'sale', p_id, 'draft', 'posted', p_user);
  return p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 6. Request submission and the ONE manager decision
-- ---------------------------------------------------------------------------
create or replace function public.submit_sales_request(p_request uuid, p_user uuid)
returns text language plpgsql security definer set search_path = public as $$
declare rq public.sales_requests;
begin
  select * into rq from public.sales_requests where id = p_request for update;
  if not found then raise exception 'Sales request not found' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, rq.company_id, 'sales.create', rq.branch_id);
  if rq.status = 'pending_approval' then return rq.document_number; end if;
  if rq.status not in ('draft','returned') then raise exception 'This request is % and cannot be submitted', rq.status using errcode = 'P0001'; end if;
  if not exists (select 1 from public.sales_request_lines where request_id = p_request) then
    raise exception 'Add at least one product' using errcode = 'P0001';
  end if;
  if rq.document_number is null then
    rq.document_number := public.next_document_number(rq.company_id, rq.branch_id, 'sales_request');
  end if;
  update public.sales_requests set status = 'pending_approval', document_number = rq.document_number,
    submitted_by = p_user, submitted_at = now(), updated_by = p_user, updated_at = now() where id = p_request;
  perform public._sales_event(rq.company_id, p_request, null, null, 'submitted',
    case when rq.status = 'returned' then 'Resubmitted after correction' else 'Submitted for approval' end, p_user);
  return rq.document_number;
end; $$;

create or replace function public.decide_sales_request(p_request uuid, p_user uuid, p_decision text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare rq public.sales_requests;
begin
  select * into rq from public.sales_requests where id = p_request for update;
  if not found then raise exception 'Sales request not found' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, rq.company_id, 'sales.approve', rq.branch_id);
  if rq.status <> 'pending_approval' then raise exception 'Only requests awaiting approval can be decided' using errcode = 'P0001'; end if;
  if p_decision not in ('return','reject') then raise exception 'Unknown decision' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  update public.sales_requests set status = case p_decision when 'return' then 'returned' else 'rejected' end,
    decision_reason = btrim(p_reason), decided_by = p_user, decided_at = now(), updated_at = now() where id = p_request;
  perform public._sales_event(rq.company_id, p_request, null, null,
    case p_decision when 'return' then 'returned' else 'rejected' end, btrim(p_reason), p_user);
end; $$;

-- Commits verified funds of the order's customer: [{receipt_id, amount}].
-- Each selected amount must still be fully available. Returns what is still needed.
create or replace function public._commit_order_funds(p_order uuid, p_funds jsonb, p_need numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare o public.sales_orders; e jsonb; rid uuid; amt numeric(18,2); avail numeric(18,2); take numeric(18,2); need numeric(18,2) := p_need;
begin
  select * into o from public.sales_orders where id = p_order;
  for e in select * from jsonb_array_elements(coalesce(p_funds, '[]'::jsonb)) loop
    exit when need <= 0;
    rid := (e->>'receipt_id')::uuid; amt := coalesce((e->>'amount')::numeric, 0);
    continue when amt <= 0;
    perform 1 from public.customer_receipts where id = rid and company_id = o.company_id and customer_id = o.customer_id
      and document_status = 'posted' and receipt_kind = 'advance' for update;
    if not found then raise exception 'A selected receipt is not a verified payment of this customer' using errcode = 'P0001'; end if;
    avail := public.customer_receipt_available(rid);
    if avail < amt - 0.004 then raise exception 'Selected customer funds are no longer available (receipt has % TZS left)', avail using errcode = 'P0001'; end if;
    take := least(amt, need);
    insert into public.sales_order_funds(order_id, receipt_id, amount_committed) values (p_order, rid, take);
    need := need - take;
  end loop;
  return need;
end; $$;

-- Value of the order not yet invoiced, and the commitments still unapplied on valid receipts.
create or replace function public._order_uncovered(p_order uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(
    (select o.grand_total - coalesce((select sum(l.invoiced_net + l.invoiced_tax) from public.sales_order_lines l where l.order_id = o.id), 0)
       from public.sales_orders o where o.id = p_order)
    - coalesce((select sum(f.amount_committed - f.amount_applied - f.amount_released) from public.sales_order_funds f
                 join public.customer_receipts r on r.id = f.receipt_id
                where f.order_id = p_order and r.document_status = 'posted'), 0), 2);
$$;

-- Approve Sale: verify and record receipts once, commit funds, reserve stock and
-- create the approved Sales Order, all or nothing. A repeat returns the same order.
create or replace function public.approve_sales_request(p_request uuid, p_user uuid, p_idem text, p_verifications jsonb, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  rq public.sales_requests; ln record; pm record; v jsonb; rid uuid; oid uuid; docnum text;
  a record; t_sub numeric(18,2) := 0; t_disc numeric(18,2) := 0; t_net numeric(18,2) := 0; t_tax numeric(18,2) := 0; t_grand numeric(18,2) := 0;
  need numeric(18,2); avail numeric(18,2); take numeric(18,2); pr record; onhand numeric; reserved numeric;
  basis text := ''; claimed int; expected int; sku text; sel jsonb;
begin
  select * into rq from public.sales_requests where id = p_request for update;
  if not found then raise exception 'Sales request not found' using errcode = 'P0001'; end if;
  if rq.status = 'converted' and rq.sales_order_id is not null then return rq.sales_order_id; end if;
  if rq.status <> 'pending_approval' then raise exception 'Only requests awaiting approval can be approved (this one is %)', rq.status using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, rq.company_id, 'sales.approve', rq.branch_id);
  if p_user = rq.created_by or p_user = rq.submitted_by then
    raise exception 'You cannot approve a sales request you prepared or submitted; another authorised manager must approve it' using errcode = '42501';
  end if;
  if not public.claim_idempotency(p_idem, 'approve_sales_request', p_request) then
    return (select sales_order_id from public.sales_requests where id = p_request);
  end if;
  if not exists (select 1 from public.sales_request_lines where request_id = p_request) then
    raise exception 'The request has no products' using errcode = 'P0001';
  end if;

  -- 1. Totals from the lines (the request's own totals are not trusted).
  for ln in select * from public.sales_request_lines where request_id = p_request order by line_no loop
    a := public._sale_line_amounts(ln.quantity, ln.unit_price, ln.discount, ln.tax_rate, ln.tax_inclusive);
    t_sub := t_sub + round(ln.quantity * ln.unit_price, 2); t_disc := t_disc + ln.discount;
    t_net := t_net + a.net; t_tax := t_tax + a.tax; t_grand := t_grand + a.total;
  end loop;

  -- 2. Each new payment must be independently verified by the approver, then recorded once.
  for pm in select * from public.sales_request_payments where request_id = p_request order by created_at, id loop
    v := null;
    select e into v from jsonb_array_elements(coalesce(p_verifications, '[]'::jsonb)) e where e->>'payment_id' = pm.id::text;
    if v is null or coalesce(btrim(v->>'basis'), '') = '' then
      raise exception 'Payment % of % TZS is not verified. Check it against the bank or collection record and state how it was verified.', pm.reference, pm.amount using errcode = 'P0001';
    end if;
    if pm.receipt_id is null then
      rid := public._post_advance_receipt(rq.company_id, rq.branch_id, rq.customer_id, pm.payment_account_id, pm.payment_method,
        pm.payment_date, pm.amount, pm.reference, p_user, v->>'basis', 'Sales request ' || coalesce(rq.document_number, ''));
      update public.sales_request_payments set receipt_id = rid where id = pm.id;
    end if;
    basis := basis || case when basis = '' then '' else '; ' end || pm.reference || ': ' || btrim(v->>'basis');
  end loop;

  -- 3. The official order, directly approved.
  docnum := public.next_document_number(rq.company_id, rq.branch_id, 'sales_order');
  insert into public.sales_orders(company_id, branch_id, request_id, document_number, status, customer_id, contact_name, contact_phone,
      fulfilment_location, fulfilment_mode, destination, consignee_name, consignee_phone, notes, order_discount,
      subtotal, discount_total, net_total, tax_total, grand_total, approved_by, approved_at, verification_basis)
    values (rq.company_id, rq.branch_id, rq.id, docnum, 'approved', rq.customer_id, rq.contact_name, rq.contact_phone,
      rq.fulfilment_location, rq.fulfilment_mode, rq.destination, rq.consignee_name, rq.consignee_phone, rq.notes, rq.order_discount,
      t_sub, t_disc, t_net, t_tax, t_grand, p_user, now(), nullif(concat_ws(' | ', nullif(basis, ''), nullif(btrim(coalesce(p_note, '')), '')), ''))
    returning id into oid;
  for ln in select * from public.sales_request_lines where request_id = p_request order by line_no loop
    a := public._sale_line_amounts(ln.quantity, ln.unit_price, ln.discount, ln.tax_rate, ln.tax_inclusive);
    insert into public.sales_order_lines(order_id, request_line_id, line_no, product_id, description, quantity, unit_price, original_price, discount,
        tax_code_id, tax_rate, tax_type, tax_name, tax_inclusive, track_inventory, is_free, promotion_id, net_amount, tax_amount, line_total)
      values (oid, ln.id, ln.line_no, ln.product_id, ln.description, ln.quantity, ln.unit_price, ln.original_price, ln.discount,
        ln.tax_code_id, ln.tax_rate, ln.tax_type, ln.tax_name, ln.tax_inclusive, ln.track_inventory, ln.is_free, ln.promotion_id, a.net, a.tax, a.total);
  end loop;

  -- 4. Stock: on hand minus what other open orders have reserved must cover this order.
  for pr in select l.product_id, sum(l.quantity) q from public.sales_order_lines l where l.order_id = oid and l.track_inventory group by l.product_id loop
    onhand := null;
    select quantity into onhand from public.stock_balances where company_id = rq.company_id and branch_id = rq.branch_id and product_id = pr.product_id for update;
    reserved := public.sales_reserved_qty(rq.company_id, rq.branch_id, pr.product_id, oid);
    if coalesce(onhand, 0) - reserved < pr.q - 0.00005 then
      select p.sku into sku from public.products p where p.id = pr.product_id;
      raise exception 'Not enough stock for %: on hand %, reserved for other orders %, this order needs %', sku, coalesce(onhand, 0), reserved, pr.q using errcode = 'P0001';
    end if;
  end loop;

  -- 5. Commit verified funds: selected existing funds first, then the new receipts.
  select coalesce(jsonb_agg(jsonb_build_object('receipt_id', receipt_id, 'amount', amount) order by id), '[]'::jsonb) into sel
    from public.sales_request_funds where request_id = p_request;
  need := public._commit_order_funds(oid, sel, t_grand);
  for pm in select * from public.sales_request_payments where request_id = p_request and receipt_id is not null order by created_at, id loop
    exit when need <= 0;
    avail := public.customer_receipt_available(pm.receipt_id);
    take := least(avail, need);
    if take > 0 then
      insert into public.sales_order_funds(order_id, receipt_id, amount_committed) values (oid, pm.receipt_id, take);
      need := need - take;
    end if;
  end loop;
  if need > 0.004 then
    raise exception 'Verified funds do not cover the sale: order value % TZS, verified funds short by % TZS', t_grand, need using errcode = 'P0001';
  end if;

  -- 6. Free goods earned in earlier orders that this order gives out.
  select count(*) into expected from public.sales_request_lines where request_id = p_request and promotion_reward_id is not null;
  if expected > 0 then
    update public.promotion_rewards set status = 'redeemed', redeemed_at = now()
     where id in (select promotion_reward_id from public.sales_request_lines where request_id = p_request and promotion_reward_id is not null)
       and status = 'available' and customer_id = rq.customer_id;
    get diagnostics claimed = row_count;
    if claimed <> expected then raise exception 'Free goods earned earlier were already given in another order; return the request for correction' using errcode = 'P0001'; end if;
  end if;

  update public.sales_requests set status = 'converted', sales_order_id = oid, decided_by = p_user, decided_at = now(),
    subtotal = t_sub, discount_total = t_disc, net_total = t_net, tax_total = t_tax, grand_total = t_grand,
    decision_reason = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now() where id = p_request;
  perform public._sales_event(rq.company_id, p_request, oid, null, 'approved', 'Sale approved: payment verified, order ' || docnum || ' created', p_user);
  return oid;
end; $$;

-- ---------------------------------------------------------------------------
-- 7. Trucks: create, loading order, actual loading, cancel
-- ---------------------------------------------------------------------------
create or replace function public._assert_order_open(o public.sales_orders)
returns void language plpgsql as $$
begin
  if o.status not in ('approved','in_fulfilment') then raise exception 'Order % is %', o.document_number, o.status using errcode = 'P0001'; end if;
  if o.on_hold then raise exception 'Order % is on hold: %', o.document_number, coalesce(o.hold_reason, 'see exceptions') using errcode = 'P0001'; end if;
end; $$;

create or replace function public.create_sales_shipment(p_order uuid, p_user uuid, p_request_key text, p_header jsonb, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare o public.sales_orders; sid uuid; e jsonb; ol public.sales_order_lines; q numeric; n int := 0;
begin
  if coalesce(p_request_key, '') = '' then raise exception 'Missing request key' using errcode = 'P0001'; end if;
  select * into o from public.sales_orders where id = p_order for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  select id into sid from public.sales_shipments where company_id = o.company_id and client_request_id = p_request_key;
  if sid is not null then return sid; end if;
  perform public.assert_actor(p_user, o.company_id, 'sales.fulfil', o.branch_id);
  perform public._assert_order_open(o);
  insert into public.sales_shipments(company_id, branch_id, order_id, document_number, dispatch_location, consignee_name, consignee_phone, destination,
      transporter_name, transporter_contact, driver_name, driver_phone, driver_licence, vehicle_registration, trailer_registration,
      collector_name, collector_phone, collector_id_number, planned_loading_date, planned_dispatch_date, client_request_id, created_by)
    values (o.company_id, o.branch_id, o.id, public.next_document_number(o.company_id, o.branch_id, 'sales_shipment'),
      coalesce(nullif(p_header->>'dispatch_location', ''), o.fulfilment_location),
      coalesce(nullif(p_header->>'consignee_name', ''), o.consignee_name), coalesce(nullif(p_header->>'consignee_phone', ''), o.consignee_phone),
      coalesce(nullif(p_header->>'destination', ''), o.destination),
      nullif(p_header->>'transporter_name', ''), nullif(p_header->>'transporter_contact', ''),
      nullif(p_header->>'driver_name', ''), nullif(p_header->>'driver_phone', ''), nullif(p_header->>'driver_licence', ''),
      nullif(p_header->>'vehicle_registration', ''), nullif(p_header->>'trailer_registration', ''),
      nullif(p_header->>'collector_name', ''), nullif(p_header->>'collector_phone', ''), nullif(p_header->>'collector_id_number', ''),
      nullif(p_header->>'planned_loading_date', '')::date, nullif(p_header->>'planned_dispatch_date', '')::date, p_request_key, p_user)
    returning id into sid;
  for e in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    q := coalesce((e->>'qty')::numeric, 0);
    continue when q <= 0;
    select * into ol from public.sales_order_lines where id = (e->>'order_line_id')::uuid and order_id = o.id for update;
    if not found then raise exception 'A product is not on this order' using errcode = 'P0001'; end if;
    if not ol.track_inventory then raise exception 'Charges are invoiced automatically with the trucks; load only goods' using errcode = 'P0001'; end if;
    if ol.qty_dispatched + ol.qty_allocated + q > ol.quantity + 0.00005 then
      raise exception '%: only % left to allocate (approved %, dispatched %, on other trucks %)', coalesce(ol.description, 'Product'),
        ol.quantity - ol.qty_dispatched - ol.qty_allocated, ol.quantity, ol.qty_dispatched, ol.qty_allocated using errcode = 'P0001';
    end if;
    update public.sales_order_lines set qty_allocated = qty_allocated + q where id = ol.id;
    insert into public.sales_shipment_lines(shipment_id, order_line_id, qty_planned) values (sid, ol.id, q);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one product with a quantity to this truck' using errcode = 'P0001'; end if;
  perform public._sales_event(o.company_id, null, o.id, sid, 'shipment_created', null, p_user);
  return sid;
end; $$;

-- Everything a truck document shows, frozen when the document is finalised.
create or replace function public.sales_shipment_snapshot(p_shipment uuid, p_kind text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'kind', p_kind,
    'company', jsonb_build_object('name', c.name, 'legal_name', c.legal_name, 'address', c.address, 'phone', c.phone, 'email', c.email),
    'branch', jsonb_build_object('code', b.code, 'name', b.name, 'address', b.address, 'phone', b.phone),
    'order', jsonb_build_object('number', o.document_number, 'approved_at', o.approved_at,
                                'approved_by', (select coalesce(up.full_name, up.email) from public.user_profiles up where up.id = o.approved_by),
                                'request_number', rq.document_number, 'fulfilment_mode', o.fulfilment_mode),
    'shipment', jsonb_build_object('number', s.document_number, 'loading_order_number', s.loading_order_number,
                                   'delivery_note_number', s.delivery_note_number, 'dispatch_location', s.dispatch_location,
                                   'planned_loading_date', s.planned_loading_date, 'planned_dispatch_date', s.planned_dispatch_date,
                                   'loading_order_at', s.loading_order_at, 'dispatched_at', s.dispatched_at,
                                   'prepared_by', (select coalesce(up.full_name, up.email) from public.user_profiles up where up.id = s.created_by),
                                   'dispatched_by', (select coalesce(up.full_name, up.email) from public.user_profiles up where up.id = s.dispatched_by)),
    'customer', jsonb_build_object('code', cu.code, 'name', cu.name, 'address', cu.address, 'phone', cu.phone, 'tin', cu.tin, 'vat_number', cu.vat_number,
                                   'contact_name', o.contact_name, 'contact_phone', o.contact_phone),
    'consignee', jsonb_build_object('name', s.consignee_name, 'phone', s.consignee_phone, 'destination', s.destination),
    'transport', jsonb_build_object('transporter', s.transporter_name, 'transporter_contact', s.transporter_contact, 'driver', s.driver_name,
                                    'driver_phone', s.driver_phone, 'driver_licence', s.driver_licence, 'vehicle', s.vehicle_registration,
                                    'trailer', s.trailer_registration, 'collector', s.collector_name, 'collector_phone', s.collector_phone,
                                    'collector_id', s.collector_id_number),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                 'sku', p.sku, 'name', coalesce(ol.description, p.name), 'unit', u.code,
                 'qty', case when p_kind = 'loading_order' then coalesce(sl.qty_loaded, sl.qty_planned) else sl.qty_dispatched end,
                 'kg_per_unit', public._kg_per_unit(p.id), 'batch', sl.batch_reference, 'is_free', ol.is_free) order by ol.line_no)
               from public.sales_shipment_lines sl join public.sales_order_lines ol on ol.id = sl.order_line_id
               join public.products p on p.id = ol.product_id left join public.units u on u.id = p.base_unit_id
               where sl.shipment_id = s.id and (p_kind = 'loading_order' or sl.qty_dispatched > 0)), '[]'::jsonb),
    'invoice', case when p_kind = 'commercial_invoice' and sa.id is not null then jsonb_build_object(
                 'number', sa.document_number, 'date', sa.document_date, 'subtotal', sa.subtotal, 'discount_total', sa.discount_total,
                 'net_total', sa.net_total, 'tax_total', sa.tax_total, 'grand_total', sa.grand_total,
                 'amount_paid', sa.amount_paid, 'outstanding', sa.outstanding,
                 'order_total', o.grand_total,
                 'lines', (select jsonb_agg(jsonb_build_object('description', coalesce(x.description, xp.name), 'sku', xp.sku, 'qty', x.quantity,
                           'unit_price', x.unit_price, 'discount', x.discount, 'tax_name', x.tax_name, 'tax_rate', x.tax_rate,
                           'net', x.net_amount, 'tax', x.tax_amount, 'total', x.line_total) order by x.line_no)
                           from public.sale_lines x join public.products xp on xp.id = x.product_id where x.sale_id = sa.id),
                 'payments', coalesce((select jsonb_agg(jsonb_build_object('receipt', r.document_number, 'reference', r.reference,
                           'method', r.payment_method, 'amount', al.amount) order by r.document_number)
                           from public.customer_receipt_allocations al join public.customer_receipts r on r.id = al.receipt_id
                           where al.sale_id = sa.id), '[]'::jsonb)) end)
  from public.sales_shipments s
  join public.sales_orders o on o.id = s.order_id
  join public.sales_requests rq on rq.id = o.request_id
  join public.companies c on c.id = s.company_id
  join public.branches b on b.id = s.branch_id
  join public.customers cu on cu.id = o.customer_id
  left join public.sales sa on sa.id = s.invoice_sale_id
  where s.id = p_shipment;
$$;

create or replace function public._store_shipment_document(p_shipment uuid, p_kind text, p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare snap jsonb; last public.document_versions; nid uuid; cid uuid;
begin
  select company_id into cid from public.sales_shipments where id = p_shipment;
  snap := public.sales_shipment_snapshot(p_shipment, p_kind);
  select * into last from public.document_versions where owner_type = 'sales_shipment' and owner_id = p_shipment and kind = p_kind order by version desc limit 1;
  if last.id is not null and last.snapshot = snap then return last.id; end if;
  insert into public.document_versions(company_id, owner_type, owner_id, kind, version, snapshot, content_sha256, created_by)
    values (cid, 'sales_shipment', p_shipment, p_kind, coalesce(last.version, 0) + 1, snap, encode(sha256(convert_to(snap::text, 'UTF8')), 'hex'), p_user)
    returning id into nid;
  return nid;
end; $$;

create or replace function public.issue_loading_order(p_shipment uuid, p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.sales_shipments; o public.sales_orders;
begin
  select * into s from public.sales_shipments where id = p_shipment for update;
  if not found then raise exception 'Truck not found' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, s.company_id, 'sales.fulfil', s.branch_id);
  if s.status not in ('planned','loading_order_issued','loaded') then
    -- After dispatch the loading order is only reprinted from its stored version.
    return (select id from public.document_versions where owner_type = 'sales_shipment' and owner_id = s.id and kind = 'loading_order' order by version desc limit 1);
  end if;
  select * into o from public.sales_orders where id = s.order_id;
  perform public._assert_order_open(o);
  if s.loading_order_number is null then
    update public.sales_shipments set loading_order_number = public.next_document_number(s.company_id, s.branch_id, 'loading_order'),
      loading_order_at = now(), status = 'loading_order_issued'
     where id = s.id returning * into s;
    perform public._sales_event(s.company_id, null, s.order_id, s.id, 'loading_order', 'Loading order ' || s.loading_order_number || ' issued', p_user);
  end if;
  return public._store_shipment_document(s.id, 'loading_order', p_user);
end; $$;

create or replace function public.record_shipment_loading(p_shipment uuid, p_user uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sales_shipments; o public.sales_orders; sl public.sales_shipment_lines; ol public.sales_order_lines; e jsonb; q numeric; prev numeric; delta numeric;
begin
  select * into s from public.sales_shipments where id = p_shipment for update;
  if not found then raise exception 'Truck not found' using errcode = 'P0001'; end if;
  select * into o from public.sales_orders where id = s.order_id for update;
  perform public.assert_actor(p_user, s.company_id, 'sales.fulfil', s.branch_id);
  perform public._assert_order_open(o);
  if s.status not in ('loading_order_issued','loaded') then raise exception 'Issue the loading order before recording loading' using errcode = 'P0001'; end if;
  for e in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into sl from public.sales_shipment_lines where id = (e->>'shipment_line_id')::uuid and shipment_id = s.id for update;
    if not found then raise exception 'A line is not on this truck' using errcode = 'P0001'; end if;
    q := (e->>'qty_loaded')::numeric;
    if q is null or q < 0 then raise exception 'Enter the actual loaded quantity' using errcode = 'P0001'; end if;
    select * into ol from public.sales_order_lines where id = sl.order_line_id for update;
    prev := coalesce(sl.qty_loaded, sl.qty_planned);
    delta := q - prev;
    -- Loading more than planned may use the order's unallocated balance, never more.
    if delta > 0 and ol.qty_dispatched + ol.qty_allocated + delta > ol.quantity + 0.00005 then
      raise exception '%: loading % is more than the approved order allows (only % more can be loaded). Request an amendment to increase the order.',
        coalesce(ol.description, 'Product'), q, ol.quantity - ol.qty_dispatched - ol.qty_allocated using errcode = 'P0001';
    end if;
    update public.sales_order_lines set qty_allocated = greatest(qty_allocated + delta, 0) where id = ol.id;
    update public.sales_shipment_lines set qty_loaded = q, batch_reference = coalesce(nullif(e->>'batch', ''), batch_reference) where id = sl.id;
  end loop;
  if not exists (select 1 from public.sales_shipment_lines where shipment_id = s.id and coalesce(qty_loaded, qty_planned) > 0) then
    raise exception 'Nothing is loaded on this truck; cancel it instead' using errcode = 'P0001';
  end if;
  update public.sales_shipments set status = 'loaded', loaded_at = now(), loaded_by = p_user where id = s.id;
  perform public._sales_event(s.company_id, null, s.order_id, s.id, 'loaded', 'Actual loading recorded', p_user);
end; $$;

create or replace function public.cancel_sales_shipment(p_shipment uuid, p_user uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sales_shipments; sl record;
begin
  select * into s from public.sales_shipments where id = p_shipment for update;
  if not found then raise exception 'Truck not found' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, s.company_id, 'sales.fulfil', s.branch_id);
  if s.status = 'cancelled' then return; end if;
  if s.status not in ('planned','loading_order_issued','loaded') then raise exception 'A dispatched truck cannot be cancelled' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  perform 1 from public.sales_orders where id = s.order_id for update;
  for sl in select * from public.sales_shipment_lines where shipment_id = s.id loop
    update public.sales_order_lines set qty_allocated = greatest(qty_allocated - coalesce(sl.qty_loaded, sl.qty_planned), 0) where id = sl.order_line_id;
  end loop;
  update public.sales_shipments set status = 'cancelled', cancelled_at = now(), cancelled_by = p_user, cancel_reason = btrim(p_reason) where id = s.id;
  perform public._sales_event(s.company_id, null, s.order_id, s.id, 'shipment_cancelled', btrim(p_reason), p_user);
end; $$;

-- ---------------------------------------------------------------------------
-- 8. Dispatch: stock out, truck invoice, advance applied, DN + CI, exactly once
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_sales_shipment(p_shipment uuid, p_user uuid, p_idem text, p_checked boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s public.sales_shipments; o public.sales_orders; sl record; ol public.sales_order_lines; sid uuid; q numeric; n int := 0;
  net numeric(18,2); tax numeric(18,2); disc numeric(18,2); final boolean; goods_net numeric(18,2) := 0; order_goods_net numeric(18,2);
  all_done boolean; share numeric; f record; need numeric(18,2); take numeric(18,2); applied numeric(18,2) := 0; sale public.sales;
  today date;
begin
  select * into s from public.sales_shipments where id = p_shipment for update;
  if not found then raise exception 'Truck not found' using errcode = 'P0001'; end if;
  if s.invoice_sale_id is not null then return s.invoice_sale_id; end if;
  perform public.assert_actor(p_user, s.company_id, 'sales.fulfil', s.branch_id);
  if s.status <> 'loaded' then raise exception 'Record the actual loading before dispatch' using errcode = 'P0001'; end if;
  if not coalesce(p_checked, false) then raise exception 'Confirm the loaded goods, truck and documents were checked' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'dispatch_sales_shipment', p_shipment) then
    return (select invoice_sale_id from public.sales_shipments where id = p_shipment);
  end if;
  select * into o from public.sales_orders where id = s.order_id for update;
  perform public._assert_order_open(o);
  today := (now() at time zone 'Africa/Dar_es_Salaam')::date;

  insert into public.sales(company_id, branch_id, document_status, document_date, customer_id, notes, is_credit, created_by,
      approval_status, submitted_by, submitted_at, approved_by, approved_at, sales_order_id, shipment_id, customer_reference)
    values (s.company_id, s.branch_id, 'draft', today, o.customer_id, 'Order ' || o.document_number || ', truck ' || s.document_number, false, p_user,
      'approved', p_user, now(), o.approved_by, o.approved_at, o.id, s.id, o.document_number)
    returning id into sid;

  -- Goods on this truck: their share of each approved line; the last truck of a line takes the remainder.
  for sl in select x.*, l.line_no from public.sales_shipment_lines x join public.sales_order_lines l on l.id = x.order_line_id
             where x.shipment_id = s.id order by l.line_no loop
    q := coalesce(sl.qty_loaded, sl.qty_planned);
    select * into ol from public.sales_order_lines where id = sl.order_line_id for update;
    if q <= 0 then
      update public.sales_order_lines set qty_allocated = greatest(qty_allocated - sl.qty_planned, 0) where id = ol.id;
      continue;
    end if;
    final := ol.qty_dispatched + q >= ol.quantity - 0.00005;
    if final then
      net := ol.net_amount - ol.invoiced_net; tax := ol.tax_amount - ol.invoiced_tax;
    else
      net := round(ol.net_amount * q / ol.quantity, 2); tax := round(ol.tax_amount * q / ol.quantity, 2);
    end if;
    disc := greatest(round(q * ol.unit_price, 2) - net - case when ol.tax_inclusive then tax else 0 end, 0);
    insert into public.sale_lines(sale_id, product_id, description, quantity, unit_price, original_price, discount, tax_code_id, tax_rate, tax_type,
        tax_name, tax_inclusive, track_inventory, line_no, is_free, promotion_id, fixed_net, fixed_tax)
      values (sid, ol.product_id, ol.description, q, ol.unit_price, ol.original_price, disc, ol.tax_code_id, ol.tax_rate, ol.tax_type,
        ol.tax_name, ol.tax_inclusive, true, ol.line_no, ol.is_free, ol.promotion_id, net, tax);
    update public.sales_order_lines set qty_dispatched = qty_dispatched + q,
      qty_allocated = greatest(qty_allocated - coalesce(sl.qty_loaded, sl.qty_planned), 0),
      invoiced_net = invoiced_net + net, invoiced_tax = invoiced_tax + tax where id = ol.id;
    update public.sales_shipment_lines set qty_dispatched = q where id = sl.id;
    goods_net := goods_net + net; n := n + 1;
  end loop;
  if n = 0 then raise exception 'Nothing is loaded on this truck' using errcode = 'P0001'; end if;

  -- Charges (transport etc.): by this truck's share of the goods value; the last truck takes the remainder.
  select coalesce(sum(net_amount), 0), bool_and(qty_dispatched >= quantity - 0.00005) into order_goods_net, all_done
    from public.sales_order_lines where order_id = o.id and track_inventory;
  for ol in select * from public.sales_order_lines where order_id = o.id and not track_inventory and quantity > 0 order by line_no for update loop
    if all_done then
      net := ol.net_amount - ol.invoiced_net; tax := ol.tax_amount - ol.invoiced_tax; q := ol.quantity - ol.qty_dispatched;
    else
      share := case when order_goods_net > 0 then goods_net / order_goods_net else 0 end;
      net := round(ol.net_amount * share, 2); tax := round(ol.tax_amount * share, 2);
      q := least(round(ol.quantity * share, 4), ol.quantity - ol.qty_dispatched);
    end if;
    continue when net = 0 and tax = 0;
    if q <= 0 then q := 0.0001; end if;
    disc := greatest(round(q * ol.unit_price, 2) - net - case when ol.tax_inclusive then tax else 0 end, 0);
    insert into public.sale_lines(sale_id, product_id, description, quantity, unit_price, original_price, discount, tax_code_id, tax_rate, tax_type,
        tax_name, tax_inclusive, track_inventory, line_no, fixed_net, fixed_tax)
      values (sid, ol.product_id, ol.description, q, ol.unit_price, ol.original_price, disc, ol.tax_code_id, ol.tax_rate, ol.tax_type,
        ol.tax_name, ol.tax_inclusive, false, ol.line_no, net, tax);
    update public.sales_order_lines set qty_dispatched = least(qty_dispatched + q, quantity),
      invoiced_net = invoiced_net + net, invoiced_tax = invoiced_tax + tax where id = ol.id;
  end loop;

  -- Stock out and the invoice journal, through the existing sale engine.
  perform public.post_sale(sid, p_user, p_idem || ':invoice');
  select * into sale from public.sales where id = sid;

  -- Apply the committed advance to this invoice (Dr 2150 / Cr 1140), oldest commitment first.
  need := sale.grand_total;
  for f in select x.* from public.sales_order_funds x join public.customer_receipts r on r.id = x.receipt_id
            where x.order_id = o.id and r.document_status = 'posted' and x.amount_committed - x.amount_applied - x.amount_released > 0
            order by x.created_at, x.id for update of x loop
    exit when need <= 0;
    take := least(f.amount_committed - f.amount_applied - f.amount_released, need);
    insert into public.customer_receipt_allocations(receipt_id, sale_id, amount) values (f.receipt_id, sid, take);
    update public.sales_order_funds set amount_applied = amount_applied + take where id = f.id;
    need := need - take; applied := applied + take;
  end loop;
  if need > 0.004 then
    raise exception 'Committed funds do not cover this truck invoice (short % TZS). The order needs more verified funds.', need using errcode = 'P0001';
  end if;
  if applied > 0 then
    perform public.create_journal(s.company_id, s.branch_id, today, 'advance_application', sid, sale.document_number,
      'Customer advance applied to ' || sale.document_number, p_user,
      jsonb_build_array(
        jsonb_build_object('account_id', public.account_id_by_code(s.company_id, '2150'), 'debit', applied, 'credit', 0, 'memo', 'Customer advance applied'),
        jsonb_build_object('account_id', public.account_id_by_code(s.company_id, '1140'), 'debit', 0, 'credit', applied, 'memo', 'Accounts receivable')));
  end if;
  perform public.recalc_sale(sid);

  update public.sales_shipments set status = case when o.fulfilment_mode = 'delivery' then 'in_transit' else 'dispatched' end,
    dispatch_checked = true, dispatched_at = now(), dispatched_by = p_user, invoice_sale_id = sid,
    delivery_note_number = public.next_document_number(s.company_id, s.branch_id, 'delivery_note')
   where id = s.id;
  update public.sales_orders set status = 'in_fulfilment' where id = o.id and status = 'approved';
  perform public._store_shipment_document(s.id, 'delivery_note', p_user);
  perform public._store_shipment_document(s.id, 'commercial_invoice', p_user);
  perform public._sales_event(s.company_id, null, o.id, s.id, 'dispatched', 'Dispatched; invoice ' || sale.document_number, p_user);
  return sid;
end; $$;

-- ---------------------------------------------------------------------------
-- 9. Collection / delivery evidence, exceptions and order completion
-- ---------------------------------------------------------------------------
create or replace function public._sales_order_check_completion(p_order uuid, p_user uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare o public.sales_orders;
begin
  select * into o from public.sales_orders where id = p_order for update;
  if o.status not in ('approved','in_fulfilment') then return o.status = 'completed'; end if;
  if exists (select 1 from public.sales_order_lines where order_id = o.id and track_inventory and qty_dispatched < quantity - 0.00005) then return false; end if;
  if exists (select 1 from public.sales_shipments where order_id = o.id and status in ('planned','loading_order_issued','loaded','dispatched','in_transit')) then return false; end if;
  if exists (select 1 from public.sales_order_exceptions where order_id = o.id and status = 'open') then return false; end if;
  if not exists (select 1 from public.sales_shipments where order_id = o.id and status in ('delivered','collected')) then return false; end if;
  -- Funds committed but never needed go back to the customer's available credit.
  update public.sales_order_funds set amount_released = amount_committed - amount_applied
   where order_id = o.id and amount_committed - amount_applied - amount_released > 0;
  update public.sales_orders set status = 'completed', completed_at = now() where id = o.id;
  perform public._sales_event(o.company_id, null, o.id, null, 'completed', 'Order completed', p_user);
  return true;
end; $$;

create or replace function public.record_shipment_delivery(p_shipment uuid, p_user uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sales_shipments; o public.sales_orders; sl record; e jsonb; acc numeric; sh numeric; dmg numeric; issues text := '';
begin
  select * into s from public.sales_shipments where id = p_shipment for update;
  if not found then raise exception 'Truck not found' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, s.company_id, 'sales.fulfil', s.branch_id);
  if s.status in ('delivered','collected') then return; end if;
  if s.status not in ('dispatched','in_transit') then raise exception 'Only dispatched trucks can be marked collected or delivered' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_data->>'recipient_name'), '') = '' then raise exception 'Enter who received the goods' using errcode = '23514'; end if;
  select * into o from public.sales_orders where id = s.order_id for update;
  for sl in select x.*, l.description, p.sku from public.sales_shipment_lines x join public.sales_order_lines l on l.id = x.order_line_id
             join public.products p on p.id = l.product_id where x.shipment_id = s.id and x.qty_dispatched > 0 loop
    e := null;
    select j into e from jsonb_array_elements(coalesce(p_data->'lines', '[]'::jsonb)) j where j->>'shipment_line_id' = sl.id::text;
    sh := coalesce((e->>'qty_short')::numeric, 0); dmg := coalesce((e->>'qty_damaged')::numeric, 0);
    acc := coalesce((e->>'qty_accepted')::numeric, sl.qty_dispatched - sh - dmg);
    if acc < 0 or sh < 0 or dmg < 0 or abs(acc + sh + dmg - sl.qty_dispatched) > 0.00005 then
      raise exception '%: accepted + short + damaged must equal the dispatched %', sl.sku, sl.qty_dispatched using errcode = 'P0001';
    end if;
    update public.sales_shipment_lines set qty_accepted = acc, qty_short = sh, qty_damaged = dmg where id = sl.id;
    update public.sales_order_lines set qty_delivered = qty_delivered + acc where id = sl.order_line_id;
    if sh > 0 then
      insert into public.sales_order_exceptions(order_id, shipment_id, kind, description, raised_by)
        values (o.id, s.id, 'delivery_shortage', sl.sku || ': ' || sh || ' short on ' || s.document_number, p_user);
      issues := issues || ' ' || sl.sku || ' short ' || sh;
    end if;
    if dmg > 0 then
      insert into public.sales_order_exceptions(order_id, shipment_id, kind, description, raised_by)
        values (o.id, s.id, 'delivery_damage', sl.sku || ': ' || dmg || ' damaged on ' || s.document_number, p_user);
      issues := issues || ' ' || sl.sku || ' damaged ' || dmg;
    end if;
  end loop;
  update public.sales_shipments set status = case when o.fulfilment_mode = 'delivery' then 'delivered' else 'collected' end,
    delivered_at = coalesce(nullif(p_data->>'delivered_at', '')::timestamptz, now()), delivery_recorded_by = p_user,
    recipient_name = btrim(p_data->>'recipient_name'), recipient_phone = nullif(btrim(coalesce(p_data->>'recipient_phone', '')), ''),
    delivery_notes = nullif(btrim(coalesce(p_data->>'notes', '')), '') where id = s.id;
  perform public._sales_event(s.company_id, null, o.id, s.id, case when o.fulfilment_mode = 'delivery' then 'delivered' else 'collected' end,
    'Received by ' || btrim(p_data->>'recipient_name') || case when issues <> '' then '; exceptions:' || issues else '' end, p_user);
  perform public._sales_order_check_completion(o.id, p_user);
end; $$;

create or replace function public.resolve_sales_exception(p_exception uuid, p_user uuid, p_resolution text)
returns void language plpgsql security definer set search_path = public as $$
declare x public.sales_order_exceptions; o public.sales_orders;
begin
  select * into x from public.sales_order_exceptions where id = p_exception for update;
  if not found then raise exception 'Exception not found' using errcode = 'P0001'; end if;
  select * into o from public.sales_orders where id = x.order_id for update;
  perform public.assert_actor(p_user, o.company_id, 'sales.approve', o.branch_id);
  if x.status = 'resolved' then return; end if;
  if coalesce(btrim(p_resolution), '') = '' then raise exception 'Describe how the exception was resolved' using errcode = '23514'; end if;
  if x.kind = 'payment_reversed' and o.status in ('approved','in_fulfilment') and public._order_uncovered(o.id) > 0.004 then
    raise exception 'The order is short of verified funds by % TZS; commit replacement funds or reduce the order first', public._order_uncovered(o.id) using errcode = 'P0001';
  end if;
  update public.sales_order_exceptions set status = 'resolved', resolved_by = p_user, resolved_at = now(), resolution = btrim(p_resolution) where id = x.id;
  if not exists (select 1 from public.sales_order_exceptions where order_id = o.id and status = 'open' and kind = 'payment_reversed') then
    update public.sales_orders set on_hold = false, hold_reason = null where id = o.id;
  end if;
  perform public._sales_event(o.company_id, null, o.id, x.shipment_id, 'exception_resolved', btrim(p_resolution), p_user);
  perform public._sales_order_check_completion(o.id, p_user);
end; $$;

-- ---------------------------------------------------------------------------
-- 10. Customer funds: record, commit, refund, reverse
-- ---------------------------------------------------------------------------
create or replace function public.record_customer_advance(p_company uuid, p_branch uuid, p_user uuid, p_customer uuid, p_account uuid,
  p_method text, p_date date, p_amount numeric, p_reference text, p_basis text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_actor(p_user, p_company, 'sales.approve', p_branch);
  if coalesce(btrim(p_reference), '') = '' then raise exception 'The payment reference is required' using errcode = '23514'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the amount received' using errcode = '23514'; end if;
  return public._post_advance_receipt(p_company, p_branch, p_customer, p_account, p_method, p_date, p_amount, p_reference, p_user, p_basis, 'Customer advance');
end; $$;

create or replace function public.commit_order_funds(p_order uuid, p_user uuid, p_funds jsonb)
returns numeric language plpgsql security definer set search_path = public as $$
declare o public.sales_orders; need numeric(18,2);
begin
  select * into o from public.sales_orders where id = p_order for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, o.company_id, 'sales.approve', o.branch_id);
  if o.status not in ('approved','in_fulfilment') then raise exception 'Order % is %', o.document_number, o.status using errcode = 'P0001'; end if;
  need := public._order_uncovered(o.id);
  if need <= 0 then raise exception 'The order is already fully covered' using errcode = 'P0001'; end if;
  need := public._commit_order_funds(o.id, p_funds, need);
  perform public._sales_event(o.company_id, null, o.id, null, 'funds_committed', 'Replacement funds committed', p_user);
  return greatest(need, 0);
end; $$;

create or replace function public.refund_customer_advance(p_receipt uuid, p_user uuid, p_account uuid, p_amount numeric, p_reference text, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.customer_receipts; avail numeric(18,2); rid uuid; docnum text; today date := (now() at time zone 'Africa/Dar_es_Salaam')::date;
begin
  select * into r from public.customer_receipts where id = p_receipt for update;
  if not found or r.receipt_kind <> 'advance' or r.document_status <> 'posted' then raise exception 'Only a posted customer advance can be refunded' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, r.company_id, 'sales.approve', r.branch_id);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  avail := public.customer_receipt_available(r.id);
  if coalesce(p_amount, 0) <= 0 or p_amount > avail + 0.004 then
    raise exception 'Only % TZS of this receipt is unused and can be refunded', avail using errcode = 'P0001';
  end if;
  perform public.assert_period_open(r.company_id, today);
  docnum := public.next_document_number(r.company_id, r.branch_id, 'advance_refund');
  insert into public.customer_advance_refunds(company_id, branch_id, document_number, receipt_id, payment_account_id, amount, reference, reason, refunded_by)
    values (r.company_id, r.branch_id, docnum, r.id, p_account, p_amount, nullif(btrim(coalesce(p_reference, '')), ''), btrim(p_reason), p_user)
    returning id into rid;
  perform public.create_journal(r.company_id, r.branch_id, today, 'advance_refund', rid, docnum, 'Refund of customer advance ' || r.document_number, p_user,
    jsonb_build_array(
      jsonb_build_object('account_id', public.account_id_by_code(r.company_id, '2150'), 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', public.resolve_payment_ledger(r.company_id, p_account), 'debit', 0, 'credit', p_amount)));
  return rid;
end; $$;

-- A verified payment found to be invalid (bounced, reversed by the bank...).
-- Unfulfilled trucks are blocked (order on hold), dispatched trucks are flagged,
-- invoices it paid become outstanding again.
create or replace function public.reverse_customer_advance(p_receipt uuid, p_user uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.customer_receipts; applied numeric(18,2); unapplied numeric(18,2); f record; sa record; jl jsonb := '[]'::jsonb;
  today date := (now() at time zone 'Africa/Dar_es_Salaam')::date;
begin
  select * into r from public.customer_receipts where id = p_receipt for update;
  if not found or r.receipt_kind <> 'advance' then raise exception 'Only a customer advance can be reversed here' using errcode = 'P0001'; end if;
  if r.document_status = 'voided' then return; end if;
  perform public.assert_actor(p_user, r.company_id, 'sales.approve', r.branch_id);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  if exists (select 1 from public.customer_advance_refunds where receipt_id = r.id) then
    raise exception 'Part of this receipt was refunded; it cannot be reversed' using errcode = 'P0001';
  end if;
  perform public.assert_period_open(r.company_id, today);
  select coalesce(sum(amount), 0) into applied from public.customer_receipt_allocations where receipt_id = r.id;
  unapplied := r.amount - applied;
  if unapplied > 0 then jl := jl || jsonb_build_object('account_id', public.account_id_by_code(r.company_id, '2150'), 'debit', unapplied, 'credit', 0, 'memo', 'Customer advance reversed'); end if;
  if applied > 0 then jl := jl || jsonb_build_object('account_id', public.account_id_by_code(r.company_id, '1140'), 'debit', applied, 'credit', 0, 'memo', 'Invoices unpaid again'); end if;
  jl := jl || jsonb_build_object('account_id', public.resolve_payment_ledger(r.company_id, r.payment_account_id), 'debit', 0, 'credit', r.amount, 'memo', 'Payment reversed');
  perform public.create_journal(r.company_id, r.branch_id, today, 'customer_receipt_reversal', r.id, r.document_number,
    'Reversal of customer advance ' || r.document_number || ': ' || btrim(p_reason), p_user, jl);
  update public.customer_receipts set document_status = 'voided', voided_by = p_user, voided_at = now(), void_reason = btrim(p_reason) where id = r.id;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by, reason)
    values (r.company_id, 'customer_receipt', r.id, 'posted', 'voided', p_user, btrim(p_reason));
  for sa in select distinct sale_id from public.customer_receipt_allocations where receipt_id = r.id loop
    perform public.recalc_sale(sa.sale_id);
    update public.sales_shipments set payment_flag = true where invoice_sale_id = sa.sale_id;
  end loop;
  for f in select x.*, o.status as order_status from public.sales_order_funds x join public.sales_orders o on o.id = x.order_id where x.receipt_id = r.id for update of x loop
    update public.sales_order_funds set amount_released = amount_committed - amount_applied where id = f.id;
    if f.order_status in ('approved','in_fulfilment','completed') then
      update public.sales_orders set on_hold = case when status in ('approved','in_fulfilment') then true else on_hold end,
        hold_reason = case when status in ('approved','in_fulfilment') then 'Payment ' || coalesce(r.reference, r.document_number) || ' reversed' else hold_reason end
       where id = f.order_id;
      insert into public.sales_order_exceptions(order_id, kind, description, raised_by)
        values (f.order_id, 'payment_reversed', 'Receipt ' || r.document_number || ' (' || coalesce(r.reference, '') || ') reversed: ' || btrim(p_reason)
          || case when f.amount_applied > 0 then '. ' || f.amount_applied || ' TZS of dispatched invoices is unpaid again.' else '' end, p_user);
      perform public._sales_event(r.company_id, null, f.order_id, null, 'payment_reversed', 'Receipt ' || r.document_number || ' reversed', p_user);
    end if;
  end loop;
end; $$;

-- ---------------------------------------------------------------------------
-- 11. Amendments after approval: requested by the officer, approved by a manager
-- ---------------------------------------------------------------------------
create or replace function public.request_sales_amendment(p_order uuid, p_user uuid, p_kind text, p_changes jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare o public.sales_orders; aid uuid;
begin
  select * into o from public.sales_orders where id = p_order for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, o.company_id, 'sales.fulfil', o.branch_id);
  if o.status not in ('approved','in_fulfilment') then raise exception 'Order % is %', o.document_number, o.status using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  if exists (select 1 from public.sales_order_amendments where order_id = o.id and status = 'pending') then
    raise exception 'This order already has an amendment waiting for approval' using errcode = 'P0001';
  end if;
  insert into public.sales_order_amendments(order_id, kind, changes, reason, requested_by)
    values (o.id, p_kind, coalesce(p_changes, '{}'::jsonb), btrim(p_reason), p_user) returning id into aid;
  perform public._sales_event(o.company_id, null, o.id, null, 'amendment_requested', p_kind || ': ' || btrim(p_reason), p_user);
  return aid;
end; $$;

create or replace function public._recalc_sales_order(p_order uuid)
returns void language sql security definer set search_path = public as $$
  update public.sales_orders o set
    subtotal = x.sub, discount_total = x.disc, net_total = x.net, tax_total = x.tax, grand_total = x.grand
  from (select coalesce(sum(round(quantity * unit_price, 2)), 0) sub, coalesce(sum(discount), 0) disc, coalesce(sum(net_amount), 0) net,
               coalesce(sum(tax_amount), 0) tax, coalesce(sum(line_total), 0) grand
          from public.sales_order_lines where order_id = p_order) x
  where o.id = p_order;
$$;

create or replace function public.approve_sales_amendment(p_amendment uuid, p_user uuid, p_funds jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  am public.sales_order_amendments; o public.sales_orders; old_total numeric(18,2); new_total numeric(18,2); e jsonb; ol public.sales_order_lines;
  nq numeric; np numeric; ndisc numeric(18,2); rem numeric; a record; per_unit numeric; pr record; onhand numeric; reserved numeric;
  need numeric(18,2); excess numeric(18,2); f record; take numeric(18,2); nxt int; sku text;
begin
  select * into am from public.sales_order_amendments where id = p_amendment for update;
  if not found then raise exception 'Amendment not found' using errcode = 'P0001'; end if;
  select * into o from public.sales_orders where id = am.order_id for update;
  perform public.assert_actor(p_user, o.company_id, 'sales.approve', o.branch_id);
  if am.status <> 'pending' then raise exception 'This amendment was already decided' using errcode = 'P0001'; end if;
  if p_user = am.requested_by then raise exception 'Another authorised manager must approve an amendment you requested' using errcode = '42501'; end if;
  if o.status not in ('approved','in_fulfilment') then raise exception 'Order % is %', o.document_number, o.status using errcode = 'P0001'; end if;
  old_total := o.grand_total;

  if am.kind = 'delivery' then
    update public.sales_orders set
      destination = coalesce(nullif(am.changes->>'destination', ''), destination),
      consignee_name = coalesce(nullif(am.changes->>'consignee_name', ''), consignee_name),
      consignee_phone = coalesce(nullif(am.changes->>'consignee_phone', ''), consignee_phone),
      fulfilment_mode = coalesce(nullif(am.changes->>'fulfilment_mode', ''), fulfilment_mode)
     where id = o.id;
    update public.sales_shipments set
      destination = coalesce(nullif(am.changes->>'destination', ''), destination),
      consignee_name = coalesce(nullif(am.changes->>'consignee_name', ''), consignee_name),
      consignee_phone = coalesce(nullif(am.changes->>'consignee_phone', ''), consignee_phone)
     where order_id = o.id and status in ('planned','loading_order_issued','loaded');

  elsif am.kind = 'cancel_remaining' then
    if exists (select 1 from public.sales_shipments where order_id = o.id and status in ('planned','loading_order_issued','loaded')) then
      raise exception 'Cancel the trucks that are not yet dispatched first' using errcode = 'P0001';
    end if;
    update public.sales_order_lines set quantity = qty_dispatched, net_amount = invoiced_net, tax_amount = invoiced_tax,
      line_total = invoiced_net + invoiced_tax,
      discount = case when quantity > 0 then round(discount * qty_dispatched / quantity, 2) else 0 end
     where order_id = o.id;

  elsif am.kind = 'change_lines' then
    for e in select * from jsonb_array_elements(coalesce(am.changes->'lines', '[]'::jsonb)) loop
      select * into ol from public.sales_order_lines where id = (e->>'order_line_id')::uuid and order_id = o.id for update;
      if not found then raise exception 'A changed line is not on this order' using errcode = 'P0001'; end if;
      nq := coalesce((e->>'quantity')::numeric, ol.quantity); np := coalesce((e->>'unit_price')::numeric, ol.unit_price);
      if nq < ol.qty_dispatched + ol.qty_allocated - 0.00005 then
        raise exception '%: the quantity cannot go below what is dispatched or on trucks (%)', coalesce(ol.description, 'Product'), ol.qty_dispatched + ol.qty_allocated using errcode = 'P0001';
      end if;
      per_unit := case when ol.quantity > 0 then ol.discount / ol.quantity else 0 end;
      rem := nq - ol.qty_dispatched;
      ndisc := round(per_unit * rem, 2);
      a := public._sale_line_amounts(rem, np, least(ndisc, round(rem * np, 2)), ol.tax_rate, ol.tax_inclusive);
      update public.sales_order_lines set quantity = nq, unit_price = np, discount = round(per_unit * nq, 2),
        net_amount = invoiced_net + a.net, tax_amount = invoiced_tax + a.tax, line_total = invoiced_net + invoiced_tax + a.total
       where id = ol.id;
    end loop;
    select coalesce(max(line_no), 0) into nxt from public.sales_order_lines where order_id = o.id;
    for e in select * from jsonb_array_elements(coalesce(am.changes->'add', '[]'::jsonb)) loop
      nxt := nxt + 1;
      a := public._sale_line_amounts((e->>'quantity')::numeric, (e->>'unit_price')::numeric, coalesce((e->>'discount')::numeric, 0),
             coalesce((e->>'tax_rate')::numeric, 0), coalesce((e->>'tax_inclusive')::boolean, false));
      insert into public.sales_order_lines(order_id, line_no, product_id, description, quantity, unit_price, original_price, discount,
          tax_code_id, tax_rate, tax_type, tax_name, tax_inclusive, track_inventory, net_amount, tax_amount, line_total)
        values (o.id, nxt, (e->>'product_id')::uuid, nullif(e->>'description', ''), (e->>'quantity')::numeric, (e->>'unit_price')::numeric,
          coalesce((e->>'original_price')::numeric, (e->>'unit_price')::numeric), coalesce((e->>'discount')::numeric, 0),
          nullif(e->>'tax_code_id', '')::uuid, coalesce((e->>'tax_rate')::numeric, 0), nullif(e->>'tax_type', ''), nullif(e->>'tax_name', ''),
          coalesce((e->>'tax_inclusive')::boolean, false), coalesce((e->>'track_inventory')::boolean, true), a.net, a.tax, a.total);
    end loop;
    -- Increased quantities must still be in stock after other orders' reservations.
    for pr in select l.product_id, sum(l.quantity - l.qty_dispatched) q from public.sales_order_lines l
               where l.order_id = o.id and l.track_inventory group by l.product_id loop
      onhand := null;
      select quantity into onhand from public.stock_balances where company_id = o.company_id and branch_id = o.branch_id and product_id = pr.product_id for update;
      reserved := public.sales_reserved_qty(o.company_id, o.branch_id, pr.product_id, o.id);
      if coalesce(onhand, 0) - reserved < pr.q - 0.00005 then
        select p.sku into sku from public.products p where p.id = pr.product_id;
        raise exception 'Not enough stock for %: available %, the amended order still needs %', sku, coalesce(onhand, 0) - reserved, pr.q using errcode = 'P0001';
      end if;
    end loop;
  else
    raise exception 'Unknown amendment' using errcode = 'P0001';
  end if;

  perform public._recalc_sales_order(o.id);
  select grand_total into new_total from public.sales_orders where id = o.id;
  need := public._order_uncovered(o.id);
  if need > 0.004 then
    -- An increase needs additional verified funds before it takes effect.
    need := public._commit_order_funds(o.id, p_funds, need);
    if need > 0.004 then raise exception 'The amendment needs % TZS more verified funds', need using errcode = 'P0001'; end if;
  elsif need < -0.004 then
    -- A reduction releases committed funds back to the customer's credit, newest first.
    excess := -need;
    for f in select * from public.sales_order_funds where order_id = o.id and amount_committed - amount_applied - amount_released > 0
              order by created_at desc, id desc for update loop
      exit when excess <= 0;
      take := least(f.amount_committed - f.amount_applied - f.amount_released, excess);
      update public.sales_order_funds set amount_released = amount_released + take where id = f.id;
      excess := excess - take;
    end loop;
  end if;

  update public.sales_order_amendments set status = 'approved', decided_by = p_user, decided_at = now(), value_change = new_total - old_total where id = am.id;
  perform public._sales_event(o.company_id, null, o.id, null, 'amendment_approved',
    am.kind || case when new_total <> old_total then ', order value ' || old_total || ' -> ' || new_total else '' end, p_user);
  if am.kind = 'cancel_remaining' then
    if not exists (select 1 from public.sales_order_lines where order_id = o.id and qty_dispatched > 0) then
      update public.sales_order_funds set amount_released = amount_committed - amount_applied where order_id = o.id;
      update public.sales_orders set status = 'cancelled', cancelled_at = now(), cancelled_by = p_user, cancel_reason = am.reason where id = o.id;
      perform public._sales_event(o.company_id, null, o.id, null, 'cancelled', am.reason, p_user);
    else
      perform public._sales_order_check_completion(o.id, p_user);
    end if;
  end if;
end; $$;

create or replace function public.reject_sales_amendment(p_amendment uuid, p_user uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare am public.sales_order_amendments; o public.sales_orders;
begin
  select * into am from public.sales_order_amendments where id = p_amendment for update;
  if not found then raise exception 'Amendment not found' using errcode = 'P0001'; end if;
  select * into o from public.sales_orders where id = am.order_id;
  perform public.assert_actor(p_user, o.company_id, 'sales.approve', o.branch_id);
  if am.status <> 'pending' then raise exception 'This amendment was already decided' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  update public.sales_order_amendments set status = 'rejected', decided_by = p_user, decided_at = now(), decision_reason = btrim(p_reason) where id = am.id;
  perform public._sales_event(o.company_id, null, o.id, null, 'amendment_rejected', btrim(p_reason), p_user);
end; $$;

-- ---------------------------------------------------------------------------
-- 12. Grants: every workflow function runs through the server (service role).
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public._sale_line_amounts(numeric,numeric,numeric,numeric,boolean)',
    'public.sales_reserved_qty(uuid,uuid,uuid,uuid)',
    'public.customer_receipt_available(uuid)',
    'public._sales_event(uuid,uuid,uuid,uuid,text,text,uuid)',
    'public._post_advance_receipt(uuid,uuid,uuid,uuid,text,date,numeric,text,uuid,text,text)',
    'public.post_sale(uuid,uuid,text)',
    'public.submit_sales_request(uuid,uuid)',
    'public.decide_sales_request(uuid,uuid,text,text)',
    'public._commit_order_funds(uuid,jsonb,numeric)',
    'public._order_uncovered(uuid)',
    'public.approve_sales_request(uuid,uuid,text,jsonb,text)',
    'public._assert_order_open(public.sales_orders)',
    'public.create_sales_shipment(uuid,uuid,text,jsonb,jsonb)',
    'public.sales_shipment_snapshot(uuid,text)',
    'public._store_shipment_document(uuid,text,uuid)',
    'public.issue_loading_order(uuid,uuid)',
    'public.record_shipment_loading(uuid,uuid,jsonb)',
    'public.cancel_sales_shipment(uuid,uuid,text)',
    'public.dispatch_sales_shipment(uuid,uuid,text,boolean)',
    'public._sales_order_check_completion(uuid,uuid)',
    'public.record_shipment_delivery(uuid,uuid,jsonb)',
    'public.resolve_sales_exception(uuid,uuid,text)',
    'public.record_customer_advance(uuid,uuid,uuid,uuid,uuid,text,date,numeric,text,text)',
    'public.commit_order_funds(uuid,uuid,jsonb)',
    'public.refund_customer_advance(uuid,uuid,uuid,numeric,text,text)',
    'public.reverse_customer_advance(uuid,uuid,text)',
    'public.request_sales_amendment(uuid,uuid,text,jsonb,text)',
    'public._recalc_sales_order(uuid)',
    'public.approve_sales_amendment(uuid,uuid,jsonb)',
    'public.reject_sales_amendment(uuid,uuid,text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
