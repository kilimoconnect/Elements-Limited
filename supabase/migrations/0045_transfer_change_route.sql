-- =========================================================================
-- Elements ERP - Migration 0045: change the route (destination branch) of a
-- stock transfer. Only the destination changes; lines, trips, trucks,
-- drivers, costs, numbers and journals stay as they are.
--
-- Allowed while nothing has been received: a draft, or a dispatched transfer
-- whose trucks have not arrived. For dispatched goods the in-transit quantity
-- moves from the old destination to the new one, and each trip's delivery
-- note gets a new version showing the new destination (same DN number).
-- =========================================================================

create or replace function public.change_transfer_destination(p_transfer uuid, p_user uuid, p_destination uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare t public.stock_transfers; nb public.branches; old_code text; l record; d record;
begin
  select * into t from public.stock_transfers where id = p_transfer for update;
  if not found then raise exception 'Transfer not found' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, t.company_id, 'inventory.transfer_dispatch', t.source_branch_id);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '23514'; end if;
  if t.status not in ('draft', 'dispatched') then
    raise exception 'The route can only be changed before anything is received (this transfer is %)', replace(t.status, '_', ' ') using errcode = 'P0001';
  end if;
  if exists (select 1 from public.stock_transfer_receipts where transfer_id = t.id)
     or exists (select 1 from public.stock_transfer_dispatches where transfer_id = t.id and status in ('arrived', 'received')) then
    raise exception 'Goods on this transfer have already arrived or been received; the route cannot be changed' using errcode = 'P0001';
  end if;
  select * into nb from public.branches where id = p_destination;
  if nb.id is null or nb.company_id <> t.company_id or not nb.is_active then raise exception 'Choose an active branch' using errcode = 'P0001'; end if;
  if nb.id = t.source_branch_id then raise exception 'The destination cannot be the sending branch' using errcode = 'P0001'; end if;
  if nb.id = t.destination_branch_id then return; end if;
  select code into old_code from public.branches where id = t.destination_branch_id;

  -- Goods already on the road are now in transit to the new branch.
  for l in select product_id, sum(qty_dispatched) q from public.stock_transfer_lines where transfer_id = t.id and qty_dispatched > 0 group by product_id loop
    perform public.lock_stock_balances(t.company_id, jsonb_build_array(
      jsonb_build_object('branch_id', t.destination_branch_id, 'product_id', l.product_id),
      jsonb_build_object('branch_id', nb.id, 'product_id', l.product_id)));
    perform public.adjust_in_transit(t.company_id, t.destination_branch_id, l.product_id, -l.q);
    perform public.adjust_in_transit(t.company_id, nb.id, l.product_id, l.q);
  end loop;

  update public.stock_transfers set destination_branch_id = nb.id, updated_by = p_user, updated_at = now() where id = t.id;
  perform public._transfer_event(t.id, null, 'route_changed', 'Route changed from ' || old_code || ' to ' || nb.code || ': ' || btrim(p_reason), p_user);

  -- Issued delivery notes are re-issued (same number, new version) with the new destination.
  for d in select id from public.stock_transfer_dispatches where transfer_id = t.id and delivery_note_number is not null and status <> 'voided' loop
    perform public.issue_delivery_note(d.id, p_user);
  end loop;
end; $$;

revoke all on function public.change_transfer_destination(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.change_transfer_destination(uuid, uuid, uuid, text) to service_role;
