-- ===========================================================================
-- 0030 — Stage 6: transfer costs, dispatch trips and the shared dispatch file.
--
-- One stock transfer, seen by the sending and the receiving branch, now has:
--   * dispatch trips (stock_transfer_dispatches), each with its own driver,
--     vehicle, transporter, dates, lines and receipts; several agents;
--   * goods in transit in 1155 (dispatch: Dr 1155 / Cr 1150 at the source
--     weighted average; receipt: Dr 1150 / Cr 1155) — fixes Stage 1 D2 for
--     every transfer dispatched from now on;
--   * receipts that split arrived cargo into accepted (into stock),
--     quarantined (held, not saleable) and short (pending), each resolved by
--     an approver: release, normal loss (absorbed, within tolerance),
--     write-off (6300) or claim (1145) — shortages are never spread silently;
--   * TZS charges (loading, transport, offloading, other) as cost sources on
--     the transfer or on one trip, accrued explicitly or invoiced through cost
--     invoices; only differences move cost; costs follow the goods (in
--     transit, received, sold, lost);
--   * a timeline, driver / vehicle change history and versioned delivery
--     notes (snapshots; printing posts nothing).
--
-- Transfers already dispatched before this migration keep their original
-- behaviour (posts_in_transit = false: value stays in 1150 while in transit);
-- nothing is re-posted. Drafts and new transfers use the new engine.
-- Additive: new tables / columns, wider checks, replaced functions.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------
alter table public.stock_transfers add column if not exists posts_in_transit boolean not null default true;
-- Legacy: anything already past draft keeps the old in-1150 behaviour.
update public.stock_transfers set posts_in_transit = false where status <> 'draft' and posts_in_transit;
alter table public.stock_transfers add column if not exists source_location text;
alter table public.stock_transfers add column if not exists destination_location text;
alter table public.stock_transfers add column if not exists client_request_id text;
create unique index if not exists stock_transfers_client_request on public.stock_transfers(company_id, client_request_id) where client_request_id is not null;

alter table public.stock_transfer_lines add column if not exists lot_id uuid references public.stock_lots(id) on delete restrict;
alter table public.stock_transfer_lines add column if not exists batch_reference text;
alter table public.stock_transfer_lines add column if not exists kg_per_unit numeric(18,6);
alter table public.stock_transfer_lines add column if not exists qty_quarantined numeric(18,4) not null default 0 check (qty_quarantined >= 0);
alter table public.stock_transfer_lines add column if not exists qty_short_pending numeric(18,4) not null default 0 check (qty_short_pending >= 0);
alter table public.stock_transfer_lines add column if not exists qty_lost_normal numeric(18,4) not null default 0 check (qty_lost_normal >= 0);
alter table public.stock_transfer_lines add column if not exists qty_lost_abnormal numeric(18,4) not null default 0 check (qty_lost_abnormal >= 0);
alter table public.stock_transfer_lines add column if not exists dispatched_value numeric(18,2) not null default 0;
alter table public.stock_transfer_lines add column if not exists transit_value numeric(18,2) not null default 0;
alter table public.stock_transfer_lines add column if not exists received_value numeric(18,2) not null default 0;
alter table public.stock_transfer_lines add column if not exists lost_value numeric(18,2) not null default 0;
alter table public.stock_transfer_lines add column if not exists charges_applied numeric(18,2) not null default 0;

alter table public.products add column if not exists transfer_loss_tolerance_pct numeric(7,4) not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_transfer_tolerance_range') then
    alter table public.products add constraint products_transfer_tolerance_range
      check (transfer_loss_tolerance_pct >= 0 and transfer_loss_tolerance_pct <= 100);
  end if;
end $$;

create table if not exists public.stock_transfer_agents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete restrict,
  transfer_id  uuid not null references public.stock_transfers(id) on delete cascade,
  name         text not null,
  company_name text,
  phone        text,
  role         text,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) on delete set null
);
create index if not exists stock_transfer_agents_transfer_idx on public.stock_transfer_agents(transfer_id);
drop trigger if exists trg_stock_transfer_agents_company on public.stock_transfer_agents;
create trigger trg_stock_transfer_agents_company before insert or update on public.stock_transfer_agents
  for each row execute function public.check_company_consistency('transfer_id','stock_transfers');

create table if not exists public.stock_transfer_dispatches (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete restrict,
  transfer_id          uuid not null references public.stock_transfers(id) on delete restrict,
  trip_no              integer not null,
  document_number      text,
  status               text not null default 'draft' check (status in ('draft','dispatched','arrived','received','voided')),
  dispatch_date        date not null default current_date,
  dispatched_at        timestamptz,
  expected_arrival_at  timestamptz,
  arrived_at           timestamptz,
  driver_name          text,
  driver_phone         text,
  driver_licence       text,
  vehicle_registration text,
  trailer_registration text,
  transporter_id       uuid references public.suppliers(id) on delete restrict,
  transporter_name     text,
  transporter_contact  text,
  notes                text,
  client_request_id    text,
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users(id) on delete set null,
  dispatched_by        uuid references auth.users(id) on delete set null,
  voided_at            timestamptz,
  voided_by            uuid references auth.users(id) on delete set null,
  void_reason          text,
  unique (transfer_id, trip_no)
);
create unique index if not exists stock_transfer_dispatches_client_request on public.stock_transfer_dispatches(company_id, client_request_id) where client_request_id is not null;
create unique index if not exists stock_transfer_dispatches_docnum on public.stock_transfer_dispatches(company_id, document_number) where document_number is not null;
drop trigger if exists trg_stock_transfer_dispatches_company on public.stock_transfer_dispatches;
create trigger trg_stock_transfer_dispatches_company before insert or update on public.stock_transfer_dispatches
  for each row execute function public.check_company_consistency('transfer_id','stock_transfers','transporter_id','suppliers');

create table if not exists public.stock_transfer_dispatch_lines (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  dispatch_id      uuid not null references public.stock_transfer_dispatches(id) on delete cascade,
  transfer_line_id uuid not null references public.stock_transfer_lines(id) on delete restrict,
  qty              numeric(18,4) not null check (qty > 0),
  net_kg           numeric(18,4),
  value            numeric(18,2) not null default 0,     -- source weighted-average value dispatched
  movement_id      uuid references public.stock_movements(id) on delete restrict,
  -- Value pool of this trip line (1155): dispatched value + charges - what left
  -- the pool (accepted into stock, lost). Each trip keeps its own pool so a
  -- trip can be reversed exactly.
  transit_value    numeric(18,2) not null default 0,
  received_value   numeric(18,2) not null default 0,
  lost_value       numeric(18,2) not null default 0,
  charges_applied  numeric(18,2) not null default 0,
  qty_reported     numeric(18,4) not null default 0 check (qty_reported >= 0),   -- arrived: accepted + quarantined + short as reported
  qty_accepted     numeric(18,4) not null default 0 check (qty_accepted >= 0),   -- in destination stock (incl. released / found)
  qty_quarantined  numeric(18,4) not null default 0 check (qty_quarantined >= 0),
  qty_short        numeric(18,4) not null default 0 check (qty_short >= 0),       -- reported short, not yet resolved
  qty_lost_normal  numeric(18,4) not null default 0 check (qty_lost_normal >= 0),
  qty_lost_abnormal numeric(18,4) not null default 0 check (qty_lost_abnormal >= 0),
  check (qty_reported <= qty),
  check (qty_accepted + qty_quarantined + qty_short + qty_lost_normal + qty_lost_abnormal <= qty),
  unique (dispatch_id, transfer_line_id)
);
drop trigger if exists trg_stock_transfer_dispatch_lines_company on public.stock_transfer_dispatch_lines;
create trigger trg_stock_transfer_dispatch_lines_company before insert or update on public.stock_transfer_dispatch_lines
  for each row execute function public.check_company_consistency('dispatch_id','stock_transfer_dispatches','transfer_line_id','stock_transfer_lines');

-- Driver / vehicle changes after dispatch keep the previous details and the reason.
create table if not exists public.stock_transfer_dispatch_changes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  dispatch_id uuid not null references public.stock_transfer_dispatches(id) on delete restrict,
  old_values  jsonb not null,
  new_values  jsonb not null,
  reason      text not null,
  changed_by  uuid references auth.users(id) on delete set null,
  changed_at  timestamptz not null default now()
);
drop trigger if exists trg_stock_transfer_dispatch_changes_immutable on public.stock_transfer_dispatch_changes;
create trigger trg_stock_transfer_dispatch_changes_immutable before update or delete on public.stock_transfer_dispatch_changes
  for each row execute function public.block_update_delete();

-- Timeline shared by both branches.
create table if not exists public.stock_transfer_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  transfer_id uuid not null references public.stock_transfers(id) on delete restrict,
  dispatch_id uuid references public.stock_transfer_dispatches(id) on delete restrict,
  event_type  text not null,
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists stock_transfer_events_transfer_idx on public.stock_transfer_events(transfer_id, created_at);
drop trigger if exists trg_stock_transfer_events_immutable on public.stock_transfer_events;
create trigger trg_stock_transfer_events_immutable before update or delete on public.stock_transfer_events
  for each row execute function public.block_update_delete();

alter table public.stock_transfer_receipts add column if not exists dispatch_id uuid references public.stock_transfer_dispatches(id) on delete restrict;
alter table public.stock_transfer_receipts add column if not exists arrived_at timestamptz;
alter table public.stock_transfer_receipts add column if not exists signed_by_name text;
alter table public.stock_transfer_receipts add column if not exists client_request_id text;
create unique index if not exists stock_transfer_receipts_client_request on public.stock_transfer_receipts(company_id, client_request_id) where client_request_id is not null;
alter table public.stock_transfer_receipt_lines add column if not exists dispatch_line_id uuid references public.stock_transfer_dispatch_lines(id) on delete restrict;
alter table public.stock_transfer_receipt_lines add column if not exists value numeric(18,2) not null default 0;
alter table public.stock_transfer_receipt_lines add column if not exists movement_id uuid references public.stock_movements(id) on delete restrict;
alter table public.stock_transfer_receipt_lines add column if not exists qty_released numeric(18,4) not null default 0;
alter table public.stock_transfer_receipt_lines add column if not exists qty_resolved_short numeric(18,4) not null default 0;
alter table public.stock_transfer_receipt_lines add column if not exists qty_resolved_damaged numeric(18,4) not null default 0;

