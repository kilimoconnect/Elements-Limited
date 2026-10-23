-- =========================================================================
-- Elements ERP - Migration 0036: Sales order approval
--
-- A sale starts as a sales order (draft). The Sales / Cashier submits it for
-- approval, with proof of payment attached when the customer has paid; an
-- approver (Branch Manager) approves it, which posts the sale, or rejects it
-- with a reason so it can be corrected and resubmitted.
--
-- The approval state lives beside document_status, so post_sale and every
-- report keep seeing the same draft / posted / voided lifecycle.
-- =========================================================================

alter table public.sales
  add column if not exists approval_status  text not null default 'not_submitted',
  add column if not exists submitted_by     uuid references auth.users(id) on delete set null,
  add column if not exists submitted_at     timestamptz,
  add column if not exists approved_by      uuid references auth.users(id) on delete set null,
  add column if not exists approved_at      timestamptz,
  add column if not exists rejected_by      uuid references auth.users(id) on delete set null,
  add column if not exists rejected_at      timestamptz,
  add column if not exists rejection_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_approval_status_check') then
    alter table public.sales add constraint sales_approval_status_check
      check (approval_status in ('not_submitted','pending','rejected','approved'));
  end if;
end $$;

-- Sales posted before this migration were posted directly: record them as approved.
update public.sales set approval_status = 'approved'
 where document_status <> 'draft' and approval_status = 'not_submitted';

create index if not exists sales_pending_approval_idx
  on public.sales(company_id, branch_id, submitted_at) where approval_status = 'pending';

-- ---------------------------------------------------------------------------
-- Documents: a sale can own attachments; new category proof_of_payment.
-- ---------------------------------------------------------------------------
do $$
begin
  alter table public.document_attachments drop constraint if exists document_attachments_owner_v2;
  alter table public.document_attachments drop constraint if exists document_attachments_category_v2;
  if not exists (select 1 from pg_constraint where conname = 'document_attachments_owner_v3') then
    alter table public.document_attachments add constraint document_attachments_owner_v3 check (owner_type in (
      'import_shipment','import_receipt','cost_invoice','purchase','stock_transfer','stock_transfer_receipt','rebag_order','stock_transfer_dispatch',
      'sale'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_attachments_category_v3') then
    alter table public.document_attachments add constraint document_attachments_category_v3 check (category in (
      'bill_of_lading','packing_list','customs_entry','supplier_invoice','cost_invoice','delivery_note','proof_of_delivery','photo','other',
      'driver_licence','cargo_papers','loading_photo','weighbridge_ticket','transport_invoice','signed_delivery_note','offloading_photo',
      'proof_of_payment'));
  end if;
end $$;

create or replace function public._document_owner(p_owner_type text, p_owner_id uuid,
  out company_id uuid, out branch_ids uuid[], out view_permission text)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_owner_type = 'import_shipment' then
    select s.company_id, array[s.branch_id], 'imports.view' into company_id, branch_ids, view_permission
      from public.import_shipments s where s.id = p_owner_id;
  elsif p_owner_type = 'import_receipt' then
    select r.company_id, array[r.branch_id], 'imports.view' into company_id, branch_ids, view_permission
      from public.import_receipts r where r.id = p_owner_id;
  elsif p_owner_type = 'cost_invoice' then
    select c.company_id, null::uuid[], 'documents.view_financial' into company_id, branch_ids, view_permission
      from public.cost_invoices c where c.id = p_owner_id;
  elsif p_owner_type = 'purchase' then
    select p.company_id, null::uuid[], 'documents.view_financial' into company_id, branch_ids, view_permission
      from public.purchases p where p.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view'
      into company_id, branch_ids, view_permission
      from public.stock_transfers t where t.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer_receipt' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view'
      into company_id, branch_ids, view_permission
      from public.stock_transfer_receipts r join public.stock_transfers t on t.id = r.transfer_id where r.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer_dispatch' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view'
      into company_id, branch_ids, view_permission
      from public.stock_transfer_dispatches d join public.stock_transfers t on t.id = d.transfer_id where d.id = p_owner_id;
  elsif p_owner_type = 'rebag_order' then
    select o.company_id, array[o.branch_id], 'rebagging.view' into company_id, branch_ids, view_permission
      from public.rebag_orders o where o.id = p_owner_id;
  elsif p_owner_type = 'sale' then
    select s.company_id, array[s.branch_id], 'sales.view' into company_id, branch_ids, view_permission
      from public.sales s where s.id = p_owner_id;
  end if;
  if company_id is null then
    raise exception 'Document owner not found' using errcode = 'P0001';
  end if;
end; $$;

revoke all on function public._document_owner(text, uuid) from public, anon, authenticated;
grant execute on function public._document_owner(text, uuid) to service_role;
