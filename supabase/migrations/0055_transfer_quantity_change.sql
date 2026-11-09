-- =========================================================================
-- Elements ERP - Migration 0055: change the quantity on a stock transfer.
--
--  * Requested quantity of a line: any time before the transfer is voided,
--    never below what is already dispatched.
--  * Quantity on a trip: a draft trip just changes; a dispatched trip that
--    has not been received is corrected with stock:
--      less -> the difference returns to the sending branch at its
--              dispatch value (Dr Inventory / Cr Goods in transit)
--      more -> the extra leaves the sending branch at weighted average
--              (Dr Goods in transit / Cr Inventory)
--    goods in transit move with it, the change is kept in the trip history
--    (old -> new, reason) and the delivery note is re-issued as AMENDED.
--  Not for trips with transfer charges already applied or batch-tracked
--  lines (void and re-dispatch those), nor for pre-0030 transfers.
-- =========================================================================

create or replace function public.change_transfer_line_quantity(p_line uuid, p_user uuid, p_qty numeric, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare l public.stock_transfer_lines; t public.stock_transfers; sent numeric; sku text;
begin
  select * into l from public.stock_transfer_lines where id = p_line for update;
  if not found then raise exception 'Transfer line not found' using errcode = 'P0001'; end if;
  select * into t from public.stock_transfers where id = l.transfer_id for update;
  perform public.assert_actor(p_user, t.company_id, 'inventory.transfer_dispatch', t.source_branch_id);
  if t.status = 'voided' then raise exception 'The transfer is voided' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter a quantity above zero' using errcode = '23514'; end if;
  if not t.posts_in_transit and t.status <> 'draft' then
    raise exception 'This transfer was dispatched before the upgrade; its quantities cannot be changed' using errcode = 'P0001';
  end if;
  select coalesce(sum(dl.qty), 0) into sent from public.stock_transfer_dispatch_lines dl join public.stock_transfer_dispatches d on d.id = dl.dispatch_id
   where dl.transfer_line_id = l.id and d.status not in ('voided');
  if p_qty < sent - 0.00005 then
    raise exception 'The quantity cannot go below % already on trips; correct the trip quantity first', sent using errcode = 'P0001';
  end if;
  select p.sku into sku from public.products p where p.id = l.product_id;
  update public.stock_transfer_lines set qty_requested = p_qty where id = l.id;
  perform public._transfer_refresh(t.id);
  perform public._transfer_event(t.id, null, 'quantity_changed',
    sku || ' requested quantity ' || trim(to_char(l.qty_requested, 'FM999999999990.####')) || ' -> ' || trim(to_char(p_qty, 'FM999999999990.####')) || ': ' || btrim(p_reason), p_user);
end; $$;

create or replace function public.change_trip_line_quantity(p_dispatch_line uuid, p_user uuid, p_qty numeric, p_reason text, p_idem text)
returns void language plpgsql security definer set search_path = public as $$
declare
  dl public.stock_transfer_dispatch_lines; d public.stock_transfer_dispatches; t public.stock_transfers; l public.stock_transfer_lines;
  delta numeric; v numeric(18,2); vd date; sku text; cid uuid; ref text; kgpu numeric; sent_other numeric;
begin
  select * into dl from public.stock_transfer_dispatch_lines where id = p_dispatch_line for update;
  if not found then raise exception 'Trip line not found' using errcode = 'P0001'; end if;
  select * into d from public.stock_transfer_dispatches where id = dl.dispatch_id for update;
  select * into t from public.stock_transfers where id = d.transfer_id for update;
  select * into l from public.stock_transfer_lines where id = dl.transfer_line_id for update;
  perform public.assert_actor(p_user, t.company_id, 'inventory.transfer_dispatch', t.source_branch_id);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter a quantity above zero (void the trip to send nothing)' using errcode = '23514'; end if;
  if t.status = 'voided' or d.status = 'voided' then raise exception 'The trip is voided' using errcode = 'P0001'; end if;
  delta := p_qty - dl.qty;
  if abs(delta) < 0.00005 then return; end if;
  select p.sku into sku from public.products p where p.id = l.product_id;

  -- Never more on trips than requested: the requested quantity follows an increase.
  select coalesce(sum(x.qty), 0) into sent_other from public.stock_transfer_dispatch_lines x join public.stock_transfer_dispatches y on y.id = x.dispatch_id
   where x.transfer_line_id = l.id and y.status <> 'voided' and x.id <> dl.id;
  if sent_other + p_qty > l.qty_requested + 0.00005 then
    update public.stock_transfer_lines set qty_requested = sent_other + p_qty where id = l.id;
  end if;

  if d.status = 'draft' then
    update public.stock_transfer_dispatch_lines set qty = p_qty where id = dl.id;
    perform public._transfer_event(t.id, d.id, 'quantity_changed',
      'Trip ' || d.trip_no || ' (draft) ' || sku || ' ' || trim(to_char(dl.qty, 'FM999999999990.####')) || ' -> ' || trim(to_char(p_qty, 'FM999999999990.####')) || ': ' || btrim(p_reason), p_user);
    return;
  end if;

  if d.status <> 'dispatched' or dl.qty_reported > 0 or exists (select 1 from public.stock_transfer_receipt_lines rl join public.stock_transfer_receipts r on r.id = rl.receipt_id
       where r.dispatch_id = d.id) then
    raise exception 'Goods of this trip were already received; use discrepancy resolution or a return transfer' using errcode = 'P0001';
  end if;
  if dl.charges_applied <> 0 then raise exception 'Transfer charges were applied to this trip; credit them first, or void and re-dispatch' using errcode = 'P0001'; end if;
  if l.lot_id is not null then raise exception 'Batch-tracked goods: void the trip and dispatch it again with the right quantity' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'change_trip_line_quantity', p_dispatch_line) then return; end if;
  vd := (now() at time zone 'Africa/Dar_es_Salaam')::date;
  perform public.assert_period_open(t.company_id, vd);
  ref := coalesce(d.document_number, coalesce(t.document_number, 'TRF') || '-T' || d.trip_no);
  perform public.lock_stock_balances(t.company_id, jsonb_build_array(
    jsonb_build_object('branch_id', t.source_branch_id, 'product_id', l.product_id),
    jsonb_build_object('branch_id', t.destination_branch_id, 'product_id', l.product_id)));

  insert into public.stock_transfer_dispatch_changes(company_id, dispatch_id, old_values, new_values, reason, changed_by)
    values (t.company_id, d.id, jsonb_build_object('quantity ' || sku, trim(to_char(dl.qty, 'FM999999999990.####'))),
      jsonb_build_object('quantity ' || sku, trim(to_char(p_qty, 'FM999999999990.####'))), btrim(p_reason), p_user)
    returning id into cid;

  if delta < 0 then
    -- Not loaded after all: the difference returns at its share of the trip value.
    v := round(dl.transit_value * (-delta) / dl.qty, 2);
    perform public._stock_in_value(t.company_id, t.source_branch_id, l.product_id, 'transfer_void', 'stock_transfer', t.id, ref, -delta, v, p_user);
    perform public.adjust_in_transit(t.company_id, t.destination_branch_id, l.product_id, delta);
    perform public.create_journal(t.company_id, t.source_branch_id, vd, 'stock_transfer_qty_change', cid, ref,
      'Trip ' || ref || ': ' || sku || ' reduced by ' || trim(to_char(-delta, 'FM999999999990.####')), p_user,
      public._jl(public.account_for(t.company_id, 'inventory.standard'), v, 'Returned to stock')
      || public._jl(public.account_for(t.company_id, 'transfer.goods_in_transit'), -v, 'Trip quantity reduced'));
    update public.stock_transfer_dispatch_lines set qty = p_qty, value = value - least(v, value), transit_value = transit_value - v where id = dl.id;
  else
    -- More was loaded: the extra leaves the sending branch at weighted average.
    v := public._stock_out_avg(t.company_id, t.source_branch_id, l.product_id, 'transfer_out', 'stock_transfer', t.id, ref, delta, p_user);
    perform public.adjust_in_transit(t.company_id, t.destination_branch_id, l.product_id, delta);
    perform public.create_journal(t.company_id, t.source_branch_id, vd, 'stock_transfer_qty_change', cid, ref,
      'Trip ' || ref || ': ' || sku || ' increased by ' || trim(to_char(delta, 'FM999999999990.####')), p_user,
      public._jl(public.account_for(t.company_id, 'transfer.goods_in_transit'), v, 'Trip quantity increased')
      || public._jl(public.account_for(t.company_id, 'inventory.standard'), -v, 'Stock dispatched'));
    update public.stock_transfer_dispatch_lines set qty = p_qty, value = value + v, transit_value = transit_value + v where id = dl.id;
  end if;
  kgpu := coalesce(l.kg_per_unit, public._kg_per_unit(l.product_id));
  update public.stock_transfer_dispatch_lines set net_kg = case when kgpu is null then null else round(p_qty * kgpu, 4) end where id = dl.id;

  perform public._transfer_refresh(t.id);
  perform public._transfer_event(t.id, d.id, 'quantity_changed',
    'Trip ' || ref || ' ' || sku || ' ' || trim(to_char(dl.qty, 'FM999999999990.####')) || ' -> ' || trim(to_char(p_qty, 'FM999999999990.####')) || ': ' || btrim(p_reason), p_user);
  if d.delivery_note_number is not null then perform public.issue_delivery_note(d.id, p_user); end if;
end; $$;

revoke all on function public.change_transfer_line_quantity(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.change_transfer_line_quantity(uuid, uuid, numeric, text) to service_role;
revoke all on function public.change_trip_line_quantity(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.change_trip_line_quantity(uuid, uuid, numeric, text, text) to service_role;
