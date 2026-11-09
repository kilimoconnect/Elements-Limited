-- =========================================================================
-- Elements ERP - Migration 0057: lowering the requested quantity below what
-- is loaded corrects the latest trips that are not yet received (same rules
-- and postings as change_trip_line_quantity), instead of refusing.
-- =========================================================================

create or replace function public.change_transfer_line_quantity(p_line uuid, p_user uuid, p_qty numeric, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare l public.stock_transfer_lines; t public.stock_transfers; sent numeric; sku text; over numeric; tl record; take numeric;
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
  select p.sku into sku from public.products p where p.id = l.product_id;
  update public.stock_transfer_lines set qty_requested = p_qty where id = l.id;
  perform public._transfer_refresh(t.id);
  perform public._transfer_event(t.id, null, 'quantity_changed',
    sku || ' requested quantity ' || trim(to_char(l.qty_requested, 'FM999999999990.####')) || ' -> ' || trim(to_char(p_qty, 'FM999999999990.####')) || ': ' || btrim(p_reason), p_user);
end; $$;

revoke all on function public.change_transfer_line_quantity(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.change_transfer_line_quantity(uuid, uuid, numeric, text) to service_role;
