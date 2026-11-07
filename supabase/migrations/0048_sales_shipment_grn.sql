-- =========================================================================
-- Elements ERP - Migration 0048: GRNs for sales dispatched from Head Office,
-- the same way as transfers: one GRN per supplier of the goods on a truck
-- (supplier = latest posted purchase of the product), numbered from the GRN
-- sequence on the first download and kept. Head Office users only; posts
-- nothing.
-- =========================================================================

create table if not exists public.sales_shipment_grns (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  shipment_id     uuid not null references public.sales_shipments(id) on delete restrict,
  supplier_id     uuid references public.suppliers(id) on delete restrict,
  document_number text not null,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create unique index if not exists sales_shipment_grns_docnum on public.sales_shipment_grns(company_id, document_number);
create unique index if not exists sales_shipment_grns_one_per_supplier
  on public.sales_shipment_grns(shipment_id, coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.sales_shipment_grns enable row level security;
alter table public.sales_shipment_grns force row level security;
drop policy if exists sales_shipment_grns_select on public.sales_shipment_grns;
create policy sales_shipment_grns_select on public.sales_shipment_grns for select to authenticated using (public.has_company_access(company_id));
revoke all on public.sales_shipment_grns from anon, authenticated;
grant select on public.sales_shipment_grns to authenticated;
grant select, insert, update, delete on public.sales_shipment_grns to service_role;

-- The supplier behind each line of a truck (null when no posted purchase exists).
create or replace function public.sales_shipment_line_suppliers(p_shipment uuid)
returns table(shipment_line_id uuid, supplier_id uuid)
language sql stable security definer set search_path = public as $$
  select sl.id,
    (select p.supplier_id from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
      where pl.product_id = ol.product_id and p.company_id = s.company_id and p.document_status = 'posted'
      order by p.document_date desc, p.posted_at desc nulls last limit 1)
  from public.sales_shipment_lines sl
  join public.sales_order_lines ol on ol.id = sl.order_line_id
  join public.sales_shipments s on s.id = sl.shipment_id
  where sl.shipment_id = p_shipment and sl.qty_dispatched > 0;
$$;

create or replace function public.issue_sales_shipment_grn(p_shipment uuid, p_supplier uuid, p_user uuid)
returns text language plpgsql security definer set search_path = public as $$
declare s public.sales_shipments; num text; hq uuid;
begin
  select * into s from public.sales_shipments where id = p_shipment;
  if not found then raise exception 'Truck not found' using errcode = 'P0001'; end if;
  select id into hq from public.branches where company_id = s.company_id and is_head_office order by created_at limit 1;
  if hq is null or s.branch_id <> hq then raise exception 'GRNs are issued for sales dispatched from Head Office' using errcode = 'P0001'; end if;
  if not (public._user_is_owner(p_user) or public._user_has_branch(p_user, hq)) then
    raise exception 'Only Head Office can issue GRNs' using errcode = '42501';
  end if;
  perform public.assert_actor(p_user, s.company_id, 'sales.view');
  if s.status not in ('dispatched', 'in_transit', 'delivered', 'collected') then
    raise exception 'The GRN is available once the truck is dispatched' using errcode = 'P0001';
  end if;
  if p_supplier is not null and not exists (select 1 from public.suppliers where id = p_supplier and company_id = s.company_id) then
    raise exception 'Supplier not found' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('sales_grn:' || p_shipment::text));
  select document_number into num from public.sales_shipment_grns
   where shipment_id = p_shipment and coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_supplier, '00000000-0000-0000-0000-000000000000'::uuid);
  if num is not null then return num; end if;
  perform public._ensure_doc_sequence(s.company_id, 'goods_received_note', 'GRN');
  num := public.next_document_number(s.company_id, hq, 'goods_received_note');
  insert into public.sales_shipment_grns(company_id, shipment_id, supplier_id, document_number, created_by)
    values (s.company_id, p_shipment, p_supplier, num, p_user);
  return num;
end; $$;

