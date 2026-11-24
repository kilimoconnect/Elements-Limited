-- =========================================================================
-- Elements ERP - Migration 0067: void a transfer receipt (cargo received at
-- the receiving branch by mistake). The exact reverse of receiving:
--   * goods accepted into stock leave the receiving branch at the value
--     they came in with and go back into goods in transit
--     (Dr 1155 Goods in transit / Cr 1150 Inventory),
--   * the trip's received / damaged / short quantities are undone, so the
--     truck is "in transit" again and can be received correctly,
--   * the receipt is kept, marked voided with the reason; its lines can no
--     longer be resolved, and it no longer blocks trip corrections.
-- Needs transactions.void at the receiving branch. Refused when its
-- damaged / short cargo was already decided, or when the goods are no
-- longer in stock there (sold or moved).
-- =========================================================================

alter table public.stock_transfer_receipts add column if not exists voided_at timestamptz;
alter table public.stock_transfer_receipts add column if not exists voided_by uuid references auth.users(id) on delete set null;
alter table public.stock_transfer_receipts add column if not exists void_reason text;

create or replace function public.void_transfer_receipt(p_receipt uuid, p_user uuid, p_reason text, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r public.stock_transfer_receipts; t public.stock_transfers; d public.stock_transfer_dispatches; rl record; v numeric(18,2);
  total numeric(18,2) := 0; vd date; keys jsonb; summary text := '';
begin
  perform public._require_key(p_idem);
  select * into r from public.stock_transfer_receipts where id = p_receipt for update;
  if not found then raise exception 'Receipt not found' using errcode = 'P0001'; end if;
  if r.voided_at is not null then return r.id; end if;
  select * into t from public.stock_transfers where id = r.transfer_id for update;
  perform public.assert_actor(p_user, t.company_id, 'transactions.void', t.destination_branch_id);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  if not t.posts_in_transit or r.dispatch_id is null then
    raise exception 'This receipt was recorded before the upgrade and cannot be voided here' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.stock_transfer_receipt_lines where receipt_id = r.id
             and (qty_released > 0 or qty_resolved_short > 0 or qty_resolved_damaged > 0 or resolution is not null)) then
    raise exception 'Damaged or short cargo on this receipt was already decided; it cannot be voided' using errcode = 'P0001';
  end if;
  if not public.claim_idempotency(p_idem, 'void_transfer_receipt', p_receipt) then return r.id; end if;
  select * into d from public.stock_transfer_dispatches where id = r.dispatch_id for update;
  vd := (now() at time zone 'Africa/Dar_es_Salaam')::date;
  perform public.assert_period_open(t.company_id, vd);
  select jsonb_agg(jsonb_build_object('branch_id', t.destination_branch_id, 'product_id', l.product_id)) into keys
    from public.stock_transfer_receipt_lines x join public.stock_transfer_lines l on l.id = x.transfer_line_id where x.receipt_id = r.id;
  perform public.lock_stock_balances(t.company_id, keys);

  for rl in select x.*, l.product_id, l.lot_id, p.name pname from public.stock_transfer_receipt_lines x
            join public.stock_transfer_lines l on l.id = x.transfer_line_id join public.products p on p.id = l.product_id
            where x.receipt_id = r.id order by l.product_id loop
    v := 0;
    if rl.qty_received > 0 then
      -- Leaves the receiving branch at the value it came in with ("Insufficient stock" when already sold or moved).
      v := public._stock_out_value(t.company_id, t.destination_branch_id, rl.product_id, 'transfer_void', 'stock_transfer', t.id,
        r.document_number, rl.qty_received, rl.value, p_user);
      if rl.lot_id is not null then
        update public.stock_lot_balances set quantity = quantity - rl.qty_received
         where branch_id = t.destination_branch_id and product_id = rl.product_id and lot_id = rl.lot_id;
      end if;
      total := total + v;
    end if;
    update public.stock_transfer_dispatch_lines set
      qty_reported = greatest(qty_reported - rl.qty_received - rl.qty_damaged - rl.qty_short, 0),
      qty_accepted = greatest(qty_accepted - rl.qty_received, 0), qty_quarantined = greatest(qty_quarantined - rl.qty_damaged, 0),
      qty_short = greatest(qty_short - rl.qty_short, 0), transit_value = transit_value + v, received_value = greatest(received_value - v, 0)
     where id = rl.dispatch_line_id;
    perform public.adjust_in_transit(t.company_id, t.destination_branch_id, rl.product_id, rl.qty_received + rl.qty_damaged + rl.qty_short);
    summary := summary || case when summary = '' then '' else '; ' end || rl.pname || ' ' || rl.qty_received::numeric(18,2) || ' back in transit';
  end loop;
  if total > 0 then
    perform public.create_journal(t.company_id, t.destination_branch_id, vd, 'stock_transfer_receipt_void', r.id, r.document_number,
      'Void transfer receipt ' || r.document_number || ': ' || btrim(p_reason), p_user,
      public._jl(public.account_for(t.company_id, 'transfer.goods_in_transit'), total, 'Back in transit')
      || public._jl(public.account_for(t.company_id, 'inventory.standard'), -total, 'Receipt voided'));
  end if;

  update public.stock_transfer_receipts set voided_at = now(), voided_by = p_user, void_reason = btrim(p_reason) where id = r.id;
  update public.stock_transfer_dispatches set
    status = case when exists (select 1 from public.stock_transfer_dispatch_lines where dispatch_id = d.id and qty_reported > 0) then 'arrived' else 'dispatched' end,
    arrived_at = case when exists (select 1 from public.stock_transfer_receipts where dispatch_id = d.id and voided_at is null) then arrived_at else null end
   where id = d.id;
  perform public._transfer_refresh(t.id);
  perform public._transfer_event(t.id, d.id, 'receipt_voided', r.document_number || ' voided (' || btrim(p_reason) || '): ' || summary, p_user);
  return r.id;
