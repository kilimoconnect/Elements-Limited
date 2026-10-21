-- ============================================================================
-- Letiq ERP - Migration 0027: Import upgrade Stage 4 - import shipments and
-- landed cost.
-- ----------------------------------------------------------------------------
-- Builds on 0025 (shipments, cost sources, cost invoices, receipts schema) and
-- 0026 (foreign purchase invoices and payables):
--   * shipment details (origin, places, dates, ownership event), line
--     quantities ordered / shipped / received / in transit, batches;
--   * ownership recognition: Dr 1157 Import goods in transit / Cr 2130 GR/IR
--     (goods invoices Dr 2130 / Cr 2110, in either order);
--   * explicit approved cost accruals (Dr 1157 or expense / Cr 2140), actual
--     cost invoices that reverse the accrual and change cost only by the
--     difference, credit notes as linked negative adjustments;
--   * goods receipts into BULK stock at the exact in-transit value share,
--     weighbridge / batch / discrepancy resolution, retry-safe;
--   * late cost deltas propagated to stock still held, cost of sales,
--     losses and branch transfers by replaying the immutable stock movements
--     (weighted-average pro-rata), never by switching to lot valuation;
--   * per-shipment control ledger, landed-cost sheet (estimate vs actual vs
--     commercial), finalisation checks.
-- All functions require the "imports" feature flag and import permissions.
-- ============================================================================

-- ===========================================================================
-- 1. Schema
-- ===========================================================================
alter table public.import_shipments add column if not exists origin_country text;
alter table public.import_shipments add column if not exists origin_port text;
alter table public.import_shipments add column if not exists discharge_port text;
alter table public.import_shipments add column if not exists named_place text;
alter table public.import_shipments add column if not exists shipped_date date;
alter table public.import_shipments add column if not exists arrival_date date;
alter table public.import_shipments add column if not exists ownership_event text not null default 'bill_of_lading';
alter table public.import_shipments add column if not exists ownership_recognised_date date;
alter table public.import_shipments add column if not exists planning_rate numeric(18,6);
alter table public.import_shipments add column if not exists finalized_at timestamptz;
alter table public.import_shipments add column if not exists finalized_by uuid references auth.users(id) on delete set null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'import_shipments_ownership_event_check') then
    alter table public.import_shipments add constraint import_shipments_ownership_event_check
      check (ownership_event in ('bill_of_lading','arrival','receipt'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'import_shipments_planning_rate_check') then
    alter table public.import_shipments add constraint import_shipments_planning_rate_check
      check (planning_rate is null or planning_rate > 0);
  end if;
end $$;

alter table public.import_shipment_lines add column if not exists shipped_kg numeric(18,4);
alter table public.import_shipment_lines add column if not exists batch_reference text;
alter table public.import_shipment_lines add column if not exists goods_accrual_rate numeric(18,6);
alter table public.import_shipment_lines add column if not exists goods_recognised_tzs numeric(18,2) not null default 0;
alter table public.import_shipment_lines add column if not exists goods_invoiced_tzs numeric(18,2) not null default 0;
alter table public.import_shipment_lines add column if not exists goods_invoiced_fc numeric(18,2) not null default 0;
alter table public.import_shipment_lines add column if not exists goods_invoiced_qty numeric(18,4) not null default 0;
alter table public.import_shipment_lines add column if not exists costs_applied_tzs numeric(18,2) not null default 0;
alter table public.import_shipment_lines add column if not exists git_value numeric(18,2) not null default 0;
alter table public.import_shipment_lines add column if not exists received_kg numeric(18,4) not null default 0;
alter table public.import_shipment_lines add column if not exists received_qty numeric(18,4) not null default 0;
alter table public.import_shipment_lines add column if not exists short_normal_kg numeric(18,4) not null default 0;
alter table public.import_shipment_lines add column if not exists short_writeoff_kg numeric(18,4) not null default 0;
alter table public.import_shipment_lines add column if not exists short_claim_kg numeric(18,4) not null default 0;
alter table public.import_shipment_lines add column if not exists line_closed boolean not null default false;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'import_shipment_lines_stage4_checks') then
    alter table public.import_shipment_lines add constraint import_shipment_lines_stage4_checks check (
      (shipped_kg is null or shipped_kg > 0) and received_kg >= 0 and received_qty >= 0
      and short_normal_kg >= 0 and short_writeoff_kg >= 0 and short_claim_kg >= 0 and git_value >= 0
      and goods_invoiced_qty >= 0);
  end if;
end $$;

-- Imported goods are bulk (kg), standard items or packaging materials -
-- never packaged bags; bulk lines count quantity in kg.
create or replace function public.import_shipment_lines_validate()
returns trigger language plpgsql security definer set search_path = public as $$
declare p public.products; sh public.import_shipments;
begin
  select * into p from public.products where id = NEW.product_id;
  if p.stock_role = 'packaged' then
    raise exception 'Imports receive bulk stock; packaged bags are produced by rebagging' using errcode = '23514';
  end if;
  if p.stock_role = 'bulk' and NEW.quantity <> NEW.net_kg then
    raise exception 'For a bulk product the quantity is the net kg' using errcode = '23514';
  end if;
  if not p.track_inventory then
    raise exception 'Imported products must track inventory' using errcode = '23514';
  end if;
  select * into sh from public.import_shipments where id = NEW.shipment_id;
  if TG_OP = 'UPDATE' and (NEW.product_id, NEW.quantity, NEW.net_kg, NEW.shipped_kg, NEW.fc_amount)
       is distinct from (OLD.product_id, OLD.quantity, OLD.net_kg, OLD.shipped_kg, OLD.fc_amount)
     and (OLD.goods_recognised_tzs <> 0 or OLD.goods_invoiced_tzs <> 0 or OLD.received_kg <> 0 or OLD.costs_applied_tzs <> 0) then
    raise exception 'A shipment line with postings cannot change product, quantities or value' using errcode = 'P0001';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_import_shipment_lines_validate on public.import_shipment_lines;
create trigger trg_import_shipment_lines_validate before insert or update on public.import_shipment_lines
  for each row execute function public.import_shipment_lines_validate();

alter table public.import_receipts add column if not exists goods_accrual_rate numeric(18,6);
alter table public.import_receipts add column if not exists client_request_id text;
create unique index if not exists import_receipts_client_request on public.import_receipts(company_id, client_request_id)
  where client_request_id is not null;
alter table public.cost_invoices add column if not exists client_request_id text;
create unique index if not exists cost_invoices_client_request on public.cost_invoices(company_id, client_request_id)
  where client_request_id is not null;
alter table public.import_receipt_lines add column if not exists weighbridge_ref text;
alter table public.import_receipt_lines add column if not exists batch_code text;
alter table public.import_receipt_lines add column if not exists is_final boolean not null default false;
alter table public.import_receipt_lines add column if not exists value_tzs numeric(18,2) not null default 0;
alter table public.import_receipt_lines add column if not exists short_value_tzs numeric(18,2) not null default 0;
alter table public.import_receipt_lines add column if not exists cost_delta_tzs numeric(18,2) not null default 0;
alter table public.import_receipt_lines add column if not exists movement_id uuid references public.stock_movements(id) on delete restrict;
alter table public.import_receipt_lines add column if not exists lot_id uuid references public.stock_lots(id) on delete restrict;

alter table public.cost_sources add column if not exists allocation_targets jsonb;
alter table public.cost_sources add column if not exists capitalised_applied numeric(18,2) not null default 0;
alter table public.cost_sources add column if not exists accrual_date date;

-- Stock movement types for imports and cost adjustments.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.stock_movements'::regclass and contype = 'c'
             and conname <> 'stock_movements_type_v2' and pg_get_constraintdef(oid) ilike '%movement_type%' loop
    execute format('alter table public.stock_movements drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_type_v2') then
    alter table public.stock_movements add constraint stock_movements_type_v2 check (movement_type in (
      'opening','sale','sale_void','sales_return','sales_return_void',
      'adjustment_increase','adjustment_decrease','adjustment_void',
      'transfer_out','transfer_in','transfer_void',
      'purchase','purchase_return','import_receipt','import_receipt_void','cost_adjustment'));
  end if;
end $$;

-- Movements are ordered by the moment they are written (not the transaction
-- start), so replaying the movement history follows the real order even when
-- postings overlap.
alter table public.stock_movements alter column created_at set default clock_timestamp();

-- Per-shipment control ledger: every amount posted to 1157 (git), 2130
-- (grir), 2140 (accrual) or stock for a shipment, signed debit-positive.
create table if not exists public.import_shipment_ledger (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete restrict,
  shipment_id  uuid not null references public.import_shipments(id) on delete restrict,
  line_id      uuid references public.import_shipment_lines(id) on delete restrict,
  cost_source_id uuid references public.cost_sources(id) on delete restrict,
  account_key  text not null check (account_key in ('git','grir','accrual','inventory','cogs','loss','claims','expense','transfer')),
  amount       numeric(18,2) not null,
  source_type  text not null,
  source_id    uuid not null,
  entry_date   date not null,
  created_at   timestamptz not null default clock_timestamp()
);
create index if not exists isl_shipment_idx on public.import_shipment_ledger(shipment_id, account_key);
drop trigger if exists trg_isl_company on public.import_shipment_ledger;
create trigger trg_isl_company before insert on public.import_shipment_ledger
  for each row execute function public.check_company_consistency('shipment_id','import_shipments','line_id','import_shipment_lines','cost_source_id','cost_sources');
