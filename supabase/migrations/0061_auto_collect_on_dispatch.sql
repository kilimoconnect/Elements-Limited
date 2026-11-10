-- =========================================================================
-- Elements ERP - Migration 0061: for orders the customer collects, dispatch
-- also records the truck as collected (the collector takes the goods at the
-- gate; full quantity accepted), so the order completes without a separate
-- step. Deliveries by our trucks still need delivery confirmation.
-- Trucks already dispatched on collection orders are completed the same way.
-- =========================================================================

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
  -- Customer collects: the collector takes the goods at dispatch, so the truck is collected now
  -- (full quantity accepted) and the order completes once every truck is done.
  if o.fulfilment_mode = 'collection' then
    perform public.record_shipment_delivery(s.id, p_user, jsonb_build_object(
      'recipient_name', coalesce(nullif(btrim(s.collector_name), ''), nullif(btrim(s.driver_name), ''), 'Collector'),
      'recipient_phone', coalesce(s.collector_phone, s.driver_phone),
      'notes', 'Collected at dispatch'));
  end if;
  return sid;
end; $$;

revoke all on function public.dispatch_sales_shipment(uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.dispatch_sales_shipment(uuid,uuid,text,boolean) to service_role;

-- Trucks already dispatched on collection orders: collected now, by whoever dispatched them.
do $$
declare s record;
begin
  for s in select sh.* from public.sales_shipments sh join public.sales_orders o on o.id = sh.order_id
            where o.fulfilment_mode = 'collection' and sh.status = 'dispatched' and sh.dispatched_by is not null loop
    perform public.record_shipment_delivery(s.id, s.dispatched_by, jsonb_build_object(
      'recipient_name', coalesce(nullif(btrim(s.collector_name), ''), nullif(btrim(s.driver_name), ''), 'Collector'),
      'recipient_phone', coalesce(s.collector_phone, s.driver_phone),
      'notes', 'Collected at dispatch',
      'delivered_at', s.dispatched_at));
  end loop;
end $$;