-- Each approved disposition of quarantined or short cargo.
create table if not exists public.stock_transfer_resolutions (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete restrict,
  receipt_line_id   uuid not null references public.stock_transfer_receipt_lines(id) on delete restrict,
  kind              text not null check (kind in ('quarantine','short')),
  resolution        text not null check (resolution in ('release','normal_loss','write_off','claim','found')),
  qty               numeric(18,4) not null check (qty > 0),
  value             numeric(18,2) not null default 0,
  movement_id       uuid references public.stock_movements(id) on delete restrict,
  notes             text,
  approved_by       uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default clock_timestamp(),
  check (resolution <> 'release' or kind = 'quarantine'),
  check (resolution <> 'found' or kind = 'short')
);
drop trigger if exists trg_stock_transfer_resolutions_immutable on public.stock_transfer_resolutions;
create trigger trg_stock_transfer_resolutions_immutable before update or delete on public.stock_transfer_resolutions
  for each row execute function public.block_update_delete();

alter table public.cost_sources add column if not exists transfer_dispatch_id uuid references public.stock_transfer_dispatches(id) on delete restrict;

-- Documents: trips can own attachments and delivery-note versions; new cargo categories.
do $$
declare c record;
begin
  for c in select conname, conrelid::regclass::text rel from pg_constraint
           where conrelid in ('public.document_attachments'::regclass, 'public.document_versions'::regclass) and contype = 'c'
             and conname not like '%_v2' and (pg_get_constraintdef(oid) ilike '%owner_type%' or pg_get_constraintdef(oid) ilike '%bill_of_lading%') loop
    execute format('alter table %s drop constraint %I', c.rel, c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'document_attachments_owner_v2') then
    alter table public.document_attachments add constraint document_attachments_owner_v2 check (owner_type in (
      'import_shipment','import_receipt','cost_invoice','purchase','stock_transfer','stock_transfer_receipt','rebag_order','stock_transfer_dispatch'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_attachments_category_v2') then
    alter table public.document_attachments add constraint document_attachments_category_v2 check (category in (
      'bill_of_lading','packing_list','customs_entry','supplier_invoice','cost_invoice','delivery_note','proof_of_delivery','photo','other',
      'driver_licence','cargo_papers','loading_photo','weighbridge_ticket','transport_invoice','signed_delivery_note','offloading_photo'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_versions_owner_v2') then
    alter table public.document_versions add constraint document_versions_owner_v2 check (owner_type in (
      'import_receipt','stock_transfer','stock_transfer_receipt','rebag_order','stock_transfer_dispatch'));
  end if;
end $$;

-- Transfer permissions in the transfer-movement types list already exist; add the movement-type for
-- transfer receipts of quarantined goods released later (same 'transfer_in').

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
-- Net kg in one unit: bags use their pack weight, bulk is kg, others use the
-- unit's kg factor (null when unknown - then weight allocation is refused).
create or replace function public._kg_per_unit(p_product uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select case p.stock_role when 'packaged' then p.net_weight_kg when 'bulk' then 1
              else coalesce(p.net_weight_kg, u.kg_factor) end
  from public.products p left join public.units u on u.id = p.base_unit_id where p.id = p_product;
$$;

create or replace function public._transfer_event(p_transfer uuid, p_dispatch uuid, p_type text, p_note text, p_user uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.stock_transfer_events(company_id, transfer_id, dispatch_id, event_type, note, created_by)
  select company_id, p_transfer, p_dispatch, p_type, p_note, p_user from public.stock_transfers where id = p_transfer;
$$;

-- Value that leaves a trip line's pool for p_qty units (the pool's last unit
-- takes the exact remainder).
create or replace function public._tdl_take(p_dl uuid, p_qty numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare dl public.stock_transfer_dispatch_lines; pool numeric;
begin
  select * into dl from public.stock_transfer_dispatch_lines where id = p_dl for update;
  pool := dl.qty - dl.qty_accepted - dl.qty_lost_normal - dl.qty_lost_abnormal;
  if p_qty <= 0 or p_qty > pool then raise exception 'Quantity exceeds what is still in transit on this trip' using errcode = 'P0001'; end if;
  return case when p_qty = pool then dl.transit_value else round(dl.transit_value * p_qty / pool, 2) end;
end; $$;

-- Transfer-line totals are the sum of its live trip lines.
create or replace function public._transfer_refresh(p_transfer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t public.stock_transfers; all_disp boolean; all_arrived boolean; any_rep boolean; st text; active int;
begin
  select * into t from public.stock_transfers where id = p_transfer for update;
  if not t.posts_in_transit then return; end if;
  update public.stock_transfer_lines l set
      qty_dispatched = coalesce(x.q, 0), dispatched_value = coalesce(x.v, 0), transit_value = coalesce(x.tv, 0),
      received_value = coalesce(x.rv, 0), lost_value = coalesce(x.lv, 0), charges_applied = coalesce(x.ch, 0),
      qty_received = coalesce(x.acc, 0), qty_quarantined = coalesce(x.qua, 0), qty_short_pending = coalesce(x.sh, 0),
      qty_lost_normal = coalesce(x.ln, 0), qty_lost_abnormal = coalesce(x.la, 0),
      unit_cost = case when coalesce(x.pool, 0) > 0 then round(x.tv / x.pool, 4)
                       when coalesce(x.q, 0) > 0 then round((x.rv) / greatest(x.acc, 0.0001), 4) else l.unit_cost end
    from (select dl.transfer_line_id id, sum(dl.qty) q, sum(dl.value) v, sum(dl.transit_value) tv, sum(dl.received_value) rv,
                 sum(dl.lost_value) lv, sum(dl.charges_applied) ch, sum(dl.qty_accepted) acc, sum(dl.qty_quarantined) qua,
                 sum(dl.qty_short) sh, sum(dl.qty_lost_normal) ln, sum(dl.qty_lost_abnormal) la,
                 sum(dl.qty - dl.qty_accepted - dl.qty_lost_normal - dl.qty_lost_abnormal) pool
          from public.stock_transfer_dispatch_lines dl join public.stock_transfer_dispatches d on d.id = dl.dispatch_id
          where d.transfer_id = p_transfer and d.status <> 'voided' and d.status <> 'draft'
          group by dl.transfer_line_id) x
    where l.id = x.id;
  update public.stock_transfer_lines l set qty_dispatched = 0, dispatched_value = 0, transit_value = 0, received_value = 0, lost_value = 0,
      charges_applied = 0, qty_received = 0, qty_quarantined = 0, qty_short_pending = 0, qty_lost_normal = 0, qty_lost_abnormal = 0
    where l.transfer_id = p_transfer and not exists (
      select 1 from public.stock_transfer_dispatch_lines dl join public.stock_transfer_dispatches d on d.id = dl.dispatch_id
      where dl.transfer_line_id = l.id and d.status not in ('voided','draft'));
  select count(*) into active from public.stock_transfer_dispatches where transfer_id = p_transfer and status not in ('voided','draft');
  if active = 0 then return; end if;
  select bool_and(qty_dispatched >= qty_requested) into all_disp from public.stock_transfer_lines where transfer_id = p_transfer;
  select bool_and(dl.qty_reported >= dl.qty), bool_or(dl.qty_reported > 0) into all_arrived, any_rep
    from public.stock_transfer_dispatch_lines dl join public.stock_transfer_dispatches d on d.id = dl.dispatch_id
    where d.transfer_id = p_transfer and d.status not in ('voided','draft');
  st := case when all_disp and all_arrived then 'received' when any_rep then 'partially_received' else 'dispatched' end;
  update public.stock_transfers set status = st,
    has_open_discrepancy = exists (select 1 from public.stock_transfer_lines where transfer_id = p_transfer and (qty_quarantined > 0 or qty_short_pending > 0))
    where id = p_transfer and status <> 'voided';
end; $$;

create or replace function public._assert_transfer_party(p_user uuid, t public.stock_transfers, p_permission text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_actor(p_user, t.company_id, p_permission);
  if not (public._user_has_branch(p_user, t.source_branch_id) or public._user_has_branch(p_user, t.destination_branch_id)) then
    raise exception 'Not authorised for this transfer (sending or receiving branch only)' using errcode = '42501';
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- 3. Dispatch a trip: source stock -> 1155 at the source weighted average.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_transfer_trip(p_dispatch uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  d public.stock_transfer_dispatches; t public.stock_transfers; dl record; l public.stock_transfer_lines; v numeric(18,2);
  kgpu numeric; total numeric(18,2) := 0; ref text; mid uuid; lb public.stock_lot_balances; keys jsonb;
begin
  perform public._require_key(p_idem);
  select * into d from public.stock_transfer_dispatches where id = p_dispatch for update;
  if not found then raise exception 'Dispatch trip not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'dispatch_transfer_trip', p_dispatch) then return p_dispatch; end if;
  select * into t from public.stock_transfers where id = d.transfer_id for update;
  perform public.assert_actor(p_user, t.company_id, 'inventory.transfer_dispatch', t.source_branch_id);
  if not t.posts_in_transit then raise exception 'This transfer was dispatched before the upgrade; it cannot take new trips' using errcode = 'P0001'; end if;
  if t.status = 'voided' then raise exception 'Transfer is voided' using errcode = 'P0001'; end if;
  if d.status <> 'draft' then raise exception 'Trip is already %', d.status using errcode = 'P0001'; end if;
  if not exists (select 1 from public.stock_transfer_dispatch_lines where dispatch_id = p_dispatch) then
    raise exception 'The trip has no cargo lines' using errcode = 'P0001'; end if;
  for dl in select x.*, l2.qty_requested, l2.qty_dispatched from public.stock_transfer_dispatch_lines x
            join public.stock_transfer_lines l2 on l2.id = x.transfer_line_id where x.dispatch_id = p_dispatch loop
    if dl.qty_dispatched + dl.qty > dl.qty_requested then
      raise exception 'Dispatching % would exceed the % requested on this line', dl.qty_dispatched + dl.qty, dl.qty_requested using errcode = 'P0001'; end if;
  end loop;
  if not public.claim_idempotency(p_idem, 'dispatch_transfer_trip', p_dispatch) then return p_dispatch; end if;
  perform public.assert_period_open(t.company_id, d.dispatch_date);
  select jsonb_agg(jsonb_build_object('branch_id', b, 'product_id', l3.product_id)) into keys
    from public.stock_transfer_dispatch_lines x join public.stock_transfer_lines l3 on l3.id = x.transfer_line_id
    cross join unnest(array[t.source_branch_id, t.destination_branch_id]) b where x.dispatch_id = p_dispatch;
  perform public.lock_stock_balances(t.company_id, keys);
  if t.document_number is null then
    t.document_number := public.next_document_number(t.company_id, t.source_branch_id, 'stock_transfer');
    update public.stock_transfers set document_number = t.document_number where id = t.id;
  end if;
  ref := t.document_number || '-T' || d.trip_no;
  for dl in select * from public.stock_transfer_dispatch_lines where dispatch_id = p_dispatch order by transfer_line_id loop
    select * into l from public.stock_transfer_lines where id = dl.transfer_line_id for update;
    v := public._stock_out_avg(t.company_id, t.source_branch_id, l.product_id, 'transfer_out', 'stock_transfer', t.id, ref, dl.qty, p_user);
    select id into mid from public.stock_movements where source_id = t.id and branch_id = t.source_branch_id and product_id = l.product_id
      and movement_type = 'transfer_out' order by created_at desc, id desc limit 1;
    kgpu := coalesce(l.kg_per_unit, public._kg_per_unit(l.product_id));
    if l.lot_id is not null then
      select * into lb from public.stock_lot_balances where branch_id = t.source_branch_id and product_id = l.product_id and lot_id = l.lot_id for update;
      if lb.id is null or lb.quantity < dl.qty then
        raise exception 'Batch % has only % at the sending branch', coalesce(l.batch_reference, 'batch'), coalesce(lb.quantity, 0) using errcode = 'P0001'; end if;
      update public.stock_lot_balances set quantity = quantity - dl.qty where id = lb.id;
      insert into public.stock_lot_flows(company_id, movement_id, flow_type, from_lot_id, branch_id, quantity)
        values (t.company_id, mid, 'transfer_out', l.lot_id, t.source_branch_id, dl.qty);
    end if;
    update public.stock_transfer_dispatch_lines set value = v, transit_value = v, net_kg = case when kgpu is null then null else round(dl.qty * kgpu, 4) end,
      movement_id = mid where id = dl.id;
    update public.stock_transfer_lines set kg_per_unit = kgpu where id = l.id;
    perform public.adjust_in_transit(t.company_id, t.destination_branch_id, l.product_id, dl.qty);
    total := total + v;
  end loop;
  perform public.create_journal(t.company_id, t.source_branch_id, d.dispatch_date, 'stock_transfer_dispatch', d.id, ref,
    'Transfer dispatch ' || ref, p_user,
    public._jl(public.account_for(t.company_id, 'transfer.goods_in_transit'), total, 'Stock in transit to ' || (select code from public.branches where id = t.destination_branch_id))
    || public._jl(public.account_for(t.company_id, 'inventory.standard'), -total, 'Stock dispatched'));
  update public.stock_transfer_dispatches set status = 'dispatched', document_number = ref, dispatched_at = coalesce(dispatched_at, now()), dispatched_by = p_user
    where id = p_dispatch;
  update public.stock_transfers set dispatched_at = coalesce(dispatched_at, now()), dispatched_by = coalesce(dispatched_by, p_user) where id = t.id;
  perform public._transfer_refresh(t.id);
  perform public._transfer_event(t.id, p_dispatch, 'dispatched', 'Trip ' || ref || ' dispatched' ||
    coalesce(' · ' || nullif(concat_ws(' / ', d.vehicle_registration, d.driver_name), ''), ''), p_user);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (t.company_id, 'stock_transfer_dispatch', p_dispatch, 'draft', 'dispatched', p_user);
  return p_dispatch;
end; $$;

-- ---------------------------------------------------------------------------
-- 4. Receive (part of) a trip: accepted -> destination stock at the trip's
-- in-transit value (incl. charges so far); quarantined and short stay in
-- transit (1155) until an approver resolves them.
-- p_lines: [{dispatch_line_id, accepted, quarantined, short}]
-- ---------------------------------------------------------------------------
create or replace function public.receive_transfer_trip(
  p_dispatch uuid, p_user uuid, p_lines jsonb, p_arrived_at timestamptz, p_notes text, p_signed_by text, p_request text, p_idem text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  d public.stock_transfer_dispatches; t public.stock_transfers; item jsonb; dl public.stock_transfer_dispatch_lines; l public.stock_transfer_lines;
  acc numeric; qua numeric; sh numeric; v numeric(18,2); total numeric(18,2) := 0; rid uuid; docnum text; mid uuid; rdate date;
  keys jsonb; summary text := '';
begin
  perform public._require_key(p_idem);
  select * into d from public.stock_transfer_dispatches where id = p_dispatch for update;
  if not found then raise exception 'Dispatch trip not found' using errcode = 'P0001'; end if;
  select * into t from public.stock_transfers where id = d.transfer_id for update;
  if public._is_replay(p_idem, 'receive_transfer_trip', p_dispatch) then
    select id into rid from public.stock_transfer_receipts where company_id = t.company_id and client_request_id = p_request;
    return rid;
  end if;
  perform public.assert_actor(p_user, t.company_id, 'inventory.transfer_receive', t.destination_branch_id);
  if d.status not in ('dispatched','arrived') then raise exception 'Trip is %; nothing to receive', d.status using errcode = 'P0001'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'Enter what arrived' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'receive_transfer_trip', p_dispatch) then
    select id into rid from public.stock_transfer_receipts where company_id = t.company_id and client_request_id = p_request;
    return rid;
  end if;
  rdate := coalesce((p_arrived_at at time zone 'Africa/Dar_es_Salaam')::date, (now() at time zone 'Africa/Dar_es_Salaam')::date);
  perform public.assert_period_open(t.company_id, rdate);
  select jsonb_agg(jsonb_build_object('branch_id', t.destination_branch_id, 'product_id', l3.product_id)) into keys
    from public.stock_transfer_dispatch_lines x join public.stock_transfer_lines l3 on l3.id = x.transfer_line_id where x.dispatch_id = p_dispatch;
  perform public.lock_stock_balances(t.company_id, keys);
  perform public._ensure_doc_sequence(t.company_id, 'stock_transfer_receipt', 'TRR');
  docnum := public.next_document_number(t.company_id, t.destination_branch_id, 'stock_transfer_receipt');
  insert into public.stock_transfer_receipts(company_id, transfer_id, dispatch_id, document_number, received_by, arrived_at, notes, signed_by_name, client_request_id)
    values (t.company_id, t.id, d.id, docnum, p_user, coalesce(p_arrived_at, now()), p_notes, p_signed_by, p_request)
    returning id into rid;
  for item in select * from jsonb_array_elements(p_lines) loop
    acc := coalesce((item->>'accepted')::numeric, 0); qua := coalesce((item->>'quarantined')::numeric, 0); sh := coalesce((item->>'short')::numeric, 0);
    if acc < 0 or qua < 0 or sh < 0 then raise exception 'Quantities cannot be negative' using errcode = 'P0001'; end if;
    if acc + qua + sh = 0 then continue; end if;
    select * into dl from public.stock_transfer_dispatch_lines where id = (item->>'dispatch_line_id')::uuid and dispatch_id = p_dispatch for update;
    if not found then raise exception 'Line is not part of this trip' using errcode = 'P0001'; end if;
    if dl.qty_reported + acc + qua + sh > dl.qty then
      raise exception 'Only % of % on this trip is still to arrive', dl.qty - dl.qty_reported, dl.qty using errcode = 'P0001'; end if;
    select * into l from public.stock_transfer_lines where id = dl.transfer_line_id;
    v := 0; mid := null;
    if acc > 0 then
      v := public._tdl_take(dl.id, acc);
      mid := public._stock_in_value(t.company_id, t.destination_branch_id, l.product_id, 'transfer_in', 'stock_transfer', t.id, docnum, acc, v, p_user);
      if l.lot_id is not null then
        insert into public.stock_lot_balances(company_id, branch_id, product_id, lot_id, quantity) values (t.company_id, t.destination_branch_id, l.product_id, l.lot_id, acc)
          on conflict (branch_id, product_id, lot_id) do update set quantity = public.stock_lot_balances.quantity + acc;
        insert into public.stock_lot_flows(company_id, movement_id, flow_type, to_lot_id, branch_id, quantity)
          values (t.company_id, mid, 'transfer_in', l.lot_id, t.destination_branch_id, acc);
      end if;
      total := total + v;
    end if;
    update public.stock_transfer_dispatch_lines set qty_reported = qty_reported + acc + qua + sh, qty_accepted = qty_accepted + acc,
      qty_quarantined = qty_quarantined + qua, qty_short = qty_short + sh,
      transit_value = transit_value - v, received_value = received_value + v where id = dl.id;
    insert into public.stock_transfer_receipt_lines(company_id, receipt_id, transfer_line_id, dispatch_line_id, qty_received, qty_damaged, qty_short, value, movement_id)
      values (t.company_id, rid, l.id, dl.id, acc, qua, sh, v, mid);
    perform public.adjust_in_transit(t.company_id, t.destination_branch_id, l.product_id, -(acc + qua + sh));
    summary := summary || case when summary = '' then '' else '; ' end || (select name from public.products where id = l.product_id)
      || ' ' || acc::numeric(18,2) || ' accepted' || case when qua > 0 then ', ' || qua::numeric(18,2) || ' quarantined' else '' end
      || case when sh > 0 then ', ' || sh::numeric(18,2) || ' short' else '' end;
  end loop;
  if summary = '' then raise exception 'Enter what arrived' using errcode = 'P0001'; end if;
  perform public.create_journal(t.company_id, t.destination_branch_id, rdate, 'stock_transfer_receipt', rid, docnum,
    'Transfer receipt ' || docnum || ' (' || d.document_number || ')', p_user,
    public._jl(public.account_for(t.company_id, 'inventory.standard'), total, 'Transfer received')
    || public._jl(public.account_for(t.company_id, 'transfer.goods_in_transit'), -total, 'Out of transit'));
  update public.stock_transfer_dispatches set arrived_at = coalesce(arrived_at, p_arrived_at, now()),
    status = case when not exists (select 1 from public.stock_transfer_dispatch_lines where dispatch_id = d.id and qty_reported < qty) then 'received' else 'arrived' end
    where id = d.id;
  perform public._transfer_refresh(t.id);
  perform public._transfer_event(t.id, d.id, 'received', docnum || ': ' || summary || coalesce(' · signed by ' || nullif(p_signed_by, ''), ''), p_user);
  return rid;
end; $$;

-- ---------------------------------------------------------------------------
-- 5. Resolve quarantined or short cargo (approver).
--   quarantine: release (into stock) | normal_loss | write_off | claim
--   short:      found (arrived late, into stock) | normal_loss | write_off | claim
-- Normal loss is limited to the product's transfer tolerance and is absorbed
-- by the destination stock of that product; abnormal loss is never spread.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6. Void a trip that nothing has been received from (and that no charge has
-- reached): the exact dispatched value returns to the source.
-- ---------------------------------------------------------------------------
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
  if exists (select 1 from public.stock_transfer_dispatch_lines where dispatch_id = d.id and charges_applied <> 0) then
    raise exception 'Transfer charges were applied to this trip; credit them first' using errcode = 'P0001'; end if;
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

-- Driver / vehicle change after dispatch: previous details and the reason are kept.
create or replace function public.change_transfer_trip_transport(p_dispatch uuid, p_user uuid, p_changes jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.stock_transfer_dispatches; t public.stock_transfers; old jsonb; neu jsonb; k text;
  allowed text[] := array['driver_name','driver_phone','driver_licence','vehicle_registration','trailer_registration','transporter_name','transporter_contact','expected_arrival_at'];
begin
  select * into d from public.stock_transfer_dispatches where id = p_dispatch for update;
  if not found then raise exception 'Dispatch trip not found' using errcode = 'P0001'; end if;
  select * into t from public.stock_transfers where id = d.transfer_id;
  perform public._assert_transfer_party(p_user, t, 'inventory.transfer_dispatch');
  if d.status = 'draft' then raise exception 'Edit the draft trip directly' using errcode = 'P0001'; end if;
  if d.status in ('voided','received') then raise exception 'Trip is %', d.status using errcode = 'P0001'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = 'P0001'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not k = any(allowed) then raise exception 'Field % cannot be changed here', k using errcode = 'P0001'; end if;
  end loop;
  old := (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(d)) where key = any(allowed) and p_changes ? key);
  update public.stock_transfer_dispatches set
    driver_name = case when p_changes ? 'driver_name' then p_changes->>'driver_name' else driver_name end,
    driver_phone = case when p_changes ? 'driver_phone' then p_changes->>'driver_phone' else driver_phone end,
    driver_licence = case when p_changes ? 'driver_licence' then p_changes->>'driver_licence' else driver_licence end,
    vehicle_registration = case when p_changes ? 'vehicle_registration' then p_changes->>'vehicle_registration' else vehicle_registration end,
    trailer_registration = case when p_changes ? 'trailer_registration' then p_changes->>'trailer_registration' else trailer_registration end,
    transporter_name = case when p_changes ? 'transporter_name' then p_changes->>'transporter_name' else transporter_name end,
    transporter_contact = case when p_changes ? 'transporter_contact' then p_changes->>'transporter_contact' else transporter_contact end,
    expected_arrival_at = case when p_changes ? 'expected_arrival_at' then (p_changes->>'expected_arrival_at')::timestamptz else expected_arrival_at end
    where id = d.id returning * into d;
  neu := (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(d)) where key = any(allowed) and p_changes ? key);
  insert into public.stock_transfer_dispatch_changes(company_id, dispatch_id, old_values, new_values, reason, changed_by)
    values (t.company_id, d.id, coalesce(old, '{}'), coalesce(neu, '{}'), trim(p_reason), p_user);
  perform public._transfer_event(t.id, d.id, 'transport_changed', d.document_number || ': transport details changed — ' || trim(p_reason), p_user);
  return p_dispatch;
end; $$;

create or replace function public.add_transfer_update(p_transfer uuid, p_dispatch uuid, p_user uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare t public.stock_transfers;
begin
  select * into t from public.stock_transfers where id = p_transfer;
  if not found then raise exception 'Transfer not found' using errcode = 'P0001'; end if;
  perform public._assert_transfer_party(p_user, t, 'inventory.transfer_view');
  if coalesce(trim(p_note), '') = '' then raise exception 'Enter the update' using errcode = 'P0001'; end if;
  if p_dispatch is not null and not exists (select 1 from public.stock_transfer_dispatches where id = p_dispatch and transfer_id = p_transfer) then
    raise exception 'Trip is not part of this transfer' using errcode = 'P0001'; end if;
  perform public._transfer_event(p_transfer, p_dispatch, 'update', left(trim(p_note), 500), p_user);
end; $$;

-- ---------------------------------------------------------------------------
-- 12. Cost invoices also settle transfer charges.
-- ---------------------------------------------------------------------------
create or replace function public.post_cost_invoice(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ci public.cost_invoices; cr public.cost_invoices; ln record; s public.cost_sources; cat public.cost_categories;
  sh public.import_shipments; ro public.rebag_orders; tr public.stock_transfers; pb public.supplier_payables; docnum text; sgn int;
  rec numeric(18,2); nonrec numeric(18,2); cost numeric(18,2); delta numeric(18,2); acc numeric(18,2);
  v_net numeric(18,2) := 0; v_tax numeric(18,2) := 0; v_grand numeric(18,2) := 0; jl jsonb := '[]'::jsonb;
begin
  perform public._require_key(p_idem);
  select * into ci from public.cost_invoices where id = p_id for update;
  if not found then raise exception 'Cost invoice not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'post_cost_invoice', p_id) then return p_id; end if;
  if ci.document_status <> 'draft' then raise exception 'Cost invoice already %', ci.document_status using errcode = 'P0001'; end if;
  if not (public.feature_enabled(ci.company_id, 'imports') or public.feature_enabled(ci.company_id, 'rebagging') or public.feature_enabled(ci.company_id, 'transfer_logistics')) then
    raise exception 'The imports feature is not enabled for this company' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, ci.company_id, 'cost_invoices.post', ci.branch_id);
  if not exists (select 1 from public.cost_invoice_lines where cost_invoice_id = p_id) then
    raise exception 'Cost invoice has no lines' using errcode = 'P0001'; end if;
  sgn := case when ci.document_kind = 'invoice' then 1 else -1 end;
  if sgn < 0 then
    select * into cr from public.cost_invoices where id = ci.credited_invoice_id;
    if cr.document_status <> 'posted' then raise exception 'The credited invoice must be posted' using errcode = 'P0001'; end if;
  end if;
  if not public.claim_idempotency(p_idem, 'post_cost_invoice', p_id) then return p_id; end if;
  perform public.assert_period_open(ci.company_id, ci.document_date);
  docnum := public.next_document_number(ci.company_id, ci.branch_id, 'cost_invoice');

  for ln in select * from public.cost_invoice_lines where cost_invoice_id = p_id order by cost_source_id nulls last, line_no, id loop
    rec := case when ln.is_recoverable then ln.tax_amount else 0 end; nonrec := ln.tax_amount - rec;
    cost := round(ln.net_amount + nonrec, 2);
    v_net := v_net + ln.net_amount; v_tax := v_tax + ln.tax_amount;
    jl := jl || public._jl(public.account_for(ci.company_id, 'tax.input_vat'), sgn * rec, 'Input VAT');
    select * into cat from public.cost_categories where id = ln.cost_category_id;
    if ln.cost_source_id is null then
      if cat.inventory_treatment = 'capitalize' then
        raise exception 'Line "%": a capitalised cost must be linked to a shipment or rebagging cost line', coalesce(ln.description, cat.name) using errcode = 'P0001';
      end if;
      jl := jl || public._jl(cat.expense_account_id, sgn * cost, coalesce(ln.description, cat.name));
      continue;
    end if;
    select * into s from public.cost_sources where id = ln.cost_source_id for update;
    if s.cost_category_id <> ln.cost_category_id then raise exception 'Line category must match the linked cost' using errcode = 'P0001'; end if;
    if s.status = 'voided' then raise exception 'The linked cost is voided' using errcode = 'P0001'; end if;
    sh := null; ro := null; tr := null;
    if s.owner_type = 'import_shipment' then
      perform public.assert_feature(ci.company_id, 'imports');
      select * into sh from public.import_shipments where id = s.import_shipment_id for update;
    elsif s.owner_type = 'rebag_order' then
      perform public.assert_feature(ci.company_id, 'rebagging');
      select * into ro from public.rebag_orders where id = s.rebag_order_id for update;
      if ro.document_status <> 'completed' then
        raise exception 'Rebagging order % is %; its charges are invoiced after completion', coalesce(ro.document_number, 'draft'), ro.document_status
          using errcode = 'P0001'; end if;
    elsif s.owner_type = 'stock_transfer' then
      perform public.assert_feature(ci.company_id, 'transfer_logistics');
      select * into tr from public.stock_transfers where id = s.stock_transfer_id for update;
      if not exists (select 1 from public.stock_transfer_dispatches where transfer_id = tr.id and status not in ('draft','voided')
                       and (s.transfer_dispatch_id is null or id = s.transfer_dispatch_id)) then
        raise exception 'Transfer % has no dispatched trip for this charge yet; accrue or invoice it after dispatch', coalesce(tr.document_number, 'draft')
          using errcode = 'P0001'; end if;
    else
      raise exception 'This cost type is not supported here' using errcode = 'P0001';
    end if;
    if sgn > 0 then
      if exists (select 1 from public.cost_source_actuals where cost_source_id = s.id) then
        raise exception 'This cost already has its actual invoice; use a credit note or a new cost line' using errcode = 'P0001'; end if;
      acc := case when s.status = 'accrued' then s.accrued_amount else 0 end;
      delta := cost - acc;
      if acc > 0 then
        jl := jl || public._jl(public.account_for(ci.company_id, 'import.accrued_costs'), acc, 'Accrual replaced by actual');
        if sh.id is not null then perform public._ship_ledger(sh.id, null, s.id, 'accrual', acc, 'cost_invoice', p_id, ci.document_date); end if;
      end if;
      insert into public.cost_source_actuals(cost_source_id, cost_invoice_line_id, company_id) values (s.id, ln.id, ci.company_id);
      update public.cost_sources set status = 'invoiced', actual_amount = cost, supplier_id = coalesce(supplier_id, ci.supplier_id), updated_by = p_user where id = s.id;
    else
      if s.status <> 'invoiced' then raise exception 'A credit note can only adjust an invoiced cost' using errcode = 'P0001'; end if;
      if cost > s.actual_amount then raise exception 'Credit exceeds the invoiced cost' using errcode = 'P0001'; end if;
      delta := -cost;
      update public.cost_sources set actual_amount = actual_amount - cost, updated_by = p_user where id = s.id;
    end if;
    if s.inventory_treatment = 'capitalize' then
      if ro.id is not null then
        jl := jl || public._apply_rebag_delta(s.id, delta, ci.document_date, 'cost_invoice', p_id, docnum, p_user);
      elsif tr.id is not null then
        jl := jl || public._apply_transfer_delta(s.id, delta, ci.document_date, 'cost_invoice', p_id, docnum, p_user);
      else
        jl := jl || public._apply_source_delta(s.id, delta, ci.document_date, 'cost_invoice', p_id, docnum, p_user);
      end if;
    else
      jl := jl || public._jl(s.expense_account_id, delta, coalesce(ln.description, cat.name));
      if sh.id is not null then perform public._ship_ledger(sh.id, null, s.id, 'expense', delta, 'cost_invoice', p_id, ci.document_date); end if;
    end if;
    if sh.id is not null then
      update public.import_shipments set cost_status = case when cost_status = 'finalized' then 'adjusted'
        when cost_status = 'estimated' then 'provisional' else cost_status end where id = sh.id;
    elsif tr.id is not null then
      update public.stock_transfers set cost_status = case
          when cost_status in ('finalized','adjusted') then 'adjusted'
          when not exists (select 1 from public.cost_sources where stock_transfer_id = tr.id and status in ('estimated','accrued')) then 'finalized'
          else 'provisional' end
        where id = tr.id;
      perform public._transfer_event(tr.id, s.transfer_dispatch_id, 'charge_invoiced', coalesce(s.description, cat.name) || ' invoiced (' || docnum || ')', p_user);
    else
      perform set_config('letiq.rebag_posting', 'on', true);
      update public.rebag_orders set cost_status = case
          when cost_status in ('finalized','adjusted') then 'adjusted'
          when not exists (select 1 from public.cost_sources where rebag_order_id = ro.id and status in ('estimated','accrued')) then 'finalized'
          else cost_status end
        where id = ro.id;
      perform set_config('letiq.rebag_posting', 'off', true);
    end if;
  end loop;

  v_grand := round(v_net + v_tax, 2);
  if sgn > 0 then
    jl := jl || public._jl(public.account_id_by_code(ci.company_id, '2110'), -v_grand, 'Accounts payable');
  else
    select * into pb from public.supplier_payables where cost_invoice_id = cr.id for update;
    if pb.id is null or pb.outstanding < v_grand then
      raise exception 'Credit exceeds the open balance of the credited invoice' using errcode = 'P0001'; end if;
    update public.supplier_payables set outstanding = outstanding - v_grand,
      status = case when outstanding - v_grand <= 0 then 'settled' else 'partial' end where id = pb.id;
    jl := jl || public._jl(public.account_id_by_code(ci.company_id, '2110'), v_grand, 'Credit note reduces payable');
  end if;
  perform public.create_journal(ci.company_id, ci.branch_id, ci.document_date, 'cost_invoice', ci.id, docnum,
    case when sgn > 0 then 'Cost invoice ' else 'Cost credit note ' end || docnum, p_user, jl);

  update public.cost_invoices set document_status = 'posted', document_number = docnum, net_total = v_net, tax_total = v_tax,
    grand_total = v_grand, posted_at = now(), posted_by = p_user where id = p_id;
  if sgn > 0 then
    perform public.register_supplier_invoice(ci.company_id, ci.supplier_id, ci.supplier_invoice_number, 'cost_invoice', ci.id);
    if v_grand > 0 then
      insert into public.supplier_payables(company_id, branch_id, supplier_id, source_type, cost_invoice_id, original_amount, outstanding, status)
        values (ci.company_id, ci.branch_id, ci.supplier_id, 'cost_invoice', ci.id, v_grand, v_grand, 'open');
    end if;
  end if;
  return p_id;
end; $$;


-- ---------------------------------------------------------------------------
-- 7. Transfer charges and late costs on transferred goods.
-- A cost amount on one trip line follows its units: still in transit or
-- quarantined / short (1155, raises the trip pool), accepted (into the
-- destination pool and wherever those units went since), normal loss
-- (destination stock), abnormal loss (6300).
-- ---------------------------------------------------------------------------
create or replace function public._apply_tdl_delta(
  p_dl uuid, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_depth int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  dl public.stock_transfer_dispatch_lines; t public.stock_transfers; l public.stock_transfer_lines; parts jsonb := '[]'::jsonb; s record;
  jl jsonb := '[]'::jsonb; mv record; mvs jsonb := '[]'::jsonb; a record; pool numeric; unabs numeric(18,2); m public.stock_movements;
begin
  if p_amount = 0 then return '[]'::jsonb; end if;
  select * into dl from public.stock_transfer_dispatch_lines where id = p_dl for update;
  select * into l from public.stock_transfer_lines where id = dl.transfer_line_id;
  select * into t from public.stock_transfers where id = l.transfer_id;
  pool := dl.qty - dl.qty_accepted - dl.qty_lost_normal - dl.qty_lost_abnormal;
  if pool > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'transit', 'factor', pool); end if;
  if dl.qty_accepted > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'accepted', 'factor', dl.qty_accepted); end if;
  if dl.qty_lost_normal > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'normal', 'factor', dl.qty_lost_normal); end if;
  if dl.qty_lost_abnormal > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'lost', 'factor', dl.qty_lost_abnormal); end if;
  for s in select p.value as part, x.amount from jsonb_array_elements(parts) p
           join public.allocate_amount(round(p_amount, 2), 'quantity', parts) x on x.target_id = (p.value->>'id')::uuid loop
    if s.part->>'kind' = 'transit' then
      update public.stock_transfer_dispatch_lines set transit_value = transit_value + s.amount where id = dl.id;
      jl := jl || public._jl(public.account_for(t.company_id, 'transfer.goods_in_transit'), s.amount, 'Cost on stock in transit');
    elsif s.part->>'kind' = 'accepted' then
      -- every movement that put this trip line's units into destination stock
      mvs := '[]'::jsonb;
      for mv in select rl.movement_id id, rl.qty_received q from public.stock_transfer_receipt_lines rl
                  where rl.dispatch_line_id = dl.id and rl.movement_id is not null and rl.qty_received > 0
                union all
                select r.movement_id, r.qty from public.stock_transfer_resolutions r join public.stock_transfer_receipt_lines rl on rl.id = r.receipt_line_id
                  where rl.dispatch_line_id = dl.id and r.movement_id is not null loop
        mvs := mvs || jsonb_build_object('id', mv.id, 'factor', mv.q);
      end loop;
      update public.stock_transfer_dispatch_lines set received_value = received_value + s.amount where id = dl.id;
      for a in select * from public.allocate_amount(s.amount, 'quantity', mvs) loop
        select * into m from public.stock_movements where id = a.target_id;
        jl := jl || public._propagate_from_movement(t.company_id, t.destination_branch_id, l.product_id, m.created_at, m.id, m.qty_in, a.amount,
                      p_src_type, p_src_id, p_docnum, p_user, p_depth + 1);
      end loop;
    elsif s.part->>'kind' = 'normal' then
      unabs := public._stock_value_adjust(t.company_id, t.destination_branch_id, l.product_id, s.amount, p_src_type, p_src_id, p_docnum, p_user);
      update public.stock_transfer_dispatch_lines set received_value = received_value + s.amount where id = dl.id;
      jl := jl || public._jl(public.account_for(t.company_id, 'inventory.standard'), s.amount - unabs, 'Cost on normal transit loss')
               || public._jl(public.account_for(t.company_id, 'inventory.cost_of_sales'), unabs, 'Cost on normal transit loss (no stock left)');
    else
      update public.stock_transfer_dispatch_lines set lost_value = lost_value + s.amount where id = dl.id;
      jl := jl || public._jl(public.account_for(t.company_id, 'inventory.loss'), s.amount, 'Cost on goods lost in transit');
    end if;
  end loop;
  update public.stock_transfer_dispatch_lines set charges_applied = charges_applied + round(p_amount, 2) where id = dl.id;
  return jl;
end; $$;

-- Allocate a transfer charge (whole transfer or one trip) by its basis.
-- weight = net kg dispatched, value = value dispatched, quantity = units
-- (only when chosen), direct / manual / percent = named transfer lines.
create or replace function public._apply_transfer_delta(
  p_source uuid, p_delta numeric, p_date date, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.cost_sources; t public.stock_transfers; tg jsonb := '[]'::jsonb; a record; b record; dl record; jl jsonb := '[]'::jsonb;
  run uuid; e jsonb; sub jsonb;
begin
  if p_delta = 0 then return '[]'::jsonb; end if;
  select * into s from public.cost_sources where id = p_source for update;
  select * into t from public.stock_transfers where id = s.stock_transfer_id for update;
  if not exists (select 1 from public.stock_transfer_dispatches where transfer_id = t.id and status not in ('draft','voided')
                   and (s.transfer_dispatch_id is null or id = s.transfer_dispatch_id)) then
    raise exception 'Dispatch the goods before applying transfer charges' using errcode = 'P0001'; end if;
  insert into public.cost_allocation_runs(company_id, cost_source_id, amount_kind, basis, total_amount, is_current, created_by)
    values (s.company_id, s.id, 'delta', coalesce(s.allocation_basis, 'weight'), p_delta, false, p_user) returning id into run;
  if s.allocation_basis in ('direct','manual','percent') then
    if s.allocation_targets is null or jsonb_array_length(s.allocation_targets) = 0 then
      raise exception 'Choose the transfer line(s) for a % allocation', s.allocation_basis using errcode = 'P0001'; end if;
    for e in select * from jsonb_array_elements(s.allocation_targets) loop
      if not exists (select 1 from public.stock_transfer_lines where id = (e->>'id')::uuid and transfer_id = t.id) then
        raise exception 'Allocation target is not a line of this transfer' using errcode = '23514'; end if;
    end loop;
    for a in select * from public.allocate_amount(round(p_delta, 2), s.allocation_basis, s.allocation_targets) loop
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'factor', x.qty)), '[]'::jsonb) into sub
        from public.stock_transfer_dispatch_lines x join public.stock_transfer_dispatches d on d.id = x.dispatch_id
        where x.transfer_line_id = a.target_id and d.status not in ('draft','voided') and (s.transfer_dispatch_id is null or d.id = s.transfer_dispatch_id);
      if jsonb_array_length(sub) = 0 then raise exception 'That transfer line has not been dispatched' using errcode = 'P0001'; end if;
      insert into public.cost_allocations(company_id, run_id, target_type, target_id, factor, amount) values (s.company_id, run, 'stock_transfer_line', a.target_id, null, a.amount);
      for b in select * from public.allocate_amount(a.amount, 'quantity', sub) loop
        jl := jl || public._apply_tdl_delta(b.target_id, b.amount, p_src_type, p_src_id, p_docnum, p_user, 0);
      end loop;
    end loop;
  else
    for dl in select x.*, l.product_id, p.name pname from public.stock_transfer_dispatch_lines x join public.stock_transfer_dispatches d on d.id = x.dispatch_id
              join public.stock_transfer_lines l on l.id = x.transfer_line_id join public.products p on p.id = l.product_id
              where d.transfer_id = t.id and d.status not in ('draft','voided') and (s.transfer_dispatch_id is null or d.id = s.transfer_dispatch_id)
              order by d.trip_no, x.id loop
      if coalesce(s.allocation_basis, 'weight') = 'weight' and dl.net_kg is null then
        raise exception 'Net kg of % is unknown; allocate this charge by value or directly', dl.pname using errcode = 'P0001'; end if;
      tg := tg || jsonb_build_object('id', dl.id, 'factor', case coalesce(s.allocation_basis, 'weight')
                    when 'weight' then dl.net_kg when 'value' then dl.value when 'quantity' then dl.qty end);
    end loop;
    if exists (select 1 from jsonb_array_elements(tg) x where x->'factor' = 'null'::jsonb) then
      raise exception 'Allocation basis % is not available for transfers', s.allocation_basis using errcode = 'P0001'; end if;
    for a in select * from public.allocate_amount(round(p_delta, 2), 'value', tg) loop
      insert into public.cost_allocations(company_id, run_id, target_type, target_id, factor, amount)
        select s.company_id, run, 'stock_transfer_line', transfer_line_id, (select (x->>'factor')::numeric from jsonb_array_elements(tg) x where (x->>'id')::uuid = a.target_id), a.amount
        from public.stock_transfer_dispatch_lines where id = a.target_id;
      jl := jl || public._apply_tdl_delta(a.target_id, a.amount, p_src_type, p_src_id, p_docnum, p_user, 0);
    end loop;
  end if;
  perform public._transfer_refresh(t.id);
  return jl;
end; $$;

create or replace function public.cost_sources_transfer_trip_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.transfer_dispatch_id is not null and (NEW.owner_type <> 'stock_transfer'
     or not exists (select 1 from public.stock_transfer_dispatches where id = NEW.transfer_dispatch_id and transfer_id = NEW.stock_transfer_id)) then
    raise exception 'The trip must belong to the cost''s transfer' using errcode = '23514';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_cost_sources_transfer_trip on public.cost_sources;
create trigger trg_cost_sources_transfer_trip before insert or update on public.cost_sources
  for each row execute function public.cost_sources_transfer_trip_guard();

-- Approved accrual of a transfer charge (estimates never post).
create or replace function public.accrue_transfer_cost(p_source uuid, p_amount numeric, p_date date, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.cost_sources; t public.stock_transfers; jl jsonb;
begin
  perform public._require_key(p_idem);
  select * into s from public.cost_sources where id = p_source for update;
  if not found or s.owner_type <> 'stock_transfer' then raise exception 'Transfer charge not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'accrue_transfer_cost', p_source) then return p_source; end if;
  select * into t from public.stock_transfers where id = s.stock_transfer_id for update;
  perform public.assert_feature(s.company_id, 'transfer_logistics');
  perform public._assert_transfer_party(p_user, t, 'inventory.transfer_cost');
  if s.status <> 'estimated' then raise exception 'Only an estimated charge can be accrued (it is %)', s.status using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Accrual must be a positive amount with at most 2 decimals' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'accrue_transfer_cost', p_source) then return p_source; end if;
  perform public.assert_period_open(s.company_id, p_date);
  if s.inventory_treatment = 'capitalize' then
    jl := public._apply_transfer_delta(s.id, p_amount, p_date, 'cost_accrual', s.id, t.document_number, p_user);
  else
    jl := public._jl(s.expense_account_id, p_amount, 'Accrued transfer charge (expensed)');
  end if;
  jl := jl || public._jl(public.account_for(s.company_id, 'import.accrued_costs'), -p_amount, 'Accrued transfer charge');
  perform public.create_journal(s.company_id, t.destination_branch_id, p_date, 'cost_accrual', s.id, t.document_number,
    'Accrued transfer charge ' || coalesce(t.document_number, ''), p_user, jl);
  update public.cost_sources set status = 'accrued', accrued_amount = p_amount, accrual_date = p_date, updated_by = p_user where id = s.id;
  update public.stock_transfers set cost_status = case when cost_status in ('finalized','adjusted') then 'adjusted' else 'provisional' end where id = t.id;
  perform public._transfer_event(t.id, s.transfer_dispatch_id, 'charge_accrued', coalesce(s.description, 'Charge') || ' accrued', p_user);
  return p_source;
end; $$;

-- Late costs reaching a transfer through the source pool.
create or replace function public._propagate_transfer(
  p_out_mv uuid, p_units numeric, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_depth int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mo public.stock_movements; t public.stock_transfers; d numeric; rc numeric; parts jsonb := '[]'::jsonb;
  mi record; s record; jl jsonb := '[]'::jsonb; ln record; open_qty numeric; dl public.stock_transfer_dispatch_lines; trip text; unabs numeric(18,2);
begin
  select * into mo from public.stock_movements where id = p_out_mv;
  select * into t from public.stock_transfers where id = mo.source_id;
  if t.id is null then
    return public._jl(public.account_for(mo.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (untraced outflow)');
  end if;
  if t.posts_in_transit then
    select * into dl from public.stock_transfer_dispatch_lines where movement_id = p_out_mv;
    if dl.id is null then
      return public._jl(public.account_for(mo.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (untraced transfer)');
    end if;
    select status into trip from public.stock_transfer_dispatches where id = dl.dispatch_id;
    if trip = 'voided' then
      -- the units went back to the source pool
      unabs := public._stock_value_adjust(mo.company_id, mo.branch_id, mo.product_id, p_amount, p_src_type, p_src_id, p_docnum, p_user);
      return public._jl(public.account_for(mo.company_id, 'inventory.standard'), p_amount - unabs, 'Late cost (voided trip, stock returned)')
          || public._jl(public.account_for(mo.company_id, 'inventory.cost_of_sales'), unabs, 'Late cost (voided trip, no stock left)');
    end if;
    jl := public._apply_tdl_delta(dl.id, p_amount, p_src_type, p_src_id, p_docnum, p_user, p_depth);
    perform public._transfer_refresh(t.id);
    return jl;
  end if;
  -- Transfers dispatched before 0030: in-transit value is carried on the lines and in GL 1150.
  select coalesce(sum(qty_dispatched),0), coalesce(sum(qty_received),0) into d, rc
    from public.stock_transfer_lines where transfer_id = t.id and product_id = mo.product_id;
  if d <= 0 then
    return public._jl(public.account_for(mo.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (untraced outflow)');
  end if;
  if t.status <> 'voided' and d - rc > 0 then
    parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'transit', 'factor', d - rc);
  end if;
  for mi in select * from public.stock_movements where source_id = t.id and product_id = mo.product_id
              and branch_id = t.destination_branch_id and movement_type = 'transfer_in' order by created_at, id loop
    parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'in', 'factor', mi.qty_in, 'mv', mi.id,
               'at', mi.created_at, 'units', p_units * mi.qty_in / d);
  end loop;
  if jsonb_array_length(parts) = 0 then
    return public._jl(public.account_for(mo.company_id, 'inventory.loss'), p_amount, 'Late cost (voided transfer)');
  end if;
  for s in select p.value as part, a.amount from jsonb_array_elements(parts) p
           join public.allocate_amount(round(p_amount, 2), 'quantity', parts) a on a.target_id = (p.value->>'id')::uuid loop
    if s.part->>'kind' = 'transit' then
      for ln in select * from public.stock_transfer_lines where transfer_id = t.id and product_id = mo.product_id
                  and qty_dispatched > qty_received order by line_no, id loop
        open_qty := ln.qty_dispatched - ln.qty_received;
        update public.stock_transfer_lines set unit_cost = round(unit_cost + s.amount * (open_qty / (d - rc)) / open_qty, 4) where id = ln.id;
      end loop;
      jl := jl || public._jl(public.account_id_by_code(mo.company_id, '1150'), s.amount, 'Late cost to stock in transit');
    else
      jl := jl || public._propagate_from_movement(mo.company_id, t.destination_branch_id, mo.product_id,
                    (s.part->>'at')::timestamptz, (s.part->>'mv')::uuid, (s.part->>'units')::numeric, s.amount,
                    p_src_type, p_src_id, p_docnum, p_user, p_depth + 1);
    end if;
  end loop;
  return jl;
end; $$;

-- ---------------------------------------------------------------------------
-- 8. The original transfer functions, kept for the existing screens:
-- new-engine transfers dispatch as one trip and receive across their trips;
-- transfers dispatched before 0030 keep the original behaviour. All now
-- check the acting branch (Stage 1 D3).
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_stock_transfer(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t public.stock_transfers; tid uuid; n int;
begin
  perform public._require_key(p_idem);
  select * into t from public.stock_transfers where id = p_id for update;
  if not found then raise exception 'Transfer not found' using errcode = 'P0001'; end if;
  if exists (select 1 from public.stock_transfer_dispatches where company_id = t.company_id and client_request_id = p_idem) then return p_id; end if;
  perform public.assert_actor(p_user, t.company_id, 'inventory.transfer_dispatch', t.source_branch_id);
  if not t.posts_in_transit or t.status not in ('draft','ready') then raise exception 'Transfer already %', t.status using errcode = 'P0001'; end if;
  if not exists (select 1 from public.stock_transfer_lines where transfer_id = p_id) then
    raise exception 'Transfer has no lines' using errcode = 'P0001'; end if;
  select coalesce(max(trip_no), 0) + 1 into n from public.stock_transfer_dispatches where transfer_id = p_id;
  insert into public.stock_transfer_dispatches(company_id, transfer_id, trip_no, dispatch_date, expected_arrival_at, driver_name, driver_phone, driver_licence,
      vehicle_registration, trailer_registration, transporter_id, client_request_id, created_by)
    values (t.company_id, t.id, n, t.transfer_date, t.expected_date::timestamptz, t.driver_name, t.driver_phone, t.driver_licence,
      t.vehicle_registration, t.trailer_registration, t.transporter_id, p_idem, p_user)
    returning id into tid;
  insert into public.stock_transfer_dispatch_lines(company_id, dispatch_id, transfer_line_id, qty)
    select t.company_id, tid, id, qty_requested - qty_dispatched from public.stock_transfer_lines
    where transfer_id = p_id and qty_requested - qty_dispatched > 0;
  perform public.dispatch_transfer_trip(tid, p_user, p_idem || ':trip');
  return p_id;
end; $$;

create or replace function public.receive_stock_transfer(p_id uuid, p_user uuid, p_lines jsonb, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t public.stock_transfers; item jsonb; ln public.stock_transfer_lines; qty numeric(18,4); all_done boolean; new_status text;
  trip record; dl record; want jsonb := '{}'::jsonb; items jsonb; take numeric; left_ numeric; k text;
begin
  select * into t from public.stock_transfers where id = p_id for update;
  if not found then raise exception 'Transfer not found' using errcode = 'P0001'; end if;
  perform public.assert_actor(p_user, t.company_id, 'inventory.transfer_receive', t.destination_branch_id);
  if t.posts_in_transit then
    perform public._require_key(p_idem);
    for item in select * from jsonb_array_elements(p_lines) loop
      if coalesce((item->>'qty')::numeric, 0) > 0 then
        want := jsonb_set(want, array[item->>'line_id'], to_jsonb(coalesce((want->>(item->>'line_id'))::numeric, 0) + (item->>'qty')::numeric));
      end if;
    end loop;
    for trip in select * from public.stock_transfer_dispatches where transfer_id = p_id and status in ('dispatched','arrived') order by trip_no loop
      items := '[]'::jsonb;
      for dl in select * from public.stock_transfer_dispatch_lines where dispatch_id = trip.id order by id loop
        k := dl.transfer_line_id::text;
        left_ := coalesce((want->>k)::numeric, 0);
        take := least(left_, dl.qty - dl.qty_reported);
        if take > 0 then
          items := items || jsonb_build_object('dispatch_line_id', dl.id, 'accepted', take);
          want := jsonb_set(want, array[k], to_jsonb(left_ - take));
        end if;
      end loop;
      if jsonb_array_length(items) > 0 then
        perform public.receive_transfer_trip(trip.id, p_user, items, now(), null, null, p_idem || ':' || trip.trip_no, p_idem || ':' || trip.trip_no);
      end if;
    end loop;
    if exists (select 1 from jsonb_each_text(want) w where w.value::numeric > 0) then
      raise exception 'Cannot receive more than dispatched' using errcode = 'P0001'; end if;
    return p_id;
  end if;
  -- Transfers dispatched before 0030 (original behaviour).
  if t.status not in ('dispatched','partially_received') then
    raise exception 'Transfer is not in a receivable state' using errcode='P0001';
  end if;
  if p_idem is not null and not public.claim_idempotency(p_idem, 'receive_stock_transfer', p_id) then return p_id; end if;
  for item in select * from jsonb_array_elements(p_lines) loop
    select * into ln from public.stock_transfer_lines where id=(item->>'line_id')::uuid and transfer_id=p_id for update;
    if not found then raise exception 'Invalid transfer line' using errcode='P0001'; end if;
    qty := (item->>'qty')::numeric;
    if qty <= 0 then continue; end if;
    if ln.qty_received + qty > ln.qty_dispatched + 0.0001 then
      raise exception 'Cannot receive more than dispatched' using errcode='P0001';
    end if;
    perform public.record_stock_movement(t.company_id, t.destination_branch_id, ln.product_id,
      'transfer_in','stock_transfer', t.id, t.document_number, qty, 0, ln.unit_cost, p_user);
    perform public.adjust_in_transit(t.company_id, t.destination_branch_id, ln.product_id, -qty);
    update public.stock_transfer_lines set qty_received = ln.qty_received + qty where id=ln.id;
  end loop;
  select bool_and(qty_received >= qty_dispatched) into all_done from public.stock_transfer_lines where transfer_id=p_id;
  new_status := case when all_done then 'received' else 'partially_received' end;
  update public.stock_transfers set status=new_status where id=p_id;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (t.company_id, 'stock_transfer', p_id, t.status, new_status, p_user);
  return p_id;
end; $$;

create or replace function public.void_stock_transfer(p_id uuid, p_user uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t public.stock_transfers; ln record; trip record;
begin
  select * into t from public.stock_transfers where id=p_id for update;
  if not found then raise exception 'Transfer not found' using errcode='P0001'; end if;
  if t.status = 'voided' then raise exception 'Transfer already voided' using errcode='P0001'; end if;
  if coalesce(p_reason,'')='' then raise exception 'A reason is required' using errcode='P0001'; end if;
  perform public.assert_actor(p_user, t.company_id, 'transactions.void', t.source_branch_id);
  if t.posts_in_transit then
    if exists (select 1 from public.stock_transfer_dispatch_lines x join public.stock_transfer_dispatches d on d.id = x.dispatch_id
               where d.transfer_id = p_id and d.status <> 'voided' and x.qty_reported > 0) then
      raise exception 'Cargo of this transfer was already received; use discrepancy resolution or a return transfer' using errcode = 'P0001'; end if;
    for trip in select * from public.stock_transfer_dispatches where transfer_id = p_id and status = 'dispatched' order by trip_no loop
      perform public.void_transfer_trip(trip.id, p_user, p_reason, 'void_stock_transfer:' || trip.id);
    end loop;
    update public.stock_transfer_dispatches set status = 'voided', voided_at = now(), voided_by = p_user, void_reason = p_reason
      where transfer_id = p_id and status = 'draft';
    update public.stock_transfers set status='voided', voided_by=p_user, voided_at=now(), void_reason=p_reason, has_open_discrepancy = false where id=p_id;
    insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
      values (t.company_id, 'stock_transfer', p_id, t.status, 'voided', p_reason, p_user);
    perform public._transfer_event(p_id, null, 'voided', 'Transfer voided: ' || p_reason, p_user);
    return p_id;
  end if;
  if t.status = 'draft' then raise exception 'Delete the draft instead of voiding' using errcode='P0001'; end if;
  perform public.assert_period_open(t.company_id, t.transfer_date);
  for ln in select * from public.stock_transfer_lines where transfer_id=p_id loop
    if ln.qty_received > 0 then
      perform public.record_stock_movement(t.company_id, t.destination_branch_id, ln.product_id,
        'transfer_void','stock_transfer_void', t.id, t.document_number, 0, ln.qty_received, 0, p_user);
    end if;
    if ln.qty_dispatched > 0 then
      perform public.record_stock_movement(t.company_id, t.source_branch_id, ln.product_id,
        'transfer_void','stock_transfer_void', t.id, t.document_number, ln.qty_dispatched, 0, ln.unit_cost, p_user);
    end if;
    perform public.adjust_in_transit(t.company_id, t.destination_branch_id, ln.product_id, -(ln.qty_dispatched - ln.qty_received));
  end loop;
  update public.stock_transfers set status='voided', voided_by=p_user, voided_at=now(), void_reason=p_reason where id=p_id;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (t.company_id, 'stock_transfer', p_id, t.status, 'voided', p_reason, p_user);
  return p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 9. Delivery notes: a versioned snapshot per trip. A new version is issued
-- only when the content changed. No costs and no licence numbers.
-- Printing / downloading posts nothing.
-- ---------------------------------------------------------------------------
create or replace function public.delivery_note_snapshot(p_dispatch uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'company', jsonb_build_object('name', c.name, 'legal_name', c.legal_name, 'address', c.address, 'phone', c.phone, 'email', c.email),
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
  perform public._transfer_event(t.id, d.id, 'delivery_note', 'Delivery note ' || (snap->>'reference') || ' v' || (coalesce(last.version, 0) + 1) || ' issued', p_user);
  return query select nid, coalesce(last.version, 0) + 1, true;
end; $$;

-- ---------------------------------------------------------------------------
-- 10. Documents: trips own attachments / delivery notes; licence images need
-- documents.view_licence, transport invoices documents.view_financial.
-- ---------------------------------------------------------------------------
create or replace function public._document_owner(p_owner_type text, p_owner_id uuid,
  out company_id uuid, out branch_ids uuid[], out view_permission text)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_owner_type = 'import_shipment' then
    select s.company_id, array[s.branch_id], 'imports.view' into company_id, branch_ids, view_permission
      from public.import_shipments s where s.id = p_owner_id;
  elsif p_owner_type = 'import_receipt' then
    select r.company_id, array[r.branch_id], 'imports.view' into company_id, branch_ids, view_permission
      from public.import_receipts r where r.id = p_owner_id;
  elsif p_owner_type = 'cost_invoice' then
    select c.company_id, null::uuid[], 'documents.view_financial' into company_id, branch_ids, view_permission
      from public.cost_invoices c where c.id = p_owner_id;
  elsif p_owner_type = 'purchase' then
    select p.company_id, null::uuid[], 'documents.view_financial' into company_id, branch_ids, view_permission
      from public.purchases p where p.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view'
      into company_id, branch_ids, view_permission
      from public.stock_transfers t where t.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer_receipt' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view'
      into company_id, branch_ids, view_permission
      from public.stock_transfer_receipts r join public.stock_transfers t on t.id = r.transfer_id where r.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer_dispatch' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view'
      into company_id, branch_ids, view_permission
      from public.stock_transfer_dispatches d join public.stock_transfers t on t.id = d.transfer_id where d.id = p_owner_id;
  elsif p_owner_type = 'rebag_order' then
    select o.company_id, array[o.branch_id], 'rebagging.view' into company_id, branch_ids, view_permission
      from public.rebag_orders o where o.id = p_owner_id;
  end if;
  if company_id is null then
    raise exception 'Document owner not found' using errcode = 'P0001';
  end if;
end; $$;

create or replace function public.attachment_category_permission(p_category text)
returns text language sql immutable as $$
  select case when p_category in ('supplier_invoice','cost_invoice','transport_invoice') then 'documents.view_financial'
              when p_category = 'driver_licence' then 'documents.view_licence' end;
$$;

create or replace function public.register_attachment(
  p_user uuid, p_owner_type text, p_owner_id uuid, p_category text, p_storage_path text,
  p_original_filename text, p_download_name text, p_content_type text, p_size bigint, p_sha256 text,
  p_supersedes uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare o record; prev public.document_attachments; ver int := 1; new_id uuid; need text;
begin
  select * into o from public._document_owner(p_owner_type, p_owner_id);
  perform public.assert_feature(o.company_id, 'attachments');
  perform public.assert_actor(p_user, o.company_id, 'documents.upload');
  if not public.can_access_document_owner(p_user, p_owner_type, p_owner_id) then
    raise exception 'Not authorised for this document' using errcode = '42501';
  end if;
  need := public.attachment_category_permission(p_category);
  if need is not null and not public._user_can(p_user, need) then
    raise exception 'Not authorised for % documents', case when need = 'documents.view_licence' then 'driver licence' else 'financial' end using errcode = '42501';
  end if;
  if p_storage_path not like o.company_id::text || '/' || p_owner_type || '/' || p_owner_id::text || '/%' then
    raise exception 'Storage path does not match the document' using errcode = '23514';
  end if;
  if p_supersedes is not null then
    select * into prev from public.document_attachments where id = p_supersedes for update;
    if not found or prev.owner_type <> p_owner_type or prev.owner_id <> p_owner_id or prev.category <> p_category then
      raise exception 'Can only supersede an attachment of the same document and category' using errcode = '23514';
    end if;
    if exists (select 1 from public.document_attachments where supersedes_id = p_supersedes) then
      raise exception 'That attachment version was already superseded' using errcode = 'P0001';
    end if;
    ver := prev.version + 1;
  end if;
  insert into public.document_attachments(company_id, owner_type, owner_id, category, storage_path, original_filename,
      download_name, content_type, size_bytes, sha256, version, supersedes_id, uploaded_by)
    values (o.company_id, p_owner_type, p_owner_id, p_category, p_storage_path, left(p_original_filename, 255),
      p_download_name, p_content_type, p_size, p_sha256, ver, p_supersedes, p_user)
    returning id into new_id;
  return new_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 11. Row-level security: a transfer and everything under it is readable by
-- users of the sending or the receiving branch (Owner: all); unrelated
-- branches see nothing. Licence numbers are not readable by app users at all
-- (server code shows them only with documents.view_licence).
-- ---------------------------------------------------------------------------
-- The signed-in user's own branch access (no user id argument, so it cannot probe others).
create or replace function public.current_user_has_branch(p_branch uuid)
returns boolean language sql stable security definer set search_path = public as $q$
  select public._user_has_branch(auth.uid(), p_branch);
$q$;
revoke all on function public.current_user_has_branch(uuid) from public, anon;
grant execute on function public.current_user_has_branch(uuid) to authenticated, service_role;
drop policy if exists stock_transfers_select on public.stock_transfers;
create policy stock_transfers_select on public.stock_transfers for select to authenticated
  using (public.has_company_access(company_id)
         and (public.current_user_has_branch(source_branch_id) or public.current_user_has_branch(destination_branch_id)));
create or replace function public._rls_child_policy(child text, parent text, fk text)
returns void language plpgsql as $f$
begin
  execute format('alter table public.%I enable row level security', child);
  execute format('alter table public.%I force row level security', child);
  execute format('drop policy if exists %I on public.%I', child||'_select', child);
  execute format($q$create policy %I on public.%I for select to authenticated
    using (exists (select 1 from public.%I p where p.id = public.%I.%I and public.has_company_access(p.company_id)))$q$,
    child||'_select', child, parent, child, fk);
end $f$;
select public._rls_child_policy('stock_transfer_receipts', 'stock_transfers', 'transfer_id');
select public._rls_child_policy('stock_transfer_receipt_lines', 'stock_transfer_receipts', 'receipt_id');
select public._rls_child_policy('stock_transfer_agents', 'stock_transfers', 'transfer_id');
select public._rls_child_policy('stock_transfer_dispatches', 'stock_transfers', 'transfer_id');
select public._rls_child_policy('stock_transfer_events', 'stock_transfers', 'transfer_id');
select public._rls_child_policy('stock_transfer_dispatch_lines', 'stock_transfer_dispatches', 'dispatch_id');
select public._rls_child_policy('stock_transfer_dispatch_changes', 'stock_transfer_dispatches', 'dispatch_id');
select public._rls_child_policy('stock_transfer_resolutions', 'stock_transfer_receipt_lines', 'receipt_line_id');
do $$
declare t text; cols text;
begin
  foreach t in array array['stock_transfer_agents','stock_transfer_dispatches','stock_transfer_dispatch_lines','stock_transfer_dispatch_changes',
                           'stock_transfer_events','stock_transfer_resolutions'] loop
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  -- column-level: no licence numbers (or change history that may hold them) for app users
  foreach t in array array['stock_transfers','stock_transfer_dispatches'] loop
    select string_agg(quote_ident(column_name), ', ') into cols from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name <> 'driver_licence';
    execute format('revoke select on public.%I from authenticated', t);
    execute format('grant select (%s) on public.%I to authenticated', cols, t);
  end loop;
  revoke select on public.stock_transfer_dispatch_changes from authenticated;
end $$;
drop function public._rls_child_policy(text, text, text);

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             '_kg_per_unit','_transfer_event','_tdl_take','_transfer_refresh','_assert_transfer_party','dispatch_transfer_trip',
             'receive_transfer_trip','resolve_transfer_discrepancy','void_transfer_trip','change_transfer_trip_transport','add_transfer_update',
             '_apply_tdl_delta','_apply_transfer_delta','accrue_transfer_cost','_propagate_transfer','dispatch_stock_transfer',
             'receive_stock_transfer','void_stock_transfer','delivery_note_snapshot','issue_delivery_note','register_attachment') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