drop trigger if exists trg_isl_immutable on public.import_shipment_ledger;
create trigger trg_isl_immutable before update or delete on public.import_shipment_ledger
  for each row execute function public.block_update_delete();

-- Import goods invoices cannot be voided or returned through the purchase
-- paths (they carry no stock and drive the shipment ledger).
create or replace function public.purchases_block_import_reversal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_TABLE_NAME = 'purchases' then
    if NEW.posting_mode = 'invoice_only' and OLD.document_status = 'posted' and NEW.document_status = 'voided' then
      raise exception 'Import goods invoices are corrected with linked adjustments, not voided' using errcode = 'P0001';
    end if;
    return NEW;
  end if;
  if exists (select 1 from public.purchases where id = NEW.purchase_id and posting_mode = 'invoice_only') then
    raise exception 'Import goods invoices have no stock to return through purchase returns' using errcode = 'P0001';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_purchases_block_import_void on public.purchases;
create trigger trg_purchases_block_import_void before update of document_status on public.purchases
  for each row execute function public.purchases_block_import_reversal();
drop trigger if exists trg_purchase_returns_block_import on public.purchase_returns;
create trigger trg_purchase_returns_block_import before insert on public.purchase_returns
  for each row execute function public.purchases_block_import_reversal();

-- ===========================================================================
-- 2. Helpers
-- ===========================================================================
-- Signed journal line: positive = debit, negative = credit.
create or replace function public._jl(p_account uuid, p_amount numeric, p_memo text)
returns jsonb language sql immutable as $$
  select case when p_amount = 0 then '[]'::jsonb
              when p_amount > 0 then jsonb_build_array(jsonb_build_object('account_id', p_account, 'debit', p_amount, 'credit', 0, 'memo', p_memo))
              else jsonb_build_array(jsonb_build_object('account_id', p_account, 'debit', 0, 'credit', -p_amount, 'memo', p_memo)) end;
$$;

