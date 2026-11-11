-- =========================================================================
-- Elements ERP - Migration 0063: requested and loaded are one quantity.
--  * Changing the quantity on a trip changes the requested quantity by the
--    same amount (before: only an increase above requested was followed).
--  * Raising the requested quantity of a fully loaded line puts the extra on
--    the latest trip not yet received (before: only requested changed).
--  * Lowering requested still takes it off what is not yet loaded first, then
--    off the latest trips not yet received (0057).
-- =========================================================================

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

  -- Requested and loaded are one quantity: the requested quantity moves with the trip
  -- (what is still to be loaded on later trips stays the same).
  select coalesce(sum(x.qty), 0) into sent_other from public.stock_transfer_dispatch_lines x join public.stock_transfer_dispatches y on y.id = x.dispatch_id
   where x.transfer_line_id = l.id and y.status <> 'voided' and x.id <> dl.id;
  update public.stock_transfer_lines set qty_requested = greatest(l.qty_requested + delta, sent_other + p_qty) where id = l.id;

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

create or replace function public.change_transfer_line_quantity(p_line uuid, p_user uuid, p_qty numeric, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare l public.stock_transfer_lines; t public.stock_transfers; sent numeric; sku text; over numeric; tl record; take numeric; latest record;
begin
  select * into l from public.stock_transfer_lines where id = p_line for update;
  if not found then raise exception 'Transfer line not found' using errcode = 'P0001'; end if;
  select * into t from public.stock_transfers where id = l.transfer_id for update;
  -- Users of the sending branch who dispatch transfers, or who may correct their quantities.
  perform public.assert_actor(p_user, t.company_id, 'inventory.transfer_view', t.source_branch_id);
  if not (public._user_can(p_user, 'inventory.transfer_dispatch') or public._user_can(p_user, 'inventory.transfer_quantity')) then
    raise exception 'You are not allowed to change transfer quantities' using errcode = '42501';
  end if;
  if t.status = 'voided' then raise exception 'The transfer is voided' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter a quantity above zero' using errcode = '23514'; end if;
  if not t.posts_in_transit and t.status <> 'draft' then
    raise exception 'This transfer was dispatched before the upgrade; its quantities cannot be changed' using errcode = 'P0001';
  end if;
  select coalesce(sum(dl.qty), 0) into sent from public.stock_transfer_dispatch_lines dl join public.stock_transfer_dispatches d on d.id = dl.dispatch_id
   where dl.transfer_line_id = l.id and d.status not in ('voided');
  if p_qty < sent - 0.00005 then
    -- Less than is already loaded: take the difference off the latest trips not yet received
    -- (stock returns to the sending branch; the delivery note is re-issued as AMENDED).
    over := sent - p_qty;
    for tl in select x.id, x.qty, d.trip_no, d.status from public.stock_transfer_dispatch_lines x join public.stock_transfer_dispatches d on d.id = x.dispatch_id
               where x.transfer_line_id = l.id and d.status in ('draft','dispatched') and x.qty_reported = 0
               order by d.trip_no desc loop
      exit when over <= 0.00005;
      take := least(over, tl.qty);
      if tl.qty - take <= 0.00005 then
        raise exception 'This would take everything off trip % (%); void that trip instead', tl.trip_no, trim(to_char(tl.qty, 'FM999999999990.####')) using errcode = 'P0001';
      end if;
      perform public.change_trip_line_quantity(tl.id, p_user, tl.qty - take, btrim(p_reason), gen_random_uuid()::text);
      over := over - take;
    end loop;
    if over > 0.00005 then
      raise exception 'Only % can be taken off trips that are not yet received; the rest has arrived',
        trim(to_char(sent - p_qty - over, 'FM999999999990.####')) using errcode = 'P0001';
    end if;
  end if;
  if p_qty > l.qty_requested + 0.00005 and sent >= l.qty_requested - 0.00005 then
    -- Everything requested is already loaded: the extra goes on the latest trip not yet
    -- received, so requested and loaded stay the same quantity.
    select x.id, x.qty into latest from public.stock_transfer_dispatch_lines x join public.stock_transfer_dispatches d on d.id = x.dispatch_id
     where x.transfer_line_id = l.id and d.status in ('draft','dispatched') and x.qty_reported = 0
     order by d.trip_no desc limit 1;
    if found then
      perform public.change_trip_line_quantity(latest.id, p_user, latest.qty + (p_qty - l.qty_requested), btrim(p_reason), gen_random_uuid()::text);
    end if;
  end if;
  select p.sku into sku from public.products p where p.id = l.product_id;
  update public.stock_transfer_lines set qty_requested = p_qty where id = l.id;
  perform public._transfer_refresh(t.id);
  perform public._transfer_event(t.id, null, 'quantity_changed',
    sku || ' requested quantity ' || trim(to_char(l.qty_requested, 'FM999999999990.####')) || ' -> ' || trim(to_char(p_qty, 'FM999999999990.####')) || ': ' || btrim(p_reason), p_user);
end; $$;

revoke all on function public.change_trip_line_quantity(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.change_trip_line_quantity(uuid, uuid, numeric, text, text) to service_role;
revoke all on function public.change_transfer_line_quantity(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.change_transfer_line_quantity(uuid, uuid, numeric, text) to service_role;
