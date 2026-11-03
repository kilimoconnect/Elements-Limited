-- =========================================================================
-- Elements ERP - Migration 0038: Transfer delivery note numbers and GRNs
--
-- 1. Every transfer trip gets its own delivery note number (DN00001), given
--    the first time its delivery note is issued and printed on every version.
-- 2. Goods Received Notes (GRN00001) for a transfer, one per supplier of the
--    goods it carries, issued by Head Office to submit to the supplier. The
--    number is kept, so re-downloading a supplier's GRN shows the same one.
--    A line's supplier is the supplier of its batch when that came from an
--    import, otherwise the supplier of the product's latest posted purchase.
-- =========================================================================

alter table public.stock_transfer_dispatches add column if not exists delivery_note_number text;
create unique index if not exists stock_transfer_dispatches_dn_number
  on public.stock_transfer_dispatches(company_id, delivery_note_number) where delivery_note_number is not null;

create table if not exists public.transfer_grns (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  transfer_id     uuid not null references public.stock_transfers(id) on delete restrict,
  supplier_id     uuid references public.suppliers(id) on delete restrict,
  document_number text not null,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create unique index if not exists transfer_grns_docnum on public.transfer_grns(company_id, document_number);
create unique index if not exists transfer_grns_one_per_supplier
  on public.transfer_grns(transfer_id, coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table public.transfer_grns enable row level security;
alter table public.transfer_grns force row level security;
drop policy if exists transfer_grns_select on public.transfer_grns;
create policy transfer_grns_select on public.transfer_grns for select to authenticated using (public.has_company_access(company_id));
grant select, insert, update, delete on public.transfer_grns to service_role;
revoke all on public.transfer_grns from anon, authenticated;
grant select on public.transfer_grns to authenticated;

do $$
declare c record;
begin
  for c in select id from public.companies loop
    perform public._ensure_doc_sequence(c.id, 'delivery_note', 'DN');
    perform public._ensure_doc_sequence(c.id, 'goods_received_note', 'GRN');
  end loop;
end $$;

-- The supplier behind each line of a transfer (null when none is recorded).
create or replace function public.transfer_line_suppliers(p_transfer uuid)
returns table(transfer_line_id uuid, supplier_id uuid)
language sql stable security definer set search_path = public as $$
  select l.id, coalesce(
    (select s.supplier_id from public.stock_lots sl
       join public.import_receipt_lines irl on irl.id = sl.origin_id
       join public.import_receipts ir on ir.id = irl.receipt_id
       join public.import_shipments s on s.id = ir.shipment_id
      where sl.id = l.lot_id and sl.origin_type = 'import_receipt_line'),
    (select p.supplier_id from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
      where pl.product_id = l.product_id and p.company_id = l.company_id and p.document_status = 'posted'
      order by p.document_date desc, p.posted_at desc nulls last limit 1))
  from public.stock_transfer_lines l where l.transfer_id = p_transfer;
$$;

-- Same snapshot as 0030 plus the delivery note number.
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
    'driver', jsonb_build_object('name', d.driver_name, 'phone', d.driver_phone),
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

-- As 0030, and gives the trip its delivery note number on first issue.
create or replace function public.issue_delivery_note(p_dispatch uuid, p_user uuid)
returns table(version_id uuid, version_no integer, is_new boolean)
language plpgsql security definer set search_path = public as $$
declare d public.stock_transfer_dispatches; t public.stock_transfers; snap jsonb; last public.document_versions; nid uuid;
begin
  select * into d from public.stock_transfer_dispatches where id = p_dispatch;
  if not found then raise exception 'Dispatch trip not found' using errcode = 'P0001'; end if;
  select * into t from public.stock_transfers where id = d.transfer_id;
  perform public._assert_transfer_party(p_user, t, 'inventory.transfer_view');
  if d.status = 'voided' then raise exception 'The trip is voided' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('delivery_note:' || p_dispatch::text));
  if d.delivery_note_number is null then
    perform public._ensure_doc_sequence(t.company_id, 'delivery_note', 'DN');
    update public.stock_transfer_dispatches
       set delivery_note_number = public.next_document_number(t.company_id, t.source_branch_id, 'delivery_note')
     where id = p_dispatch and delivery_note_number is null;
  end if;
  snap := public.delivery_note_snapshot(p_dispatch);
  select * into last from public.document_versions where owner_type = 'stock_transfer_dispatch' and owner_id = p_dispatch and kind = 'delivery_note'
    order by version desc limit 1;
  if last.id is not null and last.snapshot = snap then
    return query select last.id, last.version, false; return;
  end if;
  insert into public.document_versions(company_id, owner_type, owner_id, kind, version, snapshot, content_sha256, created_by)
    values (t.company_id, 'stock_transfer_dispatch', p_dispatch, 'delivery_note', coalesce(last.version, 0) + 1, snap,
            encode(sha256(convert_to(snap::text, 'UTF8')), 'hex'), p_user)
    returning id into nid;
  perform public._transfer_event(t.id, d.id, 'delivery_note', 'Delivery note ' || (snap->>'delivery_note_number') || ' v' || (coalesce(last.version, 0) + 1) || ' issued', p_user);
  return query select nid, coalesce(last.version, 0) + 1, true;
end; $$;

-- The GRN number for one supplier's goods on a transfer, created the first time.
create or replace function public.issue_transfer_grn(p_transfer uuid, p_supplier uuid, p_user uuid)
returns text language plpgsql security definer set search_path = public as $$
declare t public.stock_transfers; num text; hq uuid;
begin
  select * into t from public.stock_transfers where id = p_transfer;
  if not found then raise exception 'Transfer not found' using errcode = 'P0001'; end if;
  if t.status = 'voided' then raise exception 'The transfer is voided' using errcode = 'P0001'; end if;
  if p_supplier is not null and not exists (select 1 from public.suppliers where id = p_supplier and company_id = t.company_id) then
    raise exception 'Supplier not found' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('transfer_grn:' || p_transfer::text));
  select document_number into num from public.transfer_grns
   where transfer_id = p_transfer and coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_supplier, '00000000-0000-0000-0000-000000000000'::uuid);
  if num is not null then return num; end if;
  perform public._ensure_doc_sequence(t.company_id, 'goods_received_note', 'GRN');
  select id into hq from public.branches where company_id = t.company_id and is_head_office order by created_at limit 1;
  num := public.next_document_number(t.company_id, coalesce(hq, t.source_branch_id), 'goods_received_note');
  insert into public.transfer_grns(company_id, transfer_id, supplier_id, document_number, created_by)
    values (t.company_id, p_transfer, p_supplier, num, p_user);
  return num;
end; $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('transfer_line_suppliers','delivery_note_snapshot','issue_delivery_note','issue_transfer_grn') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