create or replace function public._ship_ledger(
  p_shipment uuid, p_line uuid, p_source uuid, p_key text, p_amount numeric, p_src_type text, p_src_id uuid, p_date date
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_amount = 0 then return; end if;
  insert into public.import_shipment_ledger(company_id, shipment_id, line_id, cost_source_id, account_key, amount, source_type, source_id, entry_date)
    select company_id, p_shipment, p_line, p_source, p_key, p_amount, p_src_type, p_src_id, p_date
    from public.import_shipments where id = p_shipment;
end; $$;

create or replace function public._line_expected_kg(l public.import_shipment_lines)
returns numeric language sql immutable as $$
  select coalesce(l.shipped_kg, l.net_kg);
$$;

create or replace function public._line_transit_kg(l public.import_shipment_lines)
returns numeric language sql immutable as $$
  select case when l.line_closed then 0
              else greatest(coalesce(l.shipped_kg, l.net_kg) - l.received_kg - l.short_normal_kg - l.short_writeoff_kg - l.short_claim_kg, 0) end;
$$;

-- Stock receipt at an exact value, returning the movement id.
create or replace function public._stock_in_value(
  p_company uuid, p_branch uuid, p_product uuid, p_type text, p_source_type text, p_source_id uuid,
  p_source_number text, p_qty numeric, p_value numeric, p_user uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare bal public.stock_balances; v numeric(18,2) := round(p_value, 2); nq numeric(18,4); nv numeric(18,2); mid uuid;
begin
  if p_qty is null or p_qty <= 0 or v < 0 then raise exception 'Invalid stock receipt' using errcode = 'P0001'; end if;
  select * into bal from public.stock_balances where company_id=p_company and branch_id=p_branch and product_id=p_product for update;
  if not found then
    insert into public.stock_balances(company_id, branch_id, product_id) values (p_company, p_branch, p_product) returning * into bal;
  end if;
  nq := bal.quantity + p_qty; nv := bal.stock_value + v;
  insert into public.stock_movements(company_id, branch_id, product_id, movement_type, source_type, source_id, source_number,
      qty_in, qty_out, unit_cost, movement_value, balance_qty, avg_cost_after, balance_value, created_by, created_at)
    values (p_company, p_branch, p_product, p_type, p_source_type, p_source_id, p_source_number,
      p_qty, 0, round(v / p_qty, 4), v, nq, round(nv / nq, 4), nv, p_user, clock_timestamp())
    returning id into mid;
  update public.stock_balances set quantity=nq, avg_unit_cost=round(nv/nq,4), stock_value=nv, last_movement_at=now(), updated_at=now()
    where id = bal.id;
  return mid;
end; $$;

-- Change the value of stock held (no quantity change). Returns the part that
-- could not be absorbed (no stock left, or value would go negative); callers
-- send that to cost of sales.
create or replace function public._stock_value_adjust(
  p_company uuid, p_branch uuid, p_product uuid, p_value numeric, p_source_type text, p_source_id uuid,
  p_source_number text, p_user uuid
) returns numeric language plpgsql security definer set search_path = public as $$
declare bal public.stock_balances; v numeric(18,2) := round(p_value, 2); absorbed numeric(18,2); nv numeric(18,2);
begin
  if v = 0 then return 0; end if;
  select * into bal from public.stock_balances where company_id=p_company and branch_id=p_branch and product_id=p_product for update;
  if not found or bal.quantity <= 0 then return v; end if;
  absorbed := case when bal.stock_value + v < 0 then -bal.stock_value else v end;
  if absorbed = 0 then return v; end if;
  nv := bal.stock_value + absorbed;
  insert into public.stock_movements(company_id, branch_id, product_id, movement_type, source_type, source_id, source_number,
      qty_in, qty_out, unit_cost, movement_value, balance_qty, avg_cost_after, balance_value, created_by, created_at)
    values (p_company, p_branch, p_product, 'cost_adjustment', p_source_type, p_source_id, p_source_number,
      0, 0, 0, absorbed, bal.quantity, round(nv / bal.quantity, 4), nv, p_user, clock_timestamp());
  update public.stock_balances set stock_value=nv, avg_unit_cost=round(nv/bal.quantity,4), last_movement_at=now(), updated_at=now()
    where id = bal.id;
  return v - absorbed;
end; $$;

-- ===========================================================================
-- 3. Late-cost propagation (weighted average kept).
-- Units that entered a (branch, product) pool at movement m0 leave it
-- pro rata with every later outflow (that is what weighted average means), so
-- after outflow j a fraction qty_out_j / balance_before_j of the units still
-- in the pool goes with that outflow. Replaying the immutable movements
-- tells exactly how much of a receipt is still held, was sold, written off,
-- returned or transferred - and transfers are followed into the receiving
-- branch. The delta is split in proportion to those quantities with exact
-- (largest-remainder) rounding, so the parts always sum to the delta.
-- ===========================================================================
create or replace function public._propagate_from_movement(
  p_company uuid, p_branch uuid, p_product uuid, p_start_at timestamptz, p_start_id uuid,
  p_units numeric, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_depth int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mv record; remaining numeric := p_units; take numeric; before numeric; parts jsonb := '[]'::jsonb;
  s record; jl jsonb := '[]'::jsonb; unabsorbed numeric(18,2); kind text;
begin
  if p_amount = 0 or p_units <= 0 then return '[]'::jsonb; end if;
  if p_depth > 10 then raise exception 'Cost propagation chain too deep' using errcode = 'P0001'; end if;
  for mv in select * from public.stock_movements
            where company_id = p_company and branch_id = p_branch and product_id = p_product
              and (created_at, id) > (p_start_at, p_start_id) and qty_out > 0
            order by created_at, id loop
    exit when remaining <= 0;
    before := mv.balance_qty + mv.qty_out;
    if before <= 0 then continue; end if;
    take := least(remaining, remaining * mv.qty_out / before);
    remaining := remaining - take;
    kind := case mv.movement_type
              when 'sale' then 'cogs' when 'sales_return_void' then 'cogs'
              when 'adjustment_decrease' then 'loss' when 'adjustment_void' then 'loss' when 'import_receipt_void' then 'loss'
              when 'purchase_return' then 'ppv'
              when 'transfer_out' then 'transfer'
              else 'cogs' end;
    parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', kind, 'factor', take, 'mv', mv.id);
  end loop;
  if remaining > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'held', 'factor', remaining); end if;

  for s in select p.value as part, a.amount from jsonb_array_elements(parts) p
           join public.allocate_amount(round(p_amount, 2), 'quantity', parts) a on a.target_id = (p.value->>'id')::uuid loop
    kind := s.part->>'kind';
    if kind = 'held' then
      unabsorbed := public._stock_value_adjust(p_company, p_branch, p_product, s.amount, p_src_type, p_src_id, p_docnum, p_user);
      jl := jl || public._jl(public.account_id_by_code(p_company, '1150'), s.amount - unabsorbed, 'Late cost to stock held')
               || public._jl(public.account_for(p_company, 'inventory.cost_of_sales'), unabsorbed, 'Late cost (stock no longer held)');
    elsif kind = 'cogs' then
      jl := jl || public._jl(public.account_for(p_company, 'inventory.cost_of_sales'), s.amount, 'Late cost to cost of sales');
    elsif kind = 'loss' then
      jl := jl || public._jl(public.account_for(p_company, 'inventory.loss'), s.amount, 'Late cost to stock written off');
    elsif kind = 'ppv' then
      jl := jl || public._jl(public.account_for(p_company, 'inventory.price_variance'), s.amount, 'Late cost to returned stock');
    else
      jl := jl || public._propagate_transfer((s.part->>'mv')::uuid, (s.part->>'factor')::numeric, s.amount,
                    p_src_type, p_src_id, p_docnum, p_user, p_depth);
    end if;
  end loop;
  return jl;
end; $$;

-- Follow units that left on a branch transfer: the part still in transit
-- raises the transfer's unit cost (picked up by the receipt); parts already
-- received continue in the destination branch's pool.
create or replace function public._propagate_transfer(
  p_out_mv uuid, p_units numeric, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_depth int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mo public.stock_movements; t public.stock_transfers; d numeric; rc numeric; parts jsonb := '[]'::jsonb;
  mi record; s record; jl jsonb := '[]'::jsonb; ln record; open_qty numeric;
begin
  select * into mo from public.stock_movements where id = p_out_mv;
  select * into t from public.stock_transfers where id = mo.source_id;
  if t.id is null then
    return public._jl(public.account_for(mo.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (untraced outflow)');
  end if;
  select coalesce(sum(qty_dispatched),0), coalesce(sum(qty_received),0) into d, rc
    from public.stock_transfer_lines where transfer_id = t.id and product_id = mo.product_id;
  if d <= 0 then
    return public._jl(public.account_for(mo.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (untraced outflow)');
  end if;
  if t.status <> 'voided' and d - rc > 0 then
    parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'transit', 'factor', d - rc);
  end if;
  for mi in select * from public.stock_movements where source_id = t.id and product_id = mo.product_id
              and branch_id = t.destination_branch_id and movement_type = 'transfer_in' order by created_at, id loop
    parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'in', 'factor', mi.qty_in, 'mv', mi.id,
               'at', mi.created_at, 'units', p_units * mi.qty_in / d);
  end loop;
  if jsonb_array_length(parts) = 0 then
    return public._jl(public.account_for(mo.company_id, 'inventory.loss'), p_amount, 'Late cost (voided transfer)');
  end if;
  for s in select p.value as part, a.amount from jsonb_array_elements(parts) p
           join public.allocate_amount(round(p_amount, 2), 'quantity', parts) a on a.target_id = (p.value->>'id')::uuid loop
    if s.part->>'kind' = 'transit' then
      -- In-transit value is carried on the transfer lines and in GL 1150.
      for ln in select * from public.stock_transfer_lines where transfer_id = t.id and product_id = mo.product_id
                  and qty_dispatched > qty_received order by line_no, id loop
        open_qty := ln.qty_dispatched - ln.qty_received;
        update public.stock_transfer_lines set unit_cost = round(unit_cost + s.amount * (open_qty / (d - rc)) / open_qty, 4) where id = ln.id;
      end loop;
      jl := jl || public._jl(public.account_id_by_code(mo.company_id, '1150'), s.amount, 'Late cost to stock in transit');
    else
      jl := jl || public._propagate_from_movement(mo.company_id, t.destination_branch_id, mo.product_id,
                    (s.part->>'at')::timestamptz, (s.part->>'mv')::uuid, (s.part->>'units')::numeric, s.amount,
                    p_src_type, p_src_id, p_docnum, p_user, p_depth + 1);
    end if;
  end loop;
  return jl;
end; $$;


-- A cost delta for one shipment line: split between what is still in
-- transit (1157), what was received (into the receipts' pools) and what was
-- written off / claimed as shortage (6300).
create or replace function public._apply_line_cost_delta(
  p_line uuid, p_amount numeric, p_date date, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_source uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.import_shipment_lines; rec_f numeric; transit_f numeric; loss_f numeric; parts jsonb := '[]'::jsonb;
  s record; jl jsonb := '[]'::jsonb; rparts jsonb; r record; rl record; co uuid;
begin
  if p_amount = 0 then return '[]'::jsonb; end if;
  select * into l from public.import_shipment_lines where id = p_line for update;
  co := l.company_id;
  rec_f := l.received_kg + case when l.line_closed then l.short_normal_kg else 0 end;
  transit_f := public._line_transit_kg(l);
  loss_f := l.short_writeoff_kg + l.short_claim_kg;
  if rec_f > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'received', 'factor', rec_f); end if;
  if transit_f > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'transit', 'factor', transit_f); end if;
  if loss_f > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'loss', 'factor', loss_f); end if;
  if jsonb_array_length(parts) = 0 then raise exception 'Shipment line has no quantity to carry cost' using errcode = 'P0001'; end if;

  for s in select p.value as part, a.amount from jsonb_array_elements(parts) p
           join public.allocate_amount(round(p_amount, 2), 'quantity', parts) a on a.target_id = (p.value->>'id')::uuid loop
    if s.part->>'kind' = 'transit' then
      update public.import_shipment_lines set git_value = git_value + s.amount where id = l.id;
      jl := jl || public._jl(public.account_for(co, 'import.goods_in_transit'), s.amount, 'Import goods in transit');
      perform public._ship_ledger(l.shipment_id, l.id, p_source, 'git', s.amount, p_src_type, p_src_id, p_date);
    elsif s.part->>'kind' = 'loss' then
      jl := jl || public._jl(public.account_for(co, 'inventory.loss'), s.amount, 'Cost of import shortage');
      perform public._ship_ledger(l.shipment_id, l.id, p_source, 'loss', s.amount, p_src_type, p_src_id, p_date);
    else
      rparts := '[]'::jsonb;
      for r in select irl.* from public.import_receipt_lines irl join public.import_receipts ir on ir.id = irl.receipt_id
               where irl.shipment_line_id = l.id and ir.document_status = 'posted' and irl.net_kg_received > 0 order by ir.receipt_date, irl.id loop
        rparts := rparts || jsonb_build_object('id', r.id, 'factor', r.net_kg_received);
      end loop;
      for rl in select irl.*, a.amount as share, ir.branch_id, ir.document_number
                from public.allocate_amount(s.amount, 'quantity', rparts) a
                join public.import_receipt_lines irl on irl.id = a.target_id
                join public.import_receipts ir on ir.id = irl.receipt_id loop
        update public.import_receipt_lines set cost_delta_tzs = cost_delta_tzs + rl.share where id = rl.id;
        jl := jl || public._propagate_from_movement(co, rl.branch_id, l.product_id,
                      (select created_at from public.stock_movements where id = rl.movement_id), rl.movement_id,
                      rl.quantity_received, rl.share, p_src_type, p_src_id, p_docnum, p_user, 0);
        perform public._ship_ledger(l.shipment_id, l.id, p_source, 'inventory', rl.share, p_src_type, p_src_id, p_date);
      end loop;
    end if;
  end loop;
  return jl;
end; $$;

-- A capitalised cost delta for a shipment cost source: allocate to the
-- shipment lines by the source's basis (factors read from the database),
-- record the allocation run, then apply per line.
create or replace function public._apply_source_delta(
  p_source uuid, p_delta numeric, p_date date, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.cost_sources; sh public.import_shipments; t jsonb := '[]'::jsonb; l record; e jsonb; run_id uuid;
  a record; jl jsonb := '[]'::jsonb; f numeric;
begin
  if p_delta = 0 then return '[]'::jsonb; end if;
  select * into s from public.cost_sources where id = p_source for update;
  if s.owner_type <> 'import_shipment' then
    raise exception 'Only import shipment costs are supported here' using errcode = 'P0001';
  end if;
  if s.inventory_treatment <> 'capitalize' then raise exception 'Expensed costs are not allocated to stock' using errcode = 'P0001'; end if;
  select * into sh from public.import_shipments where id = s.import_shipment_id;

  t := public._source_targets(s.id);

  insert into public.cost_allocation_runs(company_id, cost_source_id, amount_kind, basis, total_amount, is_current, created_by)
    values (s.company_id, s.id, 'delta', s.allocation_basis, p_delta, false, p_user) returning id into run_id;
  for a in select * from public.allocate_amount(p_delta, 'value', t) loop
    insert into public.cost_allocations(company_id, run_id, target_type, target_id, factor, amount)
      values (s.company_id, run_id, 'import_shipment_line', a.target_id,
              (select (x->>'factor')::numeric from jsonb_array_elements(t) x where (x->>'id')::uuid = a.target_id), a.amount);
    jl := jl || public._apply_line_cost_delta(a.target_id, a.amount, p_date, p_src_type, p_src_id, p_docnum, p_user, s.id);
    update public.import_shipment_lines set costs_applied_tzs = costs_applied_tzs + a.amount where id = a.target_id;
  end loop;
  update public.cost_sources set capitalised_applied = capitalised_applied + p_delta where id = s.id;
  return jl;
end; $$;

-- Allocation targets for a shipment cost source: [{id, factor}] over the
-- shipment's lines by the source's basis (factors read from the database).
create or replace function public._source_targets(p_source uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.cost_sources; sh public.import_shipments; t jsonb := '[]'::jsonb; l record; e jsonb; f numeric;
begin
  select * into s from public.cost_sources where id = p_source;
  select * into sh from public.import_shipments where id = s.import_shipment_id;
  if s.allocation_basis in ('direct','manual','percent') then
    if s.allocation_targets is null or jsonb_array_length(s.allocation_targets) = 0 then
      raise exception 'Set the target lines for a % allocation', s.allocation_basis using errcode = 'P0001';
    end if;
    for e in select * from jsonb_array_elements(s.allocation_targets) loop
      if not exists (select 1 from public.import_shipment_lines where id = (e->>'id')::uuid and shipment_id = sh.id) then
        raise exception 'Allocation target is not a line of this shipment' using errcode = '23514';
      end if;
      f := case s.allocation_basis when 'direct' then 1 when 'manual' then (e->>'amount')::numeric else (e->>'percent')::numeric end;
      if f is null or f < 0 then raise exception 'Invalid allocation target' using errcode = 'P0001'; end if;
      t := t || jsonb_build_object('id', e->>'id', 'factor', f);
    end loop;
    if s.allocation_basis = 'direct' and jsonb_array_length(t) <> 1 then
      raise exception 'Direct allocation needs exactly one line' using errcode = 'P0001';
    end if;
  else
    for l in select * from public.import_shipment_lines where shipment_id = sh.id order by line_no, id loop
      f := case s.allocation_basis
             when 'weight' then coalesce(l.shipped_kg, l.net_kg)
             when 'quantity' then l.quantity
             when 'volume' then l.volume_m3
             else case when l.goods_recognised_tzs > 0 then l.goods_recognised_tzs
                       when l.goods_invoiced_tzs > 0 then l.goods_invoiced_tzs
                       else l.fc_amount * case when sh.currency_code = 'TZS' then 1 else coalesce(sh.planning_rate, 1) end end
           end;
      if f is null then raise exception 'Every line needs a % figure to allocate this cost', s.allocation_basis using errcode = 'P0001'; end if;
      t := t || jsonb_build_object('id', l.id, 'factor', f);
    end loop;
  end if;
  return t;
end; $$;

-- ===========================================================================
-- 4. Shipments: numbering and status
-- ===========================================================================
create or replace function public.import_shipments_number()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.document_number is null then
    NEW.document_number := public.next_document_number(NEW.company_id, NEW.branch_id, 'import_shipment');
  end if;
  if NEW.named_place is not null then NEW.named_place := btrim(NEW.named_place); end if;
  return NEW;
end; $$;
drop trigger if exists trg_import_shipments_number on public.import_shipments;
create trigger trg_import_shipments_number before insert on public.import_shipments
  for each row execute function public.import_shipments_number();

create or replace function public.set_import_shipment_status(p_id uuid, p_status text, p_date date, p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare sh public.import_shipments;
begin
  select * into sh from public.import_shipments where id = p_id for update;
  if not found then raise exception 'Shipment not found' using errcode = 'P0001'; end if;
  perform public.assert_feature(sh.company_id, 'imports');
  perform public.assert_actor(p_user, sh.company_id, 'imports.edit_draft', sh.branch_id);
  if p_status = 'ready' and sh.logistics_status = 'draft' then
    if not exists (select 1 from public.import_shipment_lines where shipment_id = p_id) then
      raise exception 'Add at least one line' using errcode = 'P0001'; end if;
    if sh.named_place is null or sh.named_place = '' then
      raise exception 'Record the named place for the delivery terms (e.g. CIF Dar es Salaam)' using errcode = 'P0001'; end if;
  elsif p_status = 'dispatched' and sh.logistics_status in ('draft','ready') then
    if p_date is null then raise exception 'Enter the shipped (bill of lading) date' using errcode = 'P0001'; end if;
    update public.import_shipments set shipped_date = p_date where id = p_id;
  elsif p_status = 'cancelled' and sh.logistics_status in ('draft','ready') then
    if exists (select 1 from public.import_shipment_ledger where shipment_id = p_id)
       or exists (select 1 from public.purchases where import_shipment_id = p_id and document_status = 'posted') then
      raise exception 'A shipment with postings cannot be cancelled' using errcode = 'P0001'; end if;
  else
    raise exception 'Cannot move a % shipment to %', sh.logistics_status, p_status using errcode = 'P0001';
  end if;
  update public.import_shipments set logistics_status = p_status, updated_by = p_user where id = p_id;
  return p_id;
end; $$;

-- ===========================================================================
-- 5. Ownership (title / control) recognition: Dr 1157 / Cr 2130.
-- Value per line = goods already invoiced (TZS) + the uninvoiced foreign
-- value at the given accrual rate (an explicit, recorded estimate).
-- ===========================================================================
create or replace function public._recognise_ownership(sh public.import_shipments, p_date date, p_rate numeric,
  p_src_type text, p_src_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.import_shipment_lines; uninv numeric(18,2); rate numeric; val numeric(18,2); jl jsonb := '[]'::jsonb; is_fc boolean;
begin
  is_fc := sh.currency_code <> 'TZS';
  for l in select * from public.import_shipment_lines where shipment_id = sh.id order by id for update loop
    uninv := greatest(l.fc_amount - l.goods_invoiced_fc, 0);
    if uninv > 0 and is_fc and (p_rate is null or p_rate <= 0) then
      raise exception 'An exchange rate is needed to accrue the uninvoiced % goods value', sh.currency_code using errcode = 'P0001';
    end if;
    rate := case when is_fc then p_rate else 1 end;
    val := l.goods_invoiced_tzs + round(uninv * coalesce(rate, 1), 2);
    update public.import_shipment_lines set goods_recognised_tzs = val, goods_accrual_rate = rate, git_value = git_value + val
      where id = l.id;
    jl := jl || public._jl(public.account_for(sh.company_id, 'import.goods_in_transit'), val, 'Import goods owned, in transit')
             || public._jl(public.account_for(sh.company_id, 'import.gr_ir'), -val, 'Goods received / owned not invoiced');
    perform public._ship_ledger(sh.id, l.id, null, 'git', val, p_src_type, p_src_id, p_date);
    perform public._ship_ledger(sh.id, l.id, null, 'grir', -val, p_src_type, p_src_id, p_date);
  end loop;
  update public.import_shipments set ownership_recognised_date = p_date, title_date = p_date where id = sh.id;
  return jl;
end; $$;

create or replace function public.recognise_import_ownership(p_shipment uuid, p_date date, p_rate numeric, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare sh public.import_shipments; jl jsonb;
begin
  perform public._require_key(p_idem);
  select * into sh from public.import_shipments where id = p_shipment for update;
  if not found then raise exception 'Shipment not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'recognise_import_ownership', p_shipment) then return p_shipment; end if;
  perform public.assert_feature(sh.company_id, 'imports');
  perform public.assert_actor(p_user, sh.company_id, 'imports.post', sh.branch_id);
  if sh.ownership_recognised_date is not null then raise exception 'Ownership is already recorded' using errcode = 'P0001'; end if;
  if sh.ownership_event = 'receipt' then raise exception 'For this shipment ownership passes on receipt' using errcode = 'P0001'; end if;
  if sh.logistics_status not in ('ready','dispatched') then raise exception 'Shipment must be ready or dispatched' using errcode = 'P0001'; end if;
  if p_date is null then raise exception 'Enter the ownership date' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'recognise_import_ownership', p_shipment) then return p_shipment; end if;
  perform public.assert_period_open(sh.company_id, p_date);
  jl := public._recognise_ownership(sh, p_date, p_rate, 'import_ownership', sh.id);
  perform public.create_journal(sh.company_id, sh.branch_id, p_date, 'import_ownership', sh.id, sh.document_number,
    'Ownership of import '||sh.document_number, p_user, jl);
  return p_shipment;
end; $$;

-- ===========================================================================
-- 6. Goods invoice (purchase in invoice_only mode, lines linked to shipment
-- lines): Dr 2130 GR/IR goods cost, Dr 1160 recoverable VAT / Cr 2110.
-- Once ownership is recorded, the difference between the invoiced value and
-- the accrued value is a cost delta (to goods in transit / received stock).
-- ===========================================================================
create or replace function public.post_import_goods_invoice(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v public.purchases; sh public.import_shipments; ln record; l public.import_shipment_lines; pb public.supplier_payables;
  is_fc boolean; rate numeric; docnum text; norm text;
  fc_base numeric(18,2); fc_net numeric(18,2); fc_tax numeric(18,2); net numeric(18,2); tax numeric(18,2);
  rec numeric(18,2); nonrec numeric(18,2); cost_val numeric(18,2); fc_cost numeric(18,2);
  v_sub numeric(18,2):=0; v_disc numeric(18,2):=0; v_net numeric(18,2):=0; v_tax numeric(18,2):=0; v_rec numeric(18,2):=0;
  v_nonrec numeric(18,2):=0; v_grand numeric(18,2):=0; v_cost numeric(18,2):=0;
  fc_sub numeric(18,2):=0; fc_tax_t numeric(18,2):=0; fc_grand numeric(18,2):=0;
  target numeric(18,2); delta numeric(18,2); jl jsonb := '[]'::jsonb;
begin
  perform public._require_key(p_idem);
  select * into v from public.purchases where id = p_id for update;
  if not found then raise exception 'Invoice not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'post_import_goods_invoice', p_id) then return p_id; end if;
  if v.document_status <> 'draft' then raise exception 'Invoice already %', v.document_status using errcode = 'P0001'; end if;
  if v.posting_mode <> 'invoice_only' or v.import_shipment_id is null then
    raise exception 'Not an import goods invoice' using errcode = 'P0001'; end if;
  select * into sh from public.import_shipments where id = v.import_shipment_id for update;
  perform public.assert_feature(v.company_id, 'imports');
  perform public.assert_actor(p_user, v.company_id, 'imports.post', v.branch_id);
  is_fc := v.currency_code <> 'TZS'; rate := v.exchange_rate;
  if is_fc then
    perform public.assert_feature(v.company_id, 'fx_settlement');
    perform public.assert_actor(p_user, v.company_id, 'fx.enter_rate', v.branch_id);
    if v.rate_source is null then raise exception 'Record the source of the exchange rate' using errcode = 'P0001'; end if;
    if v.rate_source = 'rate_table' and rate <> public.exchange_rate_on(v.company_id, v.currency_code, v.document_date) then
      raise exception 'The rate does not match the exchange-rate table' using errcode = 'P0001'; end if;
  end if;
  if sh.logistics_status = 'cancelled' then raise exception 'Shipment is cancelled' using errcode = 'P0001'; end if;
  if exists (select 1 from public.purchase_payments where purchase_id = p_id)
     or exists (select 1 from public.purchase_advance_applications where purchase_id = p_id) then
    raise exception 'Import goods invoices are settled through supplier payments' using errcode = 'P0001'; end if;
  if exists (select 1 from public.purchase_lines where purchase_id = p_id and import_shipment_line_id is null) then
    raise exception 'Every invoice line must be linked to a shipment line' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.purchase_lines where purchase_id = p_id) then
    raise exception 'Invoice has no lines' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'post_import_goods_invoice', p_id) then return p_id; end if;
  perform public.assert_period_open(v.company_id, v.document_date);

  norm := public.norm_invoice(v.supplier_invoice_number);
  docnum := public.next_document_number(v.company_id, v.branch_id, 'purchase');

  for ln in select * from public.purchase_lines where purchase_id = p_id order by import_shipment_line_id, line_no, id loop
    if is_fc then
      fc_base := round(ln.quantity * ln.unit_cost - ln.discount, 2);
      if fc_base < 0 then raise exception 'Line discount exceeds line value' using errcode = 'P0001'; end if;
      if ln.tax_inclusive and ln.tax_rate > 0 then fc_net := round(fc_base / (1 + ln.tax_rate/100.0), 2); fc_tax := round(fc_base - fc_net, 2);
      else fc_net := fc_base; fc_tax := round(fc_base * ln.tax_rate/100.0, 2); end if;
      net := round(fc_net * rate, 2); tax := round(fc_tax * rate, 2);
      fc_sub := fc_sub + round(ln.quantity * ln.unit_cost, 2); fc_tax_t := fc_tax_t + fc_tax; fc_grand := fc_grand + fc_net + fc_tax;
      v_sub := v_sub + round(round(ln.quantity * ln.unit_cost, 2) * rate, 2); v_disc := v_disc + round(ln.discount * rate, 2);
    else
      fc_base := round(ln.quantity * ln.unit_cost - ln.discount, 2);
      if fc_base < 0 then raise exception 'Line discount exceeds line value' using errcode = 'P0001'; end if;
      if ln.tax_inclusive and ln.tax_rate > 0 then net := round(fc_base / (1 + ln.tax_rate/100.0), 2); tax := round(fc_base - net, 2);
      else net := fc_base; tax := round(fc_base * ln.tax_rate/100.0, 2); end if;
      fc_net := net; fc_tax := tax;
      v_sub := v_sub + round(ln.quantity * ln.unit_cost, 2); v_disc := v_disc + ln.discount;
    end if;
    rec := case when ln.is_recoverable then tax else 0 end; nonrec := tax - rec;
    cost_val := round(net + nonrec, 2);                       -- recoverable VAT never in stock cost
    fc_cost := round(fc_net + case when ln.is_recoverable then 0 else fc_tax end, 2);
    v_net := v_net + net; v_tax := v_tax + tax; v_rec := v_rec + rec; v_nonrec := v_nonrec + nonrec;
    v_grand := v_grand + round(net + tax, 2); v_cost := v_cost + cost_val;
    update public.purchase_lines set net_amount = net, tax_amount = tax, recoverable_tax = rec, nonrecoverable_tax = nonrec,
      gross_amount = round(net + tax, 2), inventory_value = 0, inventory_unit_cost = 0,
      fc_unit_cost = case when is_fc then ln.unit_cost end, fc_discount = case when is_fc then ln.discount end,
      fc_net_amount = case when is_fc then fc_net end, fc_tax_amount = case when is_fc then fc_tax end,
      fc_gross_amount = case when is_fc then round(fc_net + fc_tax, 2) end
      where id = ln.id;

    select * into l from public.import_shipment_lines where id = ln.import_shipment_line_id for update;
    if l.goods_invoiced_qty + ln.quantity > l.quantity + 0.0001 then
      raise exception 'Invoiced quantity exceeds the shipment line quantity' using errcode = 'P0001'; end if;
    update public.import_shipment_lines set goods_invoiced_tzs = goods_invoiced_tzs + cost_val,
      goods_invoiced_fc = goods_invoiced_fc + fc_cost, goods_invoiced_qty = goods_invoiced_qty + ln.quantity
      where id = l.id returning * into l;
    perform public._ship_ledger(sh.id, l.id, null, 'grir', cost_val, 'purchase', p_id, v.document_date);
    if sh.ownership_recognised_date is not null then
      target := l.goods_invoiced_tzs + round(greatest(l.fc_amount - l.goods_invoiced_fc, 0) * coalesce(l.goods_accrual_rate, 1), 2);
      delta := target - l.goods_recognised_tzs;
      if delta <> 0 then
        jl := jl || public._apply_line_cost_delta(l.id, delta, v.document_date, 'purchase', p_id, docnum, p_user, null)
                 || public._jl(public.account_for(v.company_id, 'import.gr_ir'), -delta, 'Goods value adjusted to invoice');
        perform public._ship_ledger(sh.id, l.id, null, 'grir', -delta, 'purchase', p_id, v.document_date);
        update public.import_shipment_lines set goods_recognised_tzs = goods_recognised_tzs + delta where id = l.id;
      end if;
    end if;
  end loop;

  jl := public._jl(public.account_for(v.company_id, 'import.gr_ir'), v_cost, 'Import goods invoiced')
     || public._jl(public.account_for(v.company_id, 'tax.input_vat'), v_rec, 'Input VAT')
     || public._jl(public.account_id_by_code(v.company_id, '2110'), -v_grand,
          case when is_fc then 'Accounts payable ('||v.currency_code||' '||fc_grand||')' else 'Accounts payable' end)
     || jl;
  perform public.create_journal(v.company_id, v.branch_id, v.document_date, 'purchase', v.id, docnum, 'Import goods invoice '||docnum, p_user, jl);

  perform set_config('letiq.import_posting', 'on', true);
  update public.purchases set document_status='posted', document_number=docnum, supplier_invoice_norm=norm,
    subtotal=v_sub, discount_total=v_disc, net_total=v_net, tax_total=v_tax, recoverable_tax=v_rec, nonrecoverable_tax=v_nonrec,
    grand_total=v_grand, inventory_value=0,
    fc_subtotal = case when is_fc then fc_sub else 0 end, fc_tax_total = case when is_fc then fc_tax_t else 0 end,
    fc_grand_total = case when is_fc then fc_grand else 0 end, posted_by=p_user, posted_at=now()
    where id = p_id;
  perform set_config('letiq.import_posting', 'off', true);

  if v_grand > 0 then
    insert into public.supplier_payables(company_id, branch_id, supplier_id, source_type, purchase_id, original_amount, outstanding,
        status, currency_code, fc_original, fc_outstanding)
      values (v.company_id, v.branch_id, v.supplier_id, 'purchase', v.id, v_grand, v_grand, 'open', v.currency_code,
        case when is_fc then fc_grand else 0 end, case when is_fc then fc_grand else 0 end)
      returning * into pb;
    perform public._payable_event(pb, 'invoice', 'purchase', v.id, v.document_date, pb.fc_original, v_grand);
  end if;
  perform public.recalc_purchase(p_id);
  if sh.cost_status = 'finalized' then update public.import_shipments set cost_status = 'adjusted' where id = sh.id; end if;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (v.company_id, 'purchase', p_id, 'draft', 'posted', p_user);
  return p_id;
end; $$;

-- ===========================================================================
-- 7. Approved cost accrual (planning estimates never post): capitalised
-- Dr 1157 / stock via allocation, expensed Dr expense; Cr 2140.
-- ===========================================================================
create or replace function public.accrue_import_cost(p_source uuid, p_amount numeric, p_date date, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.cost_sources; sh public.import_shipments; jl jsonb;
begin
  perform public._require_key(p_idem);
  select * into s from public.cost_sources where id = p_source for update;
  if not found then raise exception 'Cost not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'accrue_import_cost', p_source) then return p_source; end if;
  if s.owner_type <> 'import_shipment' then raise exception 'Not an import cost' using errcode = 'P0001'; end if;
  select * into sh from public.import_shipments where id = s.import_shipment_id for update;
  perform public.assert_feature(s.company_id, 'imports');
  perform public.assert_actor(p_user, s.company_id, 'imports.post', sh.branch_id);
  if s.status <> 'estimated' then raise exception 'Only an estimated cost can be accrued (it is %)', s.status using errcode = 'P0001'; end if;
  if sh.cost_status = 'finalized' then raise exception 'Shipment costs are finalised; use a cost invoice or credit note' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Accrual must be a positive amount with at most 2 decimals' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'accrue_import_cost', p_source) then return p_source; end if;
  perform public.assert_period_open(s.company_id, p_date);
  if s.inventory_treatment = 'capitalize' then
    jl := public._apply_source_delta(s.id, p_amount, p_date, 'cost_accrual', s.id, sh.document_number, p_user);
  else
    jl := public._jl(s.expense_account_id, p_amount, 'Accrued import cost (expensed)');
    perform public._ship_ledger(sh.id, null, s.id, 'expense', p_amount, 'cost_accrual', s.id, p_date);
  end if;
  jl := jl || public._jl(public.account_for(s.company_id, 'import.accrued_costs'), -p_amount, 'Accrued import cost');
  perform public._ship_ledger(sh.id, null, s.id, 'accrual', -p_amount, 'cost_accrual', s.id, p_date);
  perform public.create_journal(s.company_id, sh.branch_id, p_date, 'cost_accrual', s.id, sh.document_number,
    'Accrued import cost '||sh.document_number, p_user, jl);
  update public.cost_sources set status = 'accrued', accrued_amount = p_amount, accrual_date = p_date, updated_by = p_user where id = s.id;
  update public.import_shipments set cost_status = 'provisional' where id = sh.id and cost_status = 'estimated';
  return p_source;
end; $$;

-- ===========================================================================
-- 8. Cost invoice (TZS service invoices) and credit notes.
-- A line linked to an accrued cost reverses the accrual; only the difference
-- changes cost. Capitalised categories must be linked to a shipment cost.
-- ===========================================================================
create or replace function public.post_cost_invoice(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ci public.cost_invoices; cr public.cost_invoices; ln record; s public.cost_sources; cat public.cost_categories;
  sh public.import_shipments; pb public.supplier_payables; docnum text; sgn int;
  rec numeric(18,2); nonrec numeric(18,2); cost numeric(18,2); delta numeric(18,2); acc numeric(18,2);
  v_net numeric(18,2) := 0; v_tax numeric(18,2) := 0; v_grand numeric(18,2) := 0; jl jsonb := '[]'::jsonb;
begin
  perform public._require_key(p_idem);
  select * into ci from public.cost_invoices where id = p_id for update;
  if not found then raise exception 'Cost invoice not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'post_cost_invoice', p_id) then return p_id; end if;
  if ci.document_status <> 'draft' then raise exception 'Cost invoice already %', ci.document_status using errcode = 'P0001'; end if;
  perform public.assert_feature(ci.company_id, 'imports');
  perform public.assert_actor(p_user, ci.company_id, 'cost_invoices.post', ci.branch_id);
  if not exists (select 1 from public.cost_invoice_lines where cost_invoice_id = p_id) then
    raise exception 'Cost invoice has no lines' using errcode = 'P0001'; end if;
  sgn := case when ci.document_kind = 'invoice' then 1 else -1 end;
  if sgn < 0 then
    select * into cr from public.cost_invoices where id = ci.credited_invoice_id;
    if cr.document_status <> 'posted' then raise exception 'The credited invoice must be posted' using errcode = 'P0001'; end if;
  end if;
  if not public.claim_idempotency(p_idem, 'post_cost_invoice', p_id) then return p_id; end if;
  perform public.assert_period_open(ci.company_id, ci.document_date);
  docnum := public.next_document_number(ci.company_id, ci.branch_id, 'cost_invoice');

  for ln in select * from public.cost_invoice_lines where cost_invoice_id = p_id order by cost_source_id nulls last, line_no, id loop
    rec := case when ln.is_recoverable then ln.tax_amount else 0 end; nonrec := ln.tax_amount - rec;
    cost := round(ln.net_amount + nonrec, 2);
    v_net := v_net + ln.net_amount; v_tax := v_tax + ln.tax_amount;
    jl := jl || public._jl(public.account_for(ci.company_id, 'tax.input_vat'), sgn * rec, 'Input VAT');
    select * into cat from public.cost_categories where id = ln.cost_category_id;
    if ln.cost_source_id is null then
      if cat.inventory_treatment = 'capitalize' then
        raise exception 'Line "%": a capitalised cost must be linked to a shipment cost line', coalesce(ln.description, cat.name) using errcode = 'P0001';
      end if;
      jl := jl || public._jl(cat.expense_account_id, sgn * cost, coalesce(ln.description, cat.name));
      continue;
    end if;
    select * into s from public.cost_sources where id = ln.cost_source_id for update;
    if s.cost_category_id <> ln.cost_category_id then raise exception 'Line category must match the linked cost' using errcode = 'P0001'; end if;
    if s.status = 'voided' then raise exception 'The linked cost is voided' using errcode = 'P0001'; end if;
    if s.owner_type <> 'import_shipment' then raise exception 'Only import shipment costs are supported here' using errcode = 'P0001'; end if;
    select * into sh from public.import_shipments where id = s.import_shipment_id for update;
    if sgn > 0 then
      if exists (select 1 from public.cost_source_actuals where cost_source_id = s.id) then
        raise exception 'This cost already has its actual invoice; use a credit note or a new cost line' using errcode = 'P0001'; end if;
      acc := case when s.status = 'accrued' then s.accrued_amount else 0 end;
      delta := cost - acc;
      if acc > 0 then
        jl := jl || public._jl(public.account_for(ci.company_id, 'import.accrued_costs'), acc, 'Accrual replaced by actual');
        perform public._ship_ledger(sh.id, null, s.id, 'accrual', acc, 'cost_invoice', p_id, ci.document_date);
      end if;
      insert into public.cost_source_actuals(cost_source_id, cost_invoice_line_id, company_id) values (s.id, ln.id, ci.company_id);
      update public.cost_sources set status = 'invoiced', actual_amount = cost, supplier_id = coalesce(supplier_id, ci.supplier_id), updated_by = p_user where id = s.id;
    else
      if s.status <> 'invoiced' then raise exception 'A credit note can only adjust an invoiced cost' using errcode = 'P0001'; end if;
      if cost > s.actual_amount then raise exception 'Credit exceeds the invoiced cost' using errcode = 'P0001'; end if;
      delta := -cost;
      update public.cost_sources set actual_amount = actual_amount - cost, updated_by = p_user where id = s.id;
    end if;
    if s.inventory_treatment = 'capitalize' then
      jl := jl || public._apply_source_delta(s.id, delta, ci.document_date, 'cost_invoice', p_id, docnum, p_user);
    else
      jl := jl || public._jl(s.expense_account_id, delta, coalesce(ln.description, cat.name));
      perform public._ship_ledger(sh.id, null, s.id, 'expense', delta, 'cost_invoice', p_id, ci.document_date);
    end if;
    update public.import_shipments set cost_status = case when cost_status = 'finalized' then 'adjusted'
      when cost_status = 'estimated' then 'provisional' else cost_status end where id = sh.id;
  end loop;

  v_grand := round(v_net + v_tax, 2);
  if sgn > 0 then
    jl := jl || public._jl(public.account_id_by_code(ci.company_id, '2110'), -v_grand, 'Accounts payable');
  else
    select * into pb from public.supplier_payables where cost_invoice_id = cr.id for update;
    if pb.id is null or pb.outstanding < v_grand then
      raise exception 'Credit exceeds the open balance of the credited invoice' using errcode = 'P0001'; end if;
    update public.supplier_payables set outstanding = outstanding - v_grand,
      status = case when outstanding - v_grand <= 0 then 'settled' else 'partial' end where id = pb.id;
    jl := jl || public._jl(public.account_id_by_code(ci.company_id, '2110'), v_grand, 'Credit note reduces payable');
  end if;
  perform public.create_journal(ci.company_id, ci.branch_id, ci.document_date, 'cost_invoice', ci.id, docnum,
    case when sgn > 0 then 'Cost invoice ' else 'Cost credit note ' end || docnum, p_user, jl);

  update public.cost_invoices set document_status = 'posted', document_number = docnum, net_total = v_net, tax_total = v_tax,
    grand_total = v_grand, posted_at = now(), posted_by = p_user where id = p_id;
  if sgn > 0 then
    perform public.register_supplier_invoice(ci.company_id, ci.supplier_id, ci.supplier_invoice_number, 'cost_invoice', ci.id);
    if v_grand > 0 then
      insert into public.supplier_payables(company_id, branch_id, supplier_id, source_type, cost_invoice_id, original_amount, outstanding, status)
        values (ci.company_id, ci.branch_id, ci.supplier_id, 'cost_invoice', ci.id, v_grand, v_grand, 'open');
    end if;
  end if;
  return p_id;
end; $$;

-- ===========================================================================
-- 9. Goods receipt into bulk stock.
-- Each line receives its in-transit share: value = in-transit value x
-- (kg received / kg still in transit); the final receipt of a line takes the
-- exact remainder, so partial receipts always add up to the shipment total.
-- A final shortfall needs an approved resolution: normal loss (absorbed by
-- the kg received), write-off (6300) or claim (1145).
-- ===========================================================================
create or replace function public.post_import_receipt(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r public.import_receipts; sh public.import_shipments; rl record; l public.import_shipment_lines; p public.products;
  docnum text; transit numeric; v numeric(18,2); val numeric(18,2); short numeric; short_val numeric(18,2); swo numeric(18,2);
  mid uuid; lot uuid; inv numeric(18,2) := 0; wo numeric(18,2) := 0; claim numeric(18,2) := 0; git_out numeric(18,2) := 0;
  jl jsonb := '[]'::jsonb; approved boolean := false;
begin
  perform public._require_key(p_idem);
  select * into r from public.import_receipts where id = p_id for update;
  if not found then raise exception 'Receipt not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'post_import_receipt', p_id) then return p_id; end if;
  if r.document_status <> 'draft' then raise exception 'Receipt already %', r.document_status using errcode = 'P0001'; end if;
  select * into sh from public.import_shipments where id = r.shipment_id for update;
  perform public.assert_feature(r.company_id, 'imports');
  perform public.assert_actor(p_user, r.company_id, 'imports.receive', r.branch_id);
  if sh.logistics_status not in ('ready','dispatched','partially_received') then
    raise exception 'Shipment is not open for receiving (%)', sh.logistics_status using errcode = 'P0001'; end if;
  if not exists (select 1 from public.import_receipt_lines where receipt_id = p_id) then
    raise exception 'Receipt has no lines' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'post_import_receipt', p_id) then return p_id; end if;
  perform public.assert_period_open(r.company_id, r.receipt_date);

  if sh.ownership_recognised_date is null then
    if sh.ownership_event <> 'receipt' then
      raise exception 'Record ownership of the goods (title / arrival) before receiving them' using errcode = 'P0001'; end if;
    jl := jl || public._recognise_ownership(sh, r.receipt_date, r.goods_accrual_rate, 'import_receipt', r.id);
    select * into sh from public.import_shipments where id = sh.id;
  end if;

  docnum := public.next_document_number(r.company_id, r.branch_id, 'import_receipt');
  for rl in select * from public.import_receipt_lines where receipt_id = p_id order by shipment_line_id, line_no, id loop
    select * into l from public.import_shipment_lines where id = rl.shipment_line_id for update;
    select * into p from public.products where id = l.product_id;
    if l.line_closed then raise exception 'Shipment line for % is already fully received', p.name using errcode = 'P0001'; end if;
    if rl.net_kg_received < 0 or rl.quantity_received < 0 then raise exception 'Quantities cannot be negative' using errcode = 'P0001'; end if;
    if p.stock_role = 'bulk' and rl.quantity_received <> rl.net_kg_received then
      raise exception 'For bulk % the quantity received is the net kg', p.name using errcode = 'P0001'; end if;
    transit := public._line_transit_kg(l);
    if rl.net_kg_received > transit + 0.0001 then
      raise exception '% kg received for % exceeds the % kg still in transit', rl.net_kg_received, p.name, transit using errcode = 'P0001'; end if;
    v := l.git_value; short := 0; short_val := 0; swo := 0;
    if not rl.is_final then
      if rl.net_kg_received <= 0 then raise exception 'Enter the net kg received for %', p.name using errcode = 'P0001'; end if;
      if rl.damaged_kg > 0 then raise exception 'Record damage on the final receipt of a line' using errcode = 'P0001'; end if;
      val := round(v * rl.net_kg_received / transit, 2);
    else
      short := transit - rl.net_kg_received;
      if short > 0 then
        if rl.resolution is null then
          raise exception 'Resolve the % kg shortfall on % (normal loss, write-off or claim)', short, p.name using errcode = 'P0001'; end if;
        if not approved then perform public.assert_actor(p_user, r.company_id, 'imports.approve', null); approved := true; end if;
        short_val := round(v * short / transit, 2);
        if rl.resolution = 'normal_loss' then val := v; swo := 0;
        else val := v - short_val; swo := short_val; end if;
      else
        val := v;
      end if;
    end if;
    mid := null; lot := null;
    if rl.net_kg_received > 0 then
      mid := public._stock_in_value(r.company_id, r.branch_id, l.product_id, 'import_receipt', 'import_receipt', r.id, docnum,
        rl.quantity_received, val, p_user);
      insert into public.stock_lots(company_id, product_id, origin_type, origin_id, original_quantity, lot_code)
        values (r.company_id, l.product_id, 'import_receipt_line', rl.id, rl.quantity_received, coalesce(rl.batch_code, l.batch_reference))
        returning id into lot;
      insert into public.stock_lot_balances(company_id, branch_id, product_id, lot_id, quantity)
        values (r.company_id, r.branch_id, l.product_id, lot, rl.quantity_received);
    elsif val <> 0 then
      raise exception 'Nothing received for % but value remains; resolve as a shortfall', p.name using errcode = 'P0001';
    end if;
    update public.import_receipt_lines set value_tzs = val, short_value_tzs = swo, shortage_kg = short, movement_id = mid, lot_id = lot,
      resolved_by = case when short > 0 then p_user end, resolved_at = case when short > 0 then now() end where id = rl.id;
    update public.import_shipment_lines set received_kg = received_kg + rl.net_kg_received,
      received_qty = received_qty + rl.quantity_received, git_value = git_value - val - swo,
      short_normal_kg = short_normal_kg + case when rl.resolution = 'normal_loss' then short else 0 end,
      short_writeoff_kg = short_writeoff_kg + case when rl.resolution = 'write_off' then short else 0 end,
      short_claim_kg = short_claim_kg + case when rl.resolution = 'claim' then short else 0 end,
      line_closed = rl.is_final where id = l.id;
    perform public._ship_ledger(sh.id, l.id, null, 'git', -(val + swo), 'import_receipt', r.id, r.receipt_date);
    perform public._ship_ledger(sh.id, l.id, null, 'inventory', val, 'import_receipt', r.id, r.receipt_date);
    if rl.resolution = 'write_off' then wo := wo + swo; perform public._ship_ledger(sh.id, l.id, null, 'loss', swo, 'import_receipt', r.id, r.receipt_date);
    elsif rl.resolution = 'claim' then claim := claim + swo; perform public._ship_ledger(sh.id, l.id, null, 'claims', swo, 'import_receipt', r.id, r.receipt_date); end if;
    inv := inv + val; git_out := git_out + val + swo;
  end loop;

  jl := jl || public._jl(public.account_id_by_code(r.company_id, '1150'), inv, 'Imported goods received into stock')
           || public._jl(public.account_for(r.company_id, 'inventory.loss'), wo, 'Import shortfall written off')
           || public._jl(public.account_for(r.company_id, 'import.claims_receivable'), claim, 'Import shortfall claimed')
           || public._jl(public.account_for(r.company_id, 'import.goods_in_transit'), -git_out, 'Out of import goods in transit');
  perform public.create_journal(r.company_id, r.branch_id, r.receipt_date, 'import_receipt', r.id, docnum,
    'Import goods receipt '||docnum, p_user, jl);

  update public.import_receipts set document_status = 'posted', document_number = docnum, posted_at = now(), posted_by = p_user where id = p_id;
  update public.import_shipments set
    logistics_status = case when not exists (select 1 from public.import_shipment_lines where shipment_id = sh.id and not line_closed)
                            then 'received' else 'partially_received' end,
    arrival_date = coalesce(arrival_date, r.receipt_date)
    where id = sh.id;
  return p_id;
end; $$;

-- ===========================================================================
-- 10. Finalisation, landed-cost sheet.
-- ===========================================================================
create or replace function public.import_finalization_checks(p_shipment uuid)
returns table(check_key text, ok boolean, detail text)
language plpgsql stable security definer set search_path = public as $$
declare sh public.import_shipments; n int; amt numeric;
begin
  select * into sh from public.import_shipments where id = p_shipment;
  check_key := 'ownership'; ok := sh.ownership_recognised_date is not null;
  detail := case when ok then 'Ownership recorded '||to_char(sh.ownership_recognised_date,'DD/MM/YYYY') else 'Ownership not recorded' end; return next;
  select count(*) into n from public.import_shipment_lines where shipment_id = p_shipment and not line_closed;
  check_key := 'receipts'; ok := n = 0; detail := case when ok then 'All lines received and shortfalls resolved' else n||' line(s) not fully received' end; return next;
  select coalesce(sum(amount),0) into amt from public.import_shipment_ledger where shipment_id = p_shipment and account_key = 'grir';
  select count(*) into n from public.import_shipment_lines where shipment_id = p_shipment and goods_invoiced_qty + 0.0001 < quantity;
  check_key := 'goods_invoiced'; ok := amt = 0 and n = 0;
  detail := case when ok then 'Goods fully invoiced; GR/IR cleared' else n||' line(s) not fully invoiced; GR/IR balance '||amt end; return next;
  select coalesce(sum(amount),0) into amt from public.import_shipment_ledger where shipment_id = p_shipment and account_key = 'accrual';
  select count(*) into n from public.cost_sources where import_shipment_id = p_shipment and status = 'accrued';
  check_key := 'accruals'; ok := amt = 0 and n = 0;
  detail := case when ok then 'All accruals replaced by actual invoices' else n||' accrued cost(s) awaiting invoice; accrual balance '||amt end; return next;
  select count(*) into n from public.cost_sources where import_shipment_id = p_shipment and status = 'estimated';
  check_key := 'estimates'; ok := n = 0;
  detail := case when ok then 'No open planning estimates' else n||' estimate(s) neither accrued, invoiced nor voided' end; return next;
  select count(*) into n from public.cost_sources where import_shipment_id = p_shipment and inventory_treatment = 'capitalize'
    and status <> 'voided' and capitalised_applied <> case status when 'invoiced' then actual_amount when 'accrued' then accrued_amount else 0 end;
  check_key := 'allocated'; ok := n = 0; detail := case when ok then 'All capitalised costs allocated' else n||' cost(s) not fully allocated' end; return next;
  select coalesce(sum(amount),0) into amt from public.import_shipment_ledger where shipment_id = p_shipment and account_key = 'git';
  select coalesce(sum(git_value),0) + amt into amt from public.import_shipment_lines where shipment_id = p_shipment;
  check_key := 'in_transit'; ok := amt = 0; detail := case when ok then 'Nothing left in goods in transit' else 'Goods in transit not cleared ('||amt||')' end; return next;
end; $$;

create or replace function public.finalize_import_shipment(p_shipment uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare sh public.import_shipments; failing text;
begin
  perform public._require_key(p_idem);
  select * into sh from public.import_shipments where id = p_shipment for update;
  if not found then raise exception 'Shipment not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'finalize_import_shipment', p_shipment) then return p_shipment; end if;
  perform public.assert_feature(sh.company_id, 'imports');
  perform public.assert_actor(p_user, sh.company_id, 'imports.finalize_cost', null);
  if sh.cost_status in ('finalized','adjusted') then raise exception 'Shipment costs are already finalised' using errcode = 'P0001'; end if;
  select string_agg(detail, '; ') into failing from public.import_finalization_checks(p_shipment) where not ok;
  if failing is not null then raise exception 'Cannot finalise: %', failing using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'finalize_import_shipment', p_shipment) then return p_shipment; end if;
  update public.import_shipments set cost_status = 'finalized', logistics_status = 'closed', finalized_at = now(), finalized_by = p_user
    where id = p_shipment;
  return p_shipment;
end; $$;

-- Estimated vs actual vs commercial landed cost per line. Estimates and the
-- commercial view never post; "actual" is the accounting cost (goods + cap-
-- italised costs); "commercial" adds expensed costs flagged for pricing.
create or replace function public.landed_cost_sheet(p_shipment uuid)
returns table(line_id uuid, product_name text, expected_kg numeric, received_kg numeric, est_goods numeric, est_costs numeric,
  est_total numeric, est_per_kg numeric, act_goods numeric, act_costs numeric, act_total numeric, act_per_kg numeric,
  commercial_extra numeric, commercial_total numeric, commercial_per_kg numeric)
language plpgsql stable security definer set search_path = public as $$
declare sh public.import_shipments; s record; a record; est jsonb := '{}'::jsonb; com jsonb := '{}'::jsonb; amt numeric; l record; kg numeric;
begin
  select * into sh from public.import_shipments where id = p_shipment;
  for s in select * from public.cost_sources where import_shipment_id = p_shipment and status <> 'voided' loop
    if s.inventory_treatment = 'capitalize' and s.estimated_amount > 0 then
      for a in select * from public.allocate_amount(s.estimated_amount, 'value', public._source_targets(s.id)) loop
        est := jsonb_set(est, array[a.target_id::text], to_jsonb(coalesce((est->>a.target_id::text)::numeric, 0) + a.amount));
      end loop;
    elsif s.inventory_treatment = 'expense' and s.include_in_commercial_cost then
      amt := case s.status when 'invoiced' then s.actual_amount when 'accrued' then s.accrued_amount else s.estimated_amount end;
      if amt > 0 then
        for a in select * from public.allocate_amount(amt, 'value', public._source_targets(s.id)) loop
          com := jsonb_set(com, array[a.target_id::text], to_jsonb(coalesce((com->>a.target_id::text)::numeric, 0) + a.amount));
        end loop;
      end if;
    end if;
  end loop;
  for l in select il.*, p.name pname from public.import_shipment_lines il join public.products p on p.id = il.product_id
           where il.shipment_id = p_shipment order by il.line_no, il.id loop
    line_id := l.id; product_name := l.pname; expected_kg := coalesce(l.shipped_kg, l.net_kg);
    received_kg := l.received_kg;
    est_goods := round(l.fc_amount * case when sh.currency_code = 'TZS' then 1 else coalesce(sh.planning_rate, l.goods_accrual_rate, 0) end, 2);
    est_costs := coalesce((est->>l.id::text)::numeric, 0);
    est_total := est_goods + est_costs;
    est_per_kg := case when expected_kg > 0 then round(est_total / expected_kg, 4) end;
    act_goods := l.goods_recognised_tzs; act_costs := l.costs_applied_tzs; act_total := act_goods + act_costs;
    kg := case when l.line_closed then l.received_kg + l.short_normal_kg else expected_kg end;
    act_per_kg := case when kg > 0 then round(act_total / kg, 4) end;
    commercial_extra := coalesce((com->>l.id::text)::numeric, 0);
    commercial_total := act_total + commercial_extra;
    commercial_per_kg := case when kg > 0 then round(commercial_total / kg, 4) end;
    return next;
  end loop;
end; $$;

-- ===========================================================================
-- 11. RLS, grants, lock-down.
-- ===========================================================================
alter table public.import_shipment_ledger enable row level security;
alter table public.import_shipment_ledger force row level security;
drop policy if exists import_shipment_ledger_select on public.import_shipment_ledger;
create policy import_shipment_ledger_select on public.import_shipment_ledger for select to authenticated
  using (public.has_company_access(company_id));
grant select, insert, update, delete on public.import_shipment_ledger to service_role;
grant select on public.import_shipment_ledger to authenticated;
revoke insert, update, delete on public.import_shipment_ledger from anon, authenticated;
revoke all on public.import_shipment_ledger from anon;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'import_shipment_lines_validate','purchases_block_import_reversal','_jl','_ship_ledger','_line_expected_kg',
             '_line_transit_kg','_stock_in_value','_stock_value_adjust','_propagate_from_movement','_propagate_transfer',
             '_apply_line_cost_delta','_apply_source_delta','_source_targets','import_shipments_number',
             'set_import_shipment_status','_recognise_ownership','recognise_import_ownership','post_import_goods_invoice',
             'accrue_import_cost','post_cost_invoice','post_import_receipt','import_finalization_checks',
             'finalize_import_shipment','landed_cost_sheet') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
