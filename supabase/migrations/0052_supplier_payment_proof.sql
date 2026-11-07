-- =========================================================================
-- Elements ERP - Migration 0052: proof of payment on supplier payments.
-- A supplier payment can own attachments (any number of files, 20 MB each),
-- visible to users who can view purchases in the payment branch.
-- =========================================================================

alter table public.document_attachments drop constraint if exists document_attachments_owner_v4;
alter table public.document_attachments drop constraint if exists document_attachments_owner_v5;
alter table public.document_attachments add constraint document_attachments_owner_v5 check (owner_type in (
  'import_shipment','import_receipt','cost_invoice','purchase','stock_transfer','stock_transfer_receipt','rebag_order','stock_transfer_dispatch',
  'sale','sales_request','sales_shipment','supplier_payment'));

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
  elsif p_owner_type = 'supplier_payment' then
    select s.company_id, array[s.branch_id], 'purchases.view' into company_id, branch_ids, view_permission from public.supplier_payments s where s.id = p_owner_id;
  elsif p_owner_type = 'sales_shipment' then
    select s.company_id, array[s.branch_id], 'sales.view' into company_id, branch_ids, view_permission from public.sales_shipments s where s.id = p_owner_id;
  end if;
  if company_id is null then raise exception 'Document owner not found' using errcode = 'P0001'; end if;
end; $$;
