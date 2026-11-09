-- =========================================================================
-- Elements ERP - Migration 0058: voiding a trip and correcting its quantity
-- are no longer blocked by purchase landed costs that reached the goods while
-- in transit. Those costs travel with the goods: a void returns the full
-- transit value (goods + costs) to the sending branch; a quantity correction
-- returns its share. Only charges booked on the transfer itself (loading,
-- transport, other) must still be credited first.
-- =========================================================================

create or replace function public.void_transfer_trip(p_dispatch uuid, p_user uuid, p_reason text, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.stock_transfer_dispatches; t public.stock_transfers; dl record; total numeric(18,2) := 0; lb uuid; vd date;
begin
  perform public._require_key(p_idem);
  select * into d from public.stock_transfer_dispatches where id = p_dispatch for update;
  if not found then raise exception 'Dispatch trip not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'void_transfer_trip', p_dispatch) then return p_dispatch; end if;
  select * into t from public.stock_transfers where id = d.transfer_id for update;
  perform public.assert_actor(p_user, t.company_id, 'transactions.void', t.source_branch_id);
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = 'P0001'; end if;
  if d.status = 'draft' then raise exception 'Delete the draft trip instead' using errcode = 'P0001'; end if;
  if d.status <> 'dispatched' or exists (select 1 from public.stock_transfer_dispatch_lines where dispatch_id = d.id and qty_reported > 0) then
    raise exception 'Cargo of this trip was already received; use discrepancy resolution or a return transfer' using errcode = 'P0001'; end if;
  -- Purchase landed costs picked up while in transit return with the goods (transit value);
  -- only this transfer's own charges must be credited first.
  if exists (select 1 from public.cost_sources cs where cs.stock_transfer_id = t.id and cs.status in ('accrued','invoiced')
       and (cs.transfer_dispatch_id is null or cs.transfer_dispatch_id = d.id)) then
    raise exception 'This transfer''s own charges (loading, transport...) were posted on this trip; credit them first' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'void_transfer_trip', p_dispatch) then return p_dispatch; end if;
  vd := (now() at time zone 'Africa/Dar_es_Salaam')::date;
  perform public.assert_period_open(t.company_id, vd);
  for dl in select x.*, l.product_id, l.lot_id from public.stock_transfer_dispatch_lines x join public.stock_transfer_lines l on l.id = x.transfer_line_id
            where x.dispatch_id = d.id order by l.product_id loop
    perform public._stock_in_value(t.company_id, t.source_branch_id, dl.product_id, 'transfer_void', 'stock_transfer', t.id, d.document_number, dl.qty, dl.transit_value, p_user);
    perform public.adjust_in_transit(t.company_id, t.destination_branch_id, dl.product_id, -dl.qty);
    if dl.lot_id is not null then
      update public.stock_lot_balances set quantity = quantity + dl.qty where branch_id = t.source_branch_id and product_id = dl.product_id and lot_id = dl.lot_id;
    end if;
    total := total + dl.transit_value;
  end loop;
  perform public.create_journal(t.company_id, t.source_branch_id, vd, 'stock_transfer_dispatch_void', d.id, d.document_number,
    'Void transfer trip ' || d.document_number, p_user,
    public._jl(public.account_for(t.company_id, 'inventory.standard'), total, 'Returned to stock')
    || public._jl(public.account_for(t.company_id, 'transfer.goods_in_transit'), -total, 'Trip voided'));
  update public.stock_transfer_dispatches set status = 'voided', voided_at = now(), voided_by = p_user, void_reason = trim(p_reason) where id = d.id;
  perform public._transfer_refresh(t.id);
  if not exists (select 1 from public.stock_transfer_dispatches where transfer_id = t.id and status not in ('voided','draft')) then
    update public.stock_transfers set status = 'draft', has_open_discrepancy = false where id = t.id and status <> 'voided';
  end if;
  perform public._transfer_event(t.id, d.id, 'trip_voided', d.document_number || ' voided: ' || trim(p_reason), p_user);
  return p_dispatch;
end; $$;

create or replace function public.change_trip_line_quantity(p_dispatch_line uuid, p_user uuid, p_qty numeric, p_reason text, p_idem text)
returns void language plpgsql security definer set search_path = public as $$
declare
  dl public.stock_transfer_dispatch_lines; d public.stock_transfer_dispatches; t public.stock_transfers; l public.stock_transfer_lines;
  delta numeric; v numeric(18,2); vg numeric(18,2); vd date; sku text; cid uuid; ref text; kgpu numeric; sent_other numeric;
begin
  select * into dl from public.stock_transfer_dispatch_lines where id = p_dispatch_line for update;
  if not found then raise exception 'Trip line not found' using errcode = 'P0001'; end if;
  select * into d from public.stock_transfer_dispatches where id = dl.dispatch_id for update;
  select * into t from public.stock_transfers where id = d.transfer_id for update;
  select * into l from public.stock_transfer_lines where id = dl.transfer_line_id for update;
  -- Users of the sending branch who dispatch transfers, or who may correct their quantities.
  perform public.assert_actor(p_user, t.company_id, 'inventory.transfer_view', t.source_branch_id);
  if not (public._user_can(p_user, 'inventory.transfer_dispatch') or public._user_can(p_user, 'inventory.transfer_quantity')) then
    raise exception 'You are not allowed to change transfer quantities' using errcode = '42501';
  end if;
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
  if exists (select 1 from public.cost_sources cs where cs.stock_transfer_id = t.id and cs.status in ('accrued','invoiced')
       and (cs.transfer_dispatch_id is null or cs.transfer_dispatch_id = d.id)) then
    raise exception 'This transfer''s own charges (loading, transport...) were posted on this trip; credit them first, or void and re-dispatch' using errcode = 'P0001'; end if;
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
    vg := least(round(dl.value * (-delta) / dl.qty, 2), v);
    update public.stock_transfer_dispatch_lines set qty = p_qty, value = value - vg, transit_value = transit_value - v,
      charges_applied = charges_applied - (v - vg) where id = dl.id;
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

revoke all on function public.void_transfer_trip(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.void_transfer_trip(uuid,uuid,text,text) to service_role;
revoke all on function public.change_trip_line_quantity(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.change_trip_line_quantity(uuid, uuid, numeric, text, text) to service_role;