end; $$;

revoke all on function public.void_transfer_receipt(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.void_transfer_receipt(uuid, uuid, text, text) to service_role;

-- A voided receipt's lines cannot be resolved (released, written off, found...).
create or replace function public._receipt_line_not_voided()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.stock_transfer_receipts where id = new.receipt_id and voided_at is not null) then
    raise exception 'This receipt was voided; receive the truck again instead' using errcode = 'P0001';
  end if;
  return new;
end; $$;
drop trigger if exists trg_receipt_line_not_voided on public.stock_transfer_receipt_lines;
create trigger trg_receipt_line_not_voided before update on public.stock_transfer_receipt_lines
  for each row execute function public._receipt_line_not_voided();
revoke all on function public._receipt_line_not_voided() from public, anon, authenticated;

-- A voided receipt no longer blocks correcting the trip quantity.
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
       where r.dispatch_id = d.id and r.voided_at is null) then
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

revoke all on function public.change_trip_line_quantity(uuid, uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.change_trip_line_quantity(uuid, uuid, numeric, text, text) to service_role;

-- Resolving damaged / short cargo of a voided receipt is refused with a clear message.
create or replace function public.resolve_transfer_discrepancy(
  p_receipt_line uuid, p_kind text, p_resolution text, p_qty numeric, p_notes text, p_user uuid, p_idem text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  rl public.stock_transfer_receipt_lines; r public.stock_transfer_receipts; t public.stock_transfers; dl public.stock_transfer_dispatch_lines;
  l public.stock_transfer_lines; p public.products; open_qty numeric; v numeric(18,2); mid uuid; jl jsonb; res uuid; d date; unabs numeric(18,2);
  allowed numeric; gl1155 uuid; gl1150 uuid;
begin
  perform public._require_key(p_idem);
  select * into rl from public.stock_transfer_receipt_lines where id = p_receipt_line for update;
  if not found then raise exception 'Receipt line not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'resolve_transfer_discrepancy', p_receipt_line) then return p_receipt_line; end if;
  select * into r from public.stock_transfer_receipts where id = rl.receipt_id;
  if r.voided_at is not null then raise exception 'This receipt was voided; receive the truck again instead' using errcode = 'P0001'; end if;
  select * into t from public.stock_transfers where id = r.transfer_id for update;
  perform public.assert_actor(p_user, t.company_id, case when p_resolution = 'found' then 'inventory.transfer_receive' else 'inventory.transfer_resolve' end,
    t.destination_branch_id);
  if p_kind not in ('quarantine','short') then raise exception 'Unknown discrepancy kind' using errcode = 'P0001'; end if;
  if (p_kind = 'quarantine' and p_resolution not in ('release','normal_loss','write_off','claim'))
     or (p_kind = 'short' and p_resolution not in ('found','normal_loss','write_off','claim')) then
    raise exception 'Resolution % does not apply to % cargo', p_resolution, p_kind using errcode = 'P0001'; end if;
  open_qty := case when p_kind = 'quarantine' then rl.qty_damaged - rl.qty_released - rl.qty_resolved_damaged
                   else rl.qty_short - rl.qty_resolved_short end;
  if p_qty is null or p_qty <= 0 or p_qty > open_qty then
    raise exception 'Only % is open on this line', open_qty using errcode = 'P0001'; end if;
  select * into dl from public.stock_transfer_dispatch_lines where id = rl.dispatch_line_id for update;
  select * into l from public.stock_transfer_lines where id = dl.transfer_line_id;
  select * into p from public.products where id = l.product_id;
  if p_resolution = 'normal_loss' then
    allowed := round(dl.qty * p.transfer_loss_tolerance_pct / 100, 4);
    if dl.qty_lost_normal + p_qty > allowed then
      raise exception 'Normal loss would exceed the % %% tolerance (% allowed on this trip line); write it off or claim it',
        p.transfer_loss_tolerance_pct, allowed - dl.qty_lost_normal using errcode = 'P0001'; end if;
  end if;
  if not public.claim_idempotency(p_idem, 'resolve_transfer_discrepancy', p_receipt_line) then return p_receipt_line; end if;
  d := (now() at time zone 'Africa/Dar_es_Salaam')::date;
  perform public.assert_period_open(t.company_id, d);
  perform public.lock_stock_balances(t.company_id, jsonb_build_array(jsonb_build_object('branch_id', t.destination_branch_id, 'product_id', l.product_id)));
  gl1155 := public.account_for(t.company_id, 'transfer.goods_in_transit'); gl1150 := public.account_for(t.company_id, 'inventory.standard');
  v := public._tdl_take(dl.id, p_qty);
  if p_resolution in ('release','found') then
    mid := public._stock_in_value(t.company_id, t.destination_branch_id, l.product_id, 'transfer_in', 'stock_transfer', t.id, r.document_number, p_qty, v, p_user);
    jl := public._jl(gl1150, v, case when p_resolution = 'release' then 'Released from quarantine' else 'Short cargo arrived' end) || public._jl(gl1155, -v, 'Out of transit');
    update public.stock_transfer_dispatch_lines set qty_accepted = qty_accepted + p_qty, received_value = received_value + v, transit_value = transit_value - v,
      qty_quarantined = qty_quarantined - case when p_kind = 'quarantine' then p_qty else 0 end,
      qty_short = qty_short - case when p_kind = 'short' then p_qty else 0 end where id = dl.id;
  elsif p_resolution = 'normal_loss' then
    unabs := public._stock_value_adjust(t.company_id, t.destination_branch_id, l.product_id, v, 'stock_transfer', t.id, r.document_number, p_user);
    jl := public._jl(gl1150, v - unabs, 'Normal transit loss absorbed') || public._jl(public.account_for(t.company_id, 'inventory.cost_of_sales'), unabs, 'Normal transit loss (no stock left)')
       || public._jl(gl1155, -v, 'Out of transit');
    update public.stock_transfer_dispatch_lines set qty_lost_normal = qty_lost_normal + p_qty, received_value = received_value + v, transit_value = transit_value - v,
      qty_quarantined = qty_quarantined - case when p_kind = 'quarantine' then p_qty else 0 end,
      qty_short = qty_short - case when p_kind = 'short' then p_qty else 0 end where id = dl.id;
  else
    jl := public._jl(public.account_for(t.company_id, case when p_resolution = 'claim' then 'import.claims_receivable' else 'inventory.loss' end), v,
            case when p_resolution = 'claim' then 'Transit claim' else 'Transit loss written off' end)
       || public._jl(gl1155, -v, 'Out of transit');
    update public.stock_transfer_dispatch_lines set qty_lost_abnormal = qty_lost_abnormal + p_qty, lost_value = lost_value + v, transit_value = transit_value - v,
      qty_quarantined = qty_quarantined - case when p_kind = 'quarantine' then p_qty else 0 end,
      qty_short = qty_short - case when p_kind = 'short' then p_qty else 0 end where id = dl.id;
  end if;
  insert into public.stock_transfer_resolutions(company_id, receipt_line_id, kind, resolution, qty, value, movement_id, notes, approved_by)
    values (t.company_id, rl.id, p_kind, p_resolution, p_qty, v, mid, p_notes, p_user) returning id into res;
  update public.stock_transfer_receipt_lines set
    qty_released = qty_released + case when p_kind = 'quarantine' and p_resolution = 'release' then p_qty else 0 end,
    qty_resolved_damaged = qty_resolved_damaged + case when p_kind = 'quarantine' and p_resolution <> 'release' then p_qty else 0 end,
    qty_resolved_short = qty_resolved_short + case when p_kind = 'short' then p_qty else 0 end
    where id = rl.id;
  perform public.create_journal(t.company_id, t.destination_branch_id, d, 'stock_transfer_resolution', res, r.document_number,
    'Transfer ' || p_kind || ' ' || replace(p_resolution, '_', ' ') || ' ' || r.document_number, p_user, jl);
  perform public._transfer_refresh(t.id);
  perform public._transfer_event(t.id, dl.dispatch_id, 'resolution', p.name || ': ' || p_qty::numeric(18,2) || ' ' || p_kind || ' → ' || replace(p_resolution, '_', ' ')
    || coalesce(' · ' || nullif(p_notes, ''), ''), p_user);
  return res;
end; $$;

revoke all on function public.resolve_transfer_discrepancy(uuid, text, text, numeric, text, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_transfer_discrepancy(uuid, text, text, numeric, text, uuid, text) to service_role;
