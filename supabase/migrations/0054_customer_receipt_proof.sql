-- =========================================================================
-- Elements ERP - Migration 0054: proof of payment on customer receipts.
-- A customer receipt can own attachments (any number of files, 20 MB each),
-- visible to users who can view sales in the receipt branch.
-- =========================================================================

alter table public.document_attachments drop constraint if exists document_attachments_owner_v5;
alter table public.document_attachments drop constraint if exists document_attachments_owner_v6;
alter table public.document_attachments add constraint document_attachments_owner_v6 check (owner_type in (
  'import_shipment','import_receipt','cost_invoice','purchase','stock_transfer','stock_transfer_receipt','rebag_order','stock_transfer_dispatch',
  'sale','sales_request','sales_shipment','supplier_payment','customer_receipt'));

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
  elsif p_owner_type = 'customer_receipt' then
    select r.company_id, array[r.branch_id], 'sales.view' into company_id, branch_ids, view_permission from public.customer_receipts r where r.id = p_owner_id;
  elsif p_owner_type = 'supplier_payment' then
    select s.company_id, array[s.branch_id], 'purchases.view' into company_id, branch_ids, view_permission from public.supplier_payments s where s.id = p_owner_id;
  elsif p_owner_type = 'sales_shipment' then
    select s.company_id, array[s.branch_id], 'sales.view' into company_id, branch_ids, view_permission from public.sales_shipments s where s.id = p_owner_id;
  end if;
  if company_id is null then raise exception 'Document owner not found' using errcode = 'P0001'; end if;
end; $$;

-- Voiding a customer advance goes through the advance reversal (not Dr 1140 for the full amount).
create or replace function public.void_customer_receipt(p_id uuid, p_user uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.customer_receipts; a record;
begin
  select * into r from public.customer_receipts where id=p_id for update;
  if not found then raise exception 'Receipt not found' using errcode='P0001'; end if;
  if r.document_status <> 'posted' then raise exception 'Only posted receipts can be voided' using errcode='P0001'; end if;
  if coalesce(p_reason,'')='' then raise exception 'A reason is required' using errcode='P0001'; end if;
  -- A customer advance (verified on a Sales Request) is reversed properly: Dr 2150 for the
  -- unused part, Dr 1140 for what it paid, commitments released, open orders on hold.
  if r.receipt_kind = 'advance' then
    perform public.reverse_customer_advance(p_id, p_user, p_reason);
    return p_id;
  end if;
  perform public.assert_period_open(r.company_id, r.document_date);

  perform public.create_journal(r.company_id, r.branch_id, current_date, 'customer_receipt_void', r.id, r.document_number,
    'Void receipt '||r.document_number, p_user, jsonb_build_array(
      jsonb_build_object('account_id', public.account_id_by_code(r.company_id,'1140'),'debit',r.amount,'credit',0),
      jsonb_build_object('account_id', public.resolve_payment_ledger(r.company_id, r.payment_account_id),'debit',0,'credit',r.amount)));

  update public.customer_receipts set document_status='voided', voided_by=p_user, voided_at=now(), void_reason=p_reason where id=p_id;
  for a in select distinct sale_id from public.customer_receipt_allocations where receipt_id=p_id loop
    perform public.recalc_sale(a.sale_id);
  end loop;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (r.company_id, 'customer_receipt', p_id, 'posted', 'voided', p_reason, p_user);
  return p_id;
end; $$;
revoke all on function public.void_customer_receipt(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.void_customer_receipt(uuid,uuid,text) to service_role;
