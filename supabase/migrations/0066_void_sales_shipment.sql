-- =========================================================================
-- Elements ERP - Migration 0066: void a dispatched / collected sales truck.
-- Reverses everything its dispatch did, in one step:
--   * the customer advance applied to the truck invoice goes back to the
--     order (Dr Accounts receivable 1140 / Cr Customer advances 2150),
--   * the truck invoice is voided (stock back at its cost, revenue, VAT and
--     cost of sales reversed) through the existing void_sale,
--   * the order lines get the quantities and invoiced amounts back, open
--     exceptions of the truck are closed, and a completed order reopens,
--   * the truck is marked voided with the reason; its documents stay.
-- Needs transactions.void at the truck's branch. Refused when the invoice
-- has other payments or posted returns (void those first).
-- =========================================================================

alter table public.sales_shipments add column if not exists voided_at timestamptz;
alter table public.sales_shipments add column if not exists voided_by uuid references auth.users(id) on delete set null;
alter table public.sales_shipments add column if not exists void_reason text;

do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.sales_shipments'::regclass and contype = 'c'
           and pg_get_constraintdef(oid) ilike '%status%planned%' loop
    execute format('alter table public.sales_shipments drop constraint %I', c);
  end loop;
  alter table public.sales_shipments add constraint sales_shipments_status_check
    check (status in ('planned','loading_order_issued','loaded','dispatched','in_transit','delivered','collected','cancelled','voided'));
end $$;

create or replace function public.void_sales_shipment(p_shipment uuid, p_user uuid, p_reason text, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s public.sales_shipments; o public.sales_orders; sale public.sales; a record; f record; ln record; ol public.sales_order_lines;
  take numeric(18,2); left_ numeric(18,2); reversed numeric(18,2) := 0; vd date; acc numeric;
begin
  perform public._require_key(p_idem);
  select * into s from public.sales_shipments where id = p_shipment for update;
  if not found then raise exception 'Truck not found' using errcode = 'P0001'; end if;
  if s.status = 'voided' then return s.id; end if;
  perform public.assert_actor(p_user, s.company_id, 'transactions.void', s.branch_id);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  if s.status not in ('dispatched','in_transit','delivered','collected') or s.invoice_sale_id is null then
    raise exception 'Only a dispatched or collected truck can be voided (cancel a truck that is not dispatched yet)' using errcode = 'P0001';
  end if;
  if not public.claim_idempotency(p_idem, 'void_sales_shipment', p_shipment) then return s.id; end if;
  select * into o from public.sales_orders where id = s.order_id for update;
  if o.status = 'cancelled' then raise exception 'The sales order is cancelled' using errcode = 'P0001'; end if;
  select * into sale from public.sales where id = s.invoice_sale_id for update;
  vd := (now() at time zone 'Africa/Dar_es_Salaam')::date;

  if sale.document_status = 'posted' then
    -- Only the order's own advance may be applied to this invoice; other payments must be voided first.
    if exists (select 1 from public.customer_receipt_allocations x join public.customer_receipts r on r.id = x.receipt_id
               where x.sale_id = sale.id and r.document_status = 'posted'
                 and not exists (select 1 from public.sales_order_funds g where g.order_id = o.id and g.receipt_id = x.receipt_id)) then
      raise exception 'This truck invoice has other customer payments; void those first' using errcode = 'P0001';
    end if;
    -- Give the applied advance back to the order's commitment (latest commitment first).
    for a in select x.receipt_id, sum(x.amount) amt from public.customer_receipt_allocations x
             where x.sale_id = sale.id group by x.receipt_id loop
      left_ := a.amt;
      for f in select * from public.sales_order_funds where order_id = o.id and receipt_id = a.receipt_id and amount_applied > 0
               order by created_at desc, id desc for update loop
        exit when left_ <= 0;
        take := least(f.amount_applied, left_);
        update public.sales_order_funds set amount_applied = amount_applied - take where id = f.id;
        left_ := left_ - take;
      end loop;
      reversed := reversed + a.amt;
    end loop;
    delete from public.customer_receipt_allocations where sale_id = sale.id;
    if reversed > 0 then
      perform public.create_journal(s.company_id, s.branch_id, vd, 'advance_application_void', sale.id, sale.document_number,
        'Customer advance returned to order ' || o.document_number || ' (truck ' || s.document_number || ' voided)', p_user,
        jsonb_build_array(
          jsonb_build_object('account_id', public.account_id_by_code(s.company_id, '1140'), 'debit', reversed, 'credit', 0, 'memo', 'Accounts receivable'),
          jsonb_build_object('account_id', public.account_id_by_code(s.company_id, '2150'), 'debit', 0, 'credit', reversed, 'memo', 'Customer advance returned')));
    end if;
    perform public.recalc_sale(sale.id);
    -- Stock back at its cost; revenue, VAT, receivable and cost of sales reversed.
    perform public.void_sale(sale.id, p_user, 'Truck ' || s.document_number || ' voided: ' || btrim(p_reason));
  end if;

  -- The order gets the quantities and amounts of this truck back.
  for ln in select * from public.sale_lines where sale_id = sale.id loop
    select * into ol from public.sales_order_lines where order_id = o.id and line_no = ln.line_no and product_id is not distinct from ln.product_id for update;
    continue when not found;
    update public.sales_order_lines set qty_dispatched = greatest(qty_dispatched - ln.quantity, 0),
      invoiced_net = invoiced_net - coalesce(ln.fixed_net, 0), invoiced_tax = invoiced_tax - coalesce(ln.fixed_tax, 0) where id = ol.id;
  end loop;
  for ln in select * from public.sales_shipment_lines where shipment_id = s.id and coalesce(qty_accepted, 0) > 0 loop
    update public.sales_order_lines set qty_delivered = greatest(qty_delivered - ln.qty_accepted, 0) where id = ln.order_line_id;
  end loop;
  update public.sales_order_exceptions set status = 'resolved', resolved_by = p_user, resolved_at = now(),
    resolution = 'Truck ' || s.document_number || ' voided' where shipment_id = s.id and status = 'open';

  update public.sales_shipments set status = 'voided', voided_at = now(), voided_by = p_user, void_reason = btrim(p_reason) where id = s.id;
  if o.status = 'completed' then
    update public.sales_orders set status = 'in_fulfilment', completed_at = null where id = o.id;
  end if;
  perform public._sales_event(s.company_id, null, o.id, s.id, 'shipment_voided',
    'Truck ' || s.document_number || ' voided (invoice ' || coalesce(sale.document_number, '-') || '): ' || btrim(p_reason), p_user);
  return s.id;
end; $$;

revoke all on function public.void_sales_shipment(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.void_sales_shipment(uuid, uuid, text, text) to service_role;
