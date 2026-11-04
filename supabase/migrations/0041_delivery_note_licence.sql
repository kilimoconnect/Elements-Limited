-- =========================================================================
-- Elements ERP - Migration 0041: driver's licence number on delivery notes
--
-- The delivery note now shows every driver detail, including the licence
-- number (previously left out). Licence PHOTOS stay restricted. A trip whose
-- note is issued again gets a new version that includes the licence.
-- =========================================================================

-- Same snapshot as 0038 plus the driver's licence number.
create or replace function public.delivery_note_snapshot(p_dispatch uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'company', jsonb_build_object('name', c.name, 'legal_name', c.legal_name, 'address', c.address, 'phone', c.phone, 'email', c.email),
    'delivery_note_number', d.delivery_note_number,
    'transfer_number', t.document_number, 'reference', coalesce(d.document_number, coalesce(t.document_number, 'DRAFT') || '-T' || d.trip_no),
    'trip_no', d.trip_no, 'status', d.status, 'transfer_date', t.transfer_date, 'dispatch_date', d.dispatch_date,
    'dispatched_at', d.dispatched_at, 'expected_arrival_at', d.expected_arrival_at,
    'sender', jsonb_build_object('code', sb.code, 'name', sb.name, 'address', sb.address, 'phone', sb.phone, 'location', t.source_location),
    'receiver', jsonb_build_object('code', db.code, 'name', db.name, 'address', db.address, 'phone', db.phone, 'location', t.destination_location),
    'driver', jsonb_build_object('name', d.driver_name, 'phone', d.driver_phone, 'licence', d.driver_licence),
    'vehicle', jsonb_build_object('registration', d.vehicle_registration, 'trailer', d.trailer_registration),
    'transporter', jsonb_build_object('name', coalesce(d.transporter_name, tr.name), 'contact', d.transporter_contact),
    'agents', coalesce((select jsonb_agg(jsonb_build_object('name', a.name, 'company', a.company_name, 'phone', a.phone, 'role', a.role) order by a.created_at, a.id)
                        from public.stock_transfer_agents a where a.transfer_id = t.id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('sku', p.sku, 'name', p.name, 'unit', u.code, 'qty', x.qty,
                         'net_kg', coalesce(x.net_kg, round(x.qty * public._kg_per_unit(p.id), 4)), 'batch', l.batch_reference) order by l.line_no, l.id)
                       from public.stock_transfer_dispatch_lines x join public.stock_transfer_lines l on l.id = x.transfer_line_id
                       join public.products p on p.id = l.product_id left join public.units u on u.id = p.base_unit_id
                       where x.dispatch_id = d.id), '[]'::jsonb),
    'notes', d.notes)
  from public.stock_transfer_dispatches d join public.stock_transfers t on t.id = d.transfer_id
  join public.companies c on c.id = t.company_id join public.branches sb on sb.id = t.source_branch_id
  join public.branches db on db.id = t.destination_branch_id left join public.suppliers tr on tr.id = d.transporter_id
  where d.id = p_dispatch;
$$;

revoke all on function public.delivery_note_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.delivery_note_snapshot(uuid) to service_role;
