-- =========================================================================
-- Elements ERP - Migration 0064: transfer orders and loading confirmation.
--  * Branch Manager, CEO, Sales Manager (and the Owner) create the transfer
--    order with every detail: cargo, truck, driver, charges. Store keepers
--    no longer create transfers; they confirm loading (dispatch), which
--    issues the delivery note and the GRN.
--  * An admin (transactions.void) can undo a loading confirmation made by
--    mistake: the dispatch is reversed exactly (stock back to the sending
--    branch, goods in transit cleared, delivery note voided) and the truck
--    returns as an order waiting for loading, with the same details.
-- =========================================================================

-- Who creates transfer orders.
insert into public.role_permissions(role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
 where r.code in ('DIRECTOR', 'SALES_MANAGER', 'CEO') and p.code = 'inventory.transfer_create'
on conflict do nothing;
delete from public.role_permissions rp using public.roles r, public.permissions p
 where rp.role_id = r.id and rp.permission_id = p.id and r.code = 'STOREKEEPER' and p.code = 'inventory.transfer_create';

-- Undo a loading confirmation: void the dispatched trip, then put the same truck
-- and cargo back as a trip waiting for loading. Returns the new trip.
create or replace function public.undo_trip_loading(p_dispatch uuid, p_user uuid, p_reason text, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.stock_transfer_dispatches; nid uuid; nno int; prior uuid;
begin
  perform public._require_key(p_idem);
  select * into d from public.stock_transfer_dispatches where id = p_dispatch for update;
  if not found then raise exception 'Trip not found' using errcode = 'P0001'; end if;
  -- A retry returns the trip created the first time.
  select id into prior from public.stock_transfer_dispatches where client_request_id = 'undo:' || p_idem;
  if prior is not null then return prior; end if;
  if d.status <> 'dispatched' then raise exception 'Only a loaded (dispatched) trip that has not arrived can be undone' using errcode = 'P0001'; end if;
  -- Same checks and postings as voiding the trip (admin permission, nothing received, own charges credited).
  perform public.void_transfer_trip(p_dispatch, p_user, 'Loading confirmation undone: ' || btrim(coalesce(p_reason, '')), p_idem);

  select coalesce(max(trip_no), 0) + 1 into nno from public.stock_transfer_dispatches where transfer_id = d.transfer_id;
  insert into public.stock_transfer_dispatches(company_id, transfer_id, trip_no, status, dispatch_date, expected_arrival_at, driver_name, driver_phone,
      driver_licence, vehicle_registration, trailer_registration, transporter_id, transporter_name, transporter_contact, notes, client_request_id, created_by)
    values (d.company_id, d.transfer_id, nno, 'draft', greatest(d.dispatch_date, (now() at time zone 'Africa/Dar_es_Salaam')::date), d.expected_arrival_at,
      d.driver_name, d.driver_phone, d.driver_licence, d.vehicle_registration, d.trailer_registration, d.transporter_id, d.transporter_name,
      d.transporter_contact, d.notes, 'undo:' || p_idem, p_user)
    returning id into nid;
  insert into public.stock_transfer_dispatch_lines(company_id, dispatch_id, transfer_line_id, qty)
    select company_id, nid, transfer_line_id, qty from public.stock_transfer_dispatch_lines where dispatch_id = d.id;
  -- Charge estimates of the trip move to the new one.
  update public.cost_sources set transfer_dispatch_id = nid where transfer_dispatch_id = d.id and status = 'estimated';
  perform public._transfer_refresh(d.transfer_id);
  perform public._transfer_event(d.transfer_id, nid, 'loading_undone',
    coalesce(d.document_number, 'Trip ' || d.trip_no) || ': loading confirmation undone (' || btrim(coalesce(p_reason, '')) || '). Trip ' || nno || ' waits for loading again.', p_user);
  return nid;
end; $$;

revoke all on function public.undo_trip_loading(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.undo_trip_loading(uuid, uuid, text, text) to service_role;