revoke all on function public.sales_shipment_line_suppliers(uuid) from public, anon, authenticated;
grant execute on function public.sales_shipment_line_suppliers(uuid) to service_role;
revoke all on function public.issue_sales_shipment_grn(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.issue_sales_shipment_grn(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Truck details entered like a transfer trip: dispatch date, expected
-- arrival and notes are kept on the truck as well.
-- ---------------------------------------------------------------------------
alter table public.sales_shipments
  add column if not exists expected_arrival_at timestamptz,
  add column if not exists notes text;

create or replace function public.create_sales_shipment(p_order uuid, p_user uuid, p_request_key text, p_header jsonb, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare o public.sales_orders; sid uuid; e jsonb; ol public.sales_order_lines; q numeric; n int := 0;
begin
  if coalesce(p_request_key, '') = '' then raise exception 'Missing request key' using errcode = 'P0001'; end if;
  select * into o from public.sales_orders where id = p_order for update;
  if not found then raise exception 'Order not found' using errcode = 'P0001'; end if;
  select id into sid from public.sales_shipments where company_id = o.company_id and client_request_id = p_request_key;
  if sid is not null then return sid; end if;
  perform public.assert_actor(p_user, o.company_id, 'sales.fulfil', o.branch_id);
  perform public._assert_order_open(o);
  insert into public.sales_shipments(company_id, branch_id, order_id, document_number, dispatch_location, consignee_name, consignee_phone, destination,
      transporter_name, transporter_contact, driver_name, driver_phone, driver_licence, vehicle_registration, trailer_registration,
      collector_name, collector_phone, collector_id_number, planned_loading_date, planned_dispatch_date, expected_arrival_at, notes, client_request_id, created_by)
    values (o.company_id, o.branch_id, o.id, public.next_document_number(o.company_id, o.branch_id, 'sales_shipment'),
      coalesce(nullif(p_header->>'dispatch_location', ''), o.fulfilment_location),
      coalesce(nullif(p_header->>'consignee_name', ''), o.consignee_name), coalesce(nullif(p_header->>'consignee_phone', ''), o.consignee_phone),
      coalesce(nullif(p_header->>'destination', ''), o.destination),
      nullif(p_header->>'transporter_name', ''), nullif(p_header->>'transporter_contact', ''),
      nullif(p_header->>'driver_name', ''), nullif(p_header->>'driver_phone', ''), nullif(p_header->>'driver_licence', ''),
      nullif(p_header->>'vehicle_registration', ''), nullif(p_header->>'trailer_registration', ''),
      nullif(p_header->>'collector_name', ''), nullif(p_header->>'collector_phone', ''), nullif(p_header->>'collector_id_number', ''),
      nullif(p_header->>'planned_loading_date', '')::date, nullif(p_header->>'planned_dispatch_date', '')::date,
      nullif(p_header->>'expected_arrival_at', '')::timestamptz, nullif(btrim(coalesce(p_header->>'notes', '')), ''), p_request_key, p_user)
    returning id into sid;
  for e in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    q := coalesce((e->>'qty')::numeric, 0);
    continue when q <= 0;
    select * into ol from public.sales_order_lines where id = (e->>'order_line_id')::uuid and order_id = o.id for update;
    if not found then raise exception 'A product is not on this order' using errcode = 'P0001'; end if;
    if not ol.track_inventory then raise exception 'Charges are invoiced automatically with the trucks; load only goods' using errcode = 'P0001'; end if;
    if ol.qty_dispatched + ol.qty_allocated + q > ol.quantity + 0.00005 then
      raise exception '%: only % left to allocate (approved %, dispatched %, on other trucks %)', coalesce(ol.description, 'Product'),
        ol.quantity - ol.qty_dispatched - ol.qty_allocated, ol.quantity, ol.qty_dispatched, ol.qty_allocated using errcode = 'P0001';
    end if;
    update public.sales_order_lines set qty_allocated = qty_allocated + q where id = ol.id;
    insert into public.sales_shipment_lines(shipment_id, order_line_id, qty_planned) values (sid, ol.id, q);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one product with a quantity to this truck' using errcode = 'P0001'; end if;
  perform public._sales_event(o.company_id, null, o.id, sid, 'shipment_created', null, p_user);
  return sid;
end; $$;

revoke all on function public.create_sales_shipment(uuid,uuid,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.create_sales_shipment(uuid,uuid,text,jsonb,jsonb) to service_role;
