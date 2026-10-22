-- ===========================================================================
-- 0031 — Stage 7: late costs, corrections and accounting close.
--
-- Completes the Stage 1 cost-delta algorithm across imports, purchases,
-- rebagging and transfers:
--   * cost_delta_lines: every TZS delta, split by where it went (stock held,
--     cost of sales per sale, loss, price variance, transfer / import transit,
--     rebagging WIP), with units and the source document — the evidence behind
--     each linked adjustment journal; cost_source_history keeps every change
--     of a cost line (estimate / accrual / actual / status);
--   * purchase landed costs (cost sources owned by a posted purchase: freight,
--     transport, handling) accrued or invoiced, propagated through the
--     weighted-average pools from the purchase receipt;
--   * purchase price adjustments (supplier debit / credit notes on goods
--     price, TZS) and credit notes beyond the open balance becoming supplier
--     credits; supplier refunds of credits in cash;
--   * reversal of a posted cost invoice (re-instates the accrual it replaced);
--   * sales returns / sale voids after a late cost bring that cost back to
--     stock with the units (and a return void takes it out again);
--   * catch-up reporting (late costs reaching sales of closed periods are
--     posted in the open period and flagged) and reconciliation checks.
-- Additive. Original documents and journals are never changed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Delta ledger and cost history
-- ---------------------------------------------------------------------------
create table if not exists public.cost_delta_lines (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  src_type    text not null,
  src_id      uuid not null,
  target      text not null check (target in ('stock','cogs','loss','ppv','transit','transit_legacy','import_transit','wip','return_restore')),
  branch_id   uuid references public.branches(id) on delete restrict,
  product_id  uuid references public.products(id) on delete restrict,
  ref_type    text,
  ref_id      uuid,
  units       numeric(28,10),
  amount      numeric(18,2) not null,
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists cost_delta_lines_src_idx on public.cost_delta_lines(src_type, src_id);
create index if not exists cost_delta_lines_ref_idx on public.cost_delta_lines(ref_type, ref_id);
drop trigger if exists trg_cost_delta_lines_immutable on public.cost_delta_lines;
create trigger trg_cost_delta_lines_immutable before update or delete on public.cost_delta_lines
  for each row execute function public.block_update_delete();

create or replace function public._dl(
  p_company uuid, p_src_type text, p_src_id uuid, p_target text, p_branch uuid, p_product uuid, p_ref_type text, p_ref_id uuid,
  p_units numeric, p_amount numeric
) returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(round(p_amount, 2), 0) = 0 or p_src_id is null then return; end if;
  insert into public.cost_delta_lines(company_id, src_type, src_id, target, branch_id, product_id, ref_type, ref_id, units, amount)
    values (p_company, p_src_type, p_src_id, p_target, p_branch, p_product, p_ref_type, p_ref_id, p_units, round(p_amount, 2));
end; $$;

create table if not exists public.cost_source_history (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  cost_source_id  uuid not null references public.cost_sources(id) on delete cascade,
  old_status      text, new_status text,
  old_estimated   numeric(18,2), new_estimated numeric(18,2),
  old_accrued     numeric(18,2), new_accrued numeric(18,2),
  old_actual      numeric(18,2), new_actual numeric(18,2),
  changed_by      uuid,
  changed_at      timestamptz not null default clock_timestamp()
);
create index if not exists cost_source_history_src_idx on public.cost_source_history(cost_source_id, changed_at);
create or replace function public.cost_sources_history_log()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.cost_source_history(company_id, cost_source_id, new_status, new_estimated, new_accrued, new_actual, changed_by)
      values (NEW.company_id, NEW.id, NEW.status, NEW.estimated_amount, NEW.accrued_amount, NEW.actual_amount, NEW.created_by);
  elsif (OLD.status, OLD.estimated_amount, OLD.accrued_amount, OLD.actual_amount) is distinct from (NEW.status, NEW.estimated_amount, NEW.accrued_amount, NEW.actual_amount) then
    insert into public.cost_source_history(company_id, cost_source_id, old_status, new_status, old_estimated, new_estimated, old_accrued, new_accrued, old_actual, new_actual, changed_by)
      values (NEW.company_id, NEW.id, OLD.status, NEW.status, OLD.estimated_amount, NEW.estimated_amount, OLD.accrued_amount, NEW.accrued_amount, OLD.actual_amount, NEW.actual_amount, NEW.updated_by);
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_cost_sources_history on public.cost_sources;
create trigger trg_cost_sources_history after insert or update on public.cost_sources
  for each row execute function public.cost_sources_history_log();
-- Existing cost lines start their history now.
insert into public.cost_source_history(company_id, cost_source_id, new_status, new_estimated, new_accrued, new_actual, changed_by)
  select s.company_id, s.id, s.status, s.estimated_amount, s.accrued_amount, s.actual_amount, s.updated_by from public.cost_sources s
  where not exists (select 1 from public.cost_source_history h where h.cost_source_id = s.id);

-- ---------------------------------------------------------------------------
-- 2. Purchase landed costs: cost sources owned by a posted purchase.
-- ---------------------------------------------------------------------------
alter table public.cost_sources add column if not exists purchase_id uuid references public.purchases(id) on delete restrict;
create index if not exists cost_sources_purchase_idx on public.cost_sources(purchase_id);
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.cost_sources'::regclass and contype = 'c'
             and conname not like '%_v2' and (pg_get_constraintdef(oid) ilike '%owner_type%' or pg_get_constraintdef(oid) ilike '%import_shipment_id IS NOT NULL%') loop
    execute format('alter table public.cost_sources drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'cost_sources_owner_v2') then
    alter table public.cost_sources add constraint cost_sources_owner_v2 check (
      owner_type in ('import_shipment','stock_transfer','rebag_order','purchase')
      and (import_shipment_id is not null)::int + (stock_transfer_id is not null)::int + (rebag_order_id is not null)::int + (purchase_id is not null)::int = 1
      and (owner_type = 'import_shipment') = (import_shipment_id is not null)
      and (owner_type = 'stock_transfer') = (stock_transfer_id is not null)
      and (owner_type = 'rebag_order') = (rebag_order_id is not null)
      and (owner_type = 'purchase') = (purchase_id is not null));
  end if;
end $$;
drop trigger if exists trg_cost_sources_company_purchase on public.cost_sources;
create trigger trg_cost_sources_company_purchase before insert or update on public.cost_sources
  for each row execute function public.check_company_consistency('purchase_id','purchases');

-- Category rule for purchases: categories usable on imports or transfers
-- (freight, transport, handling, duty ...); goods value never.
create or replace function public.cost_sources_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare cat public.cost_categories; sh public.import_shipments; pu public.purchases;
begin
  if TG_OP = 'INSERT' or NEW.cost_category_id is distinct from OLD.cost_category_id then
    if TG_OP = 'UPDATE' and OLD.status <> 'estimated' then
      raise exception 'The category of an accrued or invoiced cost cannot change' using errcode = 'P0001';
    end if;
    select * into cat from public.cost_categories where id = NEW.cost_category_id;
    if not cat.is_active then raise exception 'Cost category % is inactive', cat.code using errcode = '23514'; end if;
    if cat.is_goods_value then
      raise exception 'The goods value is recorded on the goods invoice, not as a cost source' using errcode = '23514';
    end if;
    if (NEW.owner_type = 'import_shipment' and not cat.applies_to_import)
       or (NEW.owner_type = 'stock_transfer' and not cat.applies_to_transfer)
       or (NEW.owner_type = 'rebag_order' and not cat.applies_to_rebagging)
       or (NEW.owner_type = 'purchase' and not (cat.applies_to_import or cat.applies_to_transfer)) then
      raise exception 'Cost category % does not apply to %', cat.code, NEW.owner_type using errcode = '23514';
    end if;
    NEW.inventory_treatment := cat.inventory_treatment;
    NEW.expense_account_id := cat.expense_account_id;
    NEW.include_in_commercial_cost := cat.include_in_commercial_cost;
    if NEW.allocation_basis is null or TG_OP = 'UPDATE' then
      NEW.allocation_basis := case cat.allocation_basis when 'net_weight' then 'weight' else cat.allocation_basis end;
    end if;
    if NEW.import_shipment_id is not null and cat.component is not null then
      select * into sh from public.import_shipments where id = NEW.import_shipment_id;
      if (cat.component = 'freight' and sh.goods_includes_freight)
         or (cat.component = 'insurance' and sh.goods_includes_insurance) then
        raise exception 'This shipment''s goods value already includes %; it cannot be added again', cat.component
          using errcode = '23514';
      end if;
    end if;
    if NEW.purchase_id is not null then
      select * into pu from public.purchases where id = NEW.purchase_id;
      if pu.document_status <> 'posted' or pu.posting_mode = 'invoice_only' then
        raise exception 'Landed costs attach to a posted stock purchase' using errcode = '23514';
      end if;
    end if;
  end if;
  if TG_OP = 'UPDATE' and OLD.status <> 'estimated' and (
       NEW.inventory_treatment, NEW.expense_account_id, NEW.include_in_commercial_cost, NEW.allocation_basis,
       NEW.owner_type, NEW.import_shipment_id, NEW.stock_transfer_id, NEW.rebag_order_id, NEW.purchase_id
     ) is distinct from (
       OLD.inventory_treatment, OLD.expense_account_id, OLD.include_in_commercial_cost, OLD.allocation_basis,
       OLD.owner_type, OLD.import_shipment_id, OLD.stock_transfer_id, OLD.rebag_order_id, OLD.purchase_id) then
    raise exception 'The classification of an accrued or invoiced cost is frozen' using errcode = 'P0001';
  end if;
  if TG_OP = 'UPDATE' and OLD.status = 'voided' and NEW.status <> 'voided' then
    raise exception 'A voided cost source cannot be reopened' using errcode = 'P0001';
  end if;
  if NEW.inventory_treatment = 'expense' and NEW.expense_account_id is null then
    raise exception 'An expensed cost needs an expense account' using errcode = '23514';
  end if;
  return NEW;
end; $$;

-- Spread an amount over a purchase line's receipt movement(s) and follow it.
create or replace function public._apply_purchase_line_delta(
  p_line uuid, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare ln public.purchase_lines; v public.purchases; mvs jsonb; a record; m public.stock_movements; jl jsonb := '[]'::jsonb;
begin
  if round(p_amount, 2) = 0 then return '[]'::jsonb; end if;
  select * into ln from public.purchase_lines where id = p_line;
  select * into v from public.purchases where id = ln.purchase_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'factor', qty_in) order by created_at, id), '[]'::jsonb) into mvs
    from public.stock_movements where source_id = v.id and movement_type = 'purchase' and product_id = ln.product_id and qty_in > 0;
  if jsonb_array_length(mvs) = 0 then
    raise exception 'The purchase line has no stock receipt to carry a cost' using errcode = 'P0001'; end if;
  for a in select * from public.allocate_amount(round(p_amount, 2), 'quantity', mvs) loop
    select * into m from public.stock_movements where id = a.target_id;
    jl := jl || public._propagate_from_movement(v.company_id, m.branch_id, m.product_id, m.created_at, m.id, m.qty_in, a.amount,
                  p_src_type, p_src_id, p_docnum, p_user, 0);
  end loop;
  return jl;
end; $$;

create or replace function public._apply_purchase_delta(
  p_source uuid, p_delta numeric, p_date date, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.cost_sources; v public.purchases; t jsonb := '[]'::jsonb; e jsonb; ln record; a record; run uuid; jl jsonb := '[]'::jsonb; f numeric;
begin
  if p_delta = 0 then return '[]'::jsonb; end if;
  select * into s from public.cost_sources where id = p_source for update;
  select * into v from public.purchases where id = s.purchase_id for update;
  if v.document_status <> 'posted' then raise exception 'The purchase is %; its landed costs cannot change', v.document_status using errcode = 'P0001'; end if;
  if s.allocation_basis in ('direct','manual','percent') then
    if s.allocation_targets is null or jsonb_array_length(s.allocation_targets) = 0 then
      raise exception 'Choose the purchase line(s) for a % allocation', s.allocation_basis using errcode = 'P0001'; end if;
    for e in select * from jsonb_array_elements(s.allocation_targets) loop
      if not exists (select 1 from public.purchase_lines where id = (e->>'id')::uuid and purchase_id = v.id and track_inventory and quantity > 0) then
        raise exception 'Allocation target is not a stock line of this purchase' using errcode = '23514'; end if;
      t := t || e;
    end loop;
  else
    for ln in select pl.*, public._kg_per_unit(pl.product_id) kg from public.purchase_lines pl where pl.purchase_id = v.id and pl.track_inventory and pl.quantity > 0 order by pl.line_no, pl.id loop
      f := case s.allocation_basis when 'weight' then ln.quantity * ln.kg when 'quantity' then ln.quantity when 'value' then ln.inventory_value end;
      if f is null then raise exception 'Net kg of a purchase line is unknown; allocate this cost by value' using errcode = 'P0001'; end if;
      t := t || jsonb_build_object('id', ln.id, 'factor', f);
    end loop;
  end if;
  if jsonb_array_length(t) = 0 then raise exception 'The purchase has no stock lines' using errcode = 'P0001'; end if;
  insert into public.cost_allocation_runs(company_id, cost_source_id, amount_kind, basis, total_amount, is_current, created_by)
    values (s.company_id, s.id, 'delta', s.allocation_basis, p_delta, false, p_user) returning id into run;
  for a in select * from public.allocate_amount(round(p_delta, 2),
             case when s.allocation_basis in ('direct','manual','percent') then s.allocation_basis else 'value' end, t) loop
    insert into public.cost_allocations(company_id, run_id, target_type, target_id, factor, amount)
      values (s.company_id, run, 'purchase_line', a.target_id, (select (x->>'factor')::numeric from jsonb_array_elements(t) x where (x->>'id')::uuid = a.target_id), a.amount);
    jl := jl || public._apply_purchase_line_delta(a.target_id, a.amount, p_src_type, p_src_id, p_docnum, p_user);
  end loop;
  return jl;
end; $$;
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.cost_allocations'::regclass and contype = 'c'
             and conname <> 'cost_allocations_target_v2' and pg_get_constraintdef(oid) ilike '%target_type%' loop
    execute format('alter table public.cost_allocations drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'cost_allocations_target_v2') then
    alter table public.cost_allocations add constraint cost_allocations_target_v2 check (target_type in (
      'import_shipment_line','import_receipt_line','stock_transfer_line','rebag_output','purchase_line'));
  end if;
end $$;

create or replace function public.accrue_purchase_cost(p_source uuid, p_amount numeric, p_date date, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.cost_sources; v public.purchases; jl jsonb;
begin
  perform public._require_key(p_idem);
  select * into s from public.cost_sources where id = p_source for update;
  if not found or s.owner_type <> 'purchase' then raise exception 'Purchase cost not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'accrue_purchase_cost', p_source) then return p_source; end if;
  select * into v from public.purchases where id = s.purchase_id for update;
  perform public.assert_actor(p_user, s.company_id, 'purchases.post', v.branch_id);
  if s.status <> 'estimated' then raise exception 'Only an estimated cost can be accrued (it is %)', s.status using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Accrual must be a positive amount with at most 2 decimals' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'accrue_purchase_cost', p_source) then return p_source; end if;
  perform public.assert_period_open(s.company_id, p_date);
  if s.inventory_treatment = 'capitalize' then
    jl := public._apply_purchase_delta(s.id, p_amount, p_date, 'cost_accrual', s.id, v.document_number, p_user);
  else
    jl := public._jl(s.expense_account_id, p_amount, 'Accrued purchase cost (expensed)');
  end if;
  jl := jl || public._jl(public.account_for(s.company_id, 'import.accrued_costs'), -p_amount, 'Accrued purchase cost');
  perform public.create_journal(s.company_id, v.branch_id, p_date, 'cost_accrual', s.id, v.document_number,
    'Accrued cost on purchase ' || v.document_number, p_user, jl);
  update public.cost_sources set status = 'accrued', accrued_amount = p_amount, accrual_date = p_date, updated_by = p_user where id = s.id;
  return p_source;
end; $$;

-- A purchase whose landed costs were accrued or invoiced cannot be voided
-- until those are credited (the void would leave their value behind).
create or replace function public.purchases_block_void_with_costs()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if OLD.document_status = 'posted' and NEW.document_status = 'voided' and exists (
       select 1 from public.cost_sources where purchase_id = NEW.id and status in ('accrued','invoiced')
         and not (status = 'invoiced' and actual_amount = 0)) then
    raise exception 'Landed costs were posted on this purchase; credit them before voiding it' using errcode = 'P0001';
  end if;
  if OLD.document_status = 'posted' and NEW.document_status = 'voided' and exists (
       select 1 from public.purchase_cost_adjustments where purchase_id = NEW.id and document_status = 'posted') then
    raise exception 'Price adjustments were posted on this purchase; it cannot be voided' using errcode = 'P0001';
  end if;
  return NEW;
end; $$;

-- ---------------------------------------------------------------------------
-- 3. Purchase price adjustments (supplier debit / credit notes on goods price).
-- TZS purchases. The payable changes once (debit note: Cr 2110; credit note:
-- Dr 2110, beyond the open balance a supplier credit 1170); the inventory
-- side follows the goods through the weighted-average pools.
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_cost_adjustments (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete restrict,
  purchase_id        uuid not null references public.purchases(id) on delete restrict,
  kind               text not null check (kind in ('debit_note','credit_note')),
  document_status    text not null default 'draft' check (document_status in ('draft','posted')),
  document_number    text,
  document_date      date not null default current_date,
  supplier_reference text,
  reason             text not null,
  total              numeric(18,2) not null default 0,
  payable_delta      numeric(18,2) not null default 0,
  credit_created     numeric(18,2) not null default 0,
  client_request_id  text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  posted_at  timestamptz,
  posted_by  uuid references auth.users(id) on delete set null
);
create unique index if not exists purchase_cost_adjustments_client_request on public.purchase_cost_adjustments(company_id, client_request_id) where client_request_id is not null;
drop trigger if exists trg_pca_company on public.purchase_cost_adjustments;
create trigger trg_pca_company before insert or update on public.purchase_cost_adjustments
  for each row execute function public.check_company_consistency('purchase_id','purchases');
create table if not exists public.purchase_cost_adjustment_lines (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  adjustment_id    uuid not null references public.purchase_cost_adjustments(id) on delete cascade,
  purchase_line_id uuid not null references public.purchase_lines(id) on delete restrict,
  amount           numeric(18,2) not null check (amount > 0)
);
drop trigger if exists trg_pcal_company on public.purchase_cost_adjustment_lines;
create trigger trg_pcal_company before insert or update on public.purchase_cost_adjustment_lines
  for each row execute function public.check_company_consistency('adjustment_id','purchase_cost_adjustments');

drop trigger if exists trg_purchases_block_void_costs on public.purchases;
create trigger trg_purchases_block_void_costs before update of document_status on public.purchases
  for each row execute function public.purchases_block_void_with_costs();

create or replace function public.post_purchase_cost_adjustment(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a public.purchase_cost_adjustments; v public.purchases; pb public.supplier_payables; ln record; sgn int; v_total numeric(18,2) := 0;
  jl jsonb := '[]'::jsonb; docnum text; payred numeric(18,2) := 0; credit numeric(18,2) := 0; keys jsonb;
begin
  perform public._require_key(p_idem);
  select * into a from public.purchase_cost_adjustments where id = p_id for update;
  if not found then raise exception 'Adjustment not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'post_purchase_cost_adjustment', p_id) then return p_id; end if;
  select * into v from public.purchases where id = a.purchase_id for update;
  perform public.assert_actor(p_user, a.company_id, 'purchases.post', v.branch_id);
  if a.document_status <> 'draft' then raise exception 'Adjustment already %', a.document_status using errcode = 'P0001'; end if;
  if v.document_status <> 'posted' or v.posting_mode = 'invoice_only' then
    raise exception 'Price adjustments apply to posted stock purchases (import invoices are corrected on the shipment)' using errcode = 'P0001'; end if;
  if v.currency_code <> 'TZS' then
    raise exception 'Foreign-currency purchases are corrected with a supplier credit or a return' using errcode = 'P0001'; end if;
  if coalesce(trim(a.reason), '') = '' then raise exception 'A reason is required' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.purchase_cost_adjustment_lines where adjustment_id = p_id) then
    raise exception 'Enter the amount per purchase line' using errcode = 'P0001'; end if;
  if exists (select 1 from public.purchase_cost_adjustment_lines x join public.purchase_lines pl on pl.id = x.purchase_line_id
             where x.adjustment_id = p_id and (pl.purchase_id <> v.id or not pl.track_inventory)) then
    raise exception 'Adjustment lines must be stock lines of the purchase' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'post_purchase_cost_adjustment', p_id) then return p_id; end if;
  perform public.assert_period_open(a.company_id, a.document_date);
  select jsonb_agg(distinct jsonb_build_object('branch_id', m.branch_id, 'product_id', m.product_id)) into keys
    from public.stock_movements m where m.company_id = a.company_id and m.product_id in (
      select pl.product_id from public.purchase_cost_adjustment_lines x join public.purchase_lines pl on pl.id = x.purchase_line_id where x.adjustment_id = p_id);
  if keys is not null then perform public.lock_stock_balances(a.company_id, keys); end if;
  sgn := case when a.kind = 'debit_note' then 1 else -1 end;
  docnum := coalesce(v.document_number, '') || case when a.kind = 'debit_note' then '-DN' else '-CN' end
    || (select count(*) + 1 from public.purchase_cost_adjustments where purchase_id = v.id and document_status = 'posted');
  for ln in select * from public.purchase_cost_adjustment_lines where adjustment_id = p_id order by id loop
    v_total := v_total + ln.amount;
    jl := jl || public._apply_purchase_line_delta(ln.purchase_line_id, sgn * ln.amount, 'purchase_cost_adjustment', p_id, docnum, p_user);
  end loop;
  select * into pb from public.supplier_payables where purchase_id = v.id for update;
  if sgn > 0 then
    jl := jl || public._jl(public.account_id_by_code(a.company_id, '2110'), -v_total, 'Supplier debit note ' || coalesce(a.supplier_reference, ''));
    if pb.id is null then
      insert into public.supplier_payables(company_id, branch_id, supplier_id, source_type, purchase_id, original_amount, outstanding, status)
        values (v.company_id, v.branch_id, v.supplier_id, 'purchase', v.id, 0, v_total, 'open');
    else
      update public.supplier_payables set outstanding = outstanding + v_total, status = 'partial' where id = pb.id;
    end if;
    payred := -v_total;
  else
    payred := least(coalesce(pb.outstanding, 0), v_total);
    credit := v_total - payred;
    if payred > 0 then
      update public.supplier_payables set outstanding = outstanding - payred,
        status = case when outstanding - payred <= 0 then 'settled' else 'partial' end where id = pb.id;
      jl := jl || public._jl(public.account_id_by_code(a.company_id, '2110'), payred, 'Supplier credit note ' || coalesce(a.supplier_reference, ''));
    end if;
    if credit > 0 then
      insert into public.supplier_credits(company_id, supplier_id, amount, remaining, status, currency_code, fc_amount, fc_remaining, credit_date)
        values (v.company_id, v.supplier_id, credit, credit, 'open', 'TZS', credit, credit, a.document_date);
      jl := jl || public._jl(public.account_id_by_code(a.company_id, '1170'), credit, 'Supplier credit (invoice already paid)');
    end if;
  end if;
  perform public.create_journal(a.company_id, v.branch_id, a.document_date, 'purchase_cost_adjustment', a.id, docnum,
    case when sgn > 0 then 'Supplier debit note on ' else 'Supplier credit note on ' end || coalesce(v.document_number, ''), p_user, jl);
  update public.purchase_cost_adjustments set document_status = 'posted', document_number = docnum, total = v_total, payable_delta = payred,
    credit_created = credit, posted_at = now(), posted_by = p_user where id = p_id;
  return p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 4. Supplier refund: the supplier pays back an open credit (TZS).
-- Dr bank / cash, Cr 1170 supplier credits.
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_credit_refunds (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete restrict,
  credit_id          uuid not null references public.supplier_credits(id) on delete restrict,
  payment_account_id uuid not null references public.payment_accounts(id) on delete restrict,
  amount             numeric(18,2) not null check (amount > 0),
  refund_date        date not null,
  reference          text,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);
drop trigger if exists trg_scr_immutable on public.supplier_credit_refunds;
create trigger trg_scr_immutable before update or delete on public.supplier_credit_refunds
  for each row execute function public.block_update_delete();

create or replace function public.refund_supplier_credit(
  p_credit uuid, p_payment_account uuid, p_amount numeric, p_date date, p_reference text, p_user uuid, p_idem text
) returns uuid language plpgsql security definer set search_path = public as $$
declare c public.supplier_credits; pa public.payment_accounts; rid uuid;
begin
  perform public._require_key(p_idem);
  select * into c from public.supplier_credits where id = p_credit for update;
  if not found then raise exception 'Supplier credit not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'refund_supplier_credit', p_credit) then return p_credit; end if;
  perform public.assert_actor(p_user, c.company_id, 'purchases.record_payment');
  select * into pa from public.payment_accounts where id = p_payment_account;
  if pa.id is null or pa.company_id <> c.company_id then raise exception 'Choose a cash or bank account of this company' using errcode = 'P0001'; end if;
  if c.currency_code <> 'TZS' then raise exception 'Foreign-currency credits are used against invoices, not refunded here' using errcode = 'P0001'; end if;
  if c.status <> 'open' or p_amount is null or p_amount <= 0 or p_amount > c.remaining then
    raise exception 'Refund must be positive and at most the open credit (%)', c.remaining using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'refund_supplier_credit', p_credit) then return p_credit; end if;
  perform public.assert_period_open(c.company_id, p_date);
  insert into public.supplier_credit_refunds(company_id, credit_id, payment_account_id, amount, refund_date, reference, created_by)
    values (c.company_id, c.id, p_payment_account, round(p_amount, 2), p_date, p_reference, p_user) returning id into rid;
  update public.supplier_credits set remaining = remaining - round(p_amount, 2), fc_remaining = fc_remaining - round(p_amount, 2),
    status = case when remaining - round(p_amount, 2) <= 0 then 'used' else 'open' end where id = c.id;
  perform public.create_journal(c.company_id, null, p_date, 'supplier_refund', rid, coalesce(p_reference, 'Supplier refund'),
    'Supplier refund', p_user,
    public._jl(public.resolve_payment_ledger(c.company_id, p_payment_account), round(p_amount, 2), 'Refund received from supplier')
    || public._jl(public.account_id_by_code(c.company_id, '1170'), -round(p_amount, 2), 'Supplier credit refunded'));
  return rid;
end; $$;

-- ---------------------------------------------------------------------------
-- 5. Sales returns and sale voids after a late cost: the late cost that went
-- to cost of sales for those units comes back to stock with them; voiding the
-- return takes it out again. Ratio = units returned / units sold on the sale.
-- ---------------------------------------------------------------------------
create or replace function public._late_cost_return(
  p_company uuid, p_branch uuid, p_sale uuid, p_product uuid, p_qty numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare a numeric; restored numeric; sold numeric; amt numeric(18,2); unabs numeric(18,2);
begin
  select coalesce(sum(amount), 0) into a from public.cost_delta_lines where ref_type = 'sale' and ref_id = p_sale and product_id = p_product and target = 'cogs';
  if a = 0 then return '[]'::jsonb; end if;
  select coalesce(sum(amount), 0) into restored from public.cost_delta_lines where ref_type = 'sale' and ref_id = p_sale and product_id = p_product and target = 'return_restore';
  select coalesce(sum(quantity), 0) into sold from public.sale_lines where sale_id = p_sale and product_id = p_product;
  if sold <= 0 then return '[]'::jsonb; end if;
  amt := least(round(a * least(p_qty / sold, 1), 2), a - restored);
  if amt = 0 then return '[]'::jsonb; end if;
  unabs := public._stock_value_adjust(p_company, p_branch, p_product, amt, p_src_type, p_src_id, p_docnum, p_user);
  perform public._dl(p_company, p_src_type, p_src_id, 'return_restore', p_branch, p_product, 'sale', p_sale, p_qty, amt - unabs);
  return public._jl(public.account_id_by_code(p_company, '1150'), amt - unabs, 'Late cost back to stock')
      || public._jl(public.account_for(p_company, 'inventory.cost_of_sales'), -(amt - unabs), 'Late cost reversed from cost of sales');
end; $$;

create or replace function public.sales_returns_late_cost()
returns trigger language plpgsql security definer set search_path = public as $$
declare ln record; removed numeric(18,2); drift numeric(18,2); x record; d date; jl jsonb := '[]'::jsonb;
begin
  if OLD.document_status = 'draft' and NEW.document_status = 'posted' then
    for ln in select product_id, sum(quantity) q from public.sales_return_lines
              where return_id = NEW.id and track_inventory and condition = 'saleable' group by product_id order by product_id loop
      jl := jl || public._late_cost_return(NEW.company_id, NEW.branch_id, NEW.sale_id, ln.product_id, ln.q, 'sales_return', NEW.id, NEW.document_number,
        coalesce(NEW.posted_by, NEW.created_by));
    end loop;
    perform public.create_journal(NEW.company_id, NEW.branch_id, NEW.document_date, 'late_cost_return', NEW.id, NEW.document_number,
      'Late cost follows returned units ' || coalesce(NEW.document_number, ''), coalesce(NEW.posted_by, NEW.created_by), jl);
  elsif OLD.document_status = 'posted' and NEW.document_status = 'voided' then
    -- The void takes the units out at the current average (which includes
    -- any late cost they carry) but credits 1150 with the original cost
    -- restored: align the GL with the stock subledger (Stage 1 D1 for this
    -- path) and release the late-cost restore of this return in the ledger.
    d := (now() at time zone 'Africa/Dar_es_Salaam')::date;
    select coalesce(sum(movement_value), 0) into removed from public.stock_movements
      where source_id = NEW.id and movement_type = 'sales_return_void';
    drift := round(removed - coalesce(NEW.cogs_restored, 0), 2);
    perform public.create_journal(NEW.company_id, NEW.branch_id, d, 'late_cost_return_void', NEW.id, NEW.document_number,
      'Return void at average cost ' || coalesce(NEW.document_number, ''), NEW.voided_by,
      public._jl(public.account_for(NEW.company_id, 'inventory.cost_of_sales'), drift, 'Returned units leave at average cost')
      || public._jl(public.account_id_by_code(NEW.company_id, '1150'), -drift, 'Stock removed at average'));
    for x in select product_id, branch_id, ref_id, sum(units) u, sum(amount) a from public.cost_delta_lines
             where src_type = 'sales_return' and src_id = NEW.id and target = 'return_restore' group by product_id, branch_id, ref_id loop
      insert into public.cost_delta_lines(company_id, src_type, src_id, target, branch_id, product_id, ref_type, ref_id, units, amount)
        values (NEW.company_id, 'sales_return_void', NEW.id, 'return_restore', x.branch_id, x.product_id, 'sale', x.ref_id, -x.u, -x.a);
    end loop;
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_sales_returns_late_cost on public.sales_returns;
create trigger trg_sales_returns_late_cost after update of document_status on public.sales_returns
  for each row execute function public.sales_returns_late_cost();

create or replace function public.sales_late_cost_void()
returns trigger language plpgsql security definer set search_path = public as $$
declare ln record; jl jsonb := '[]'::jsonb;
begin
  if not (OLD.document_status = 'posted' and NEW.document_status = 'voided') then return NEW; end if;
  for ln in select product_id, sum(quantity) q from public.sale_lines where sale_id = NEW.id and track_inventory group by product_id order by product_id loop
    jl := jl || public._late_cost_return(NEW.company_id, NEW.branch_id, NEW.id, ln.product_id, ln.q, 'sale_void', NEW.id, NEW.document_number,
      coalesce(NEW.voided_by, NEW.posted_by));
  end loop;
  perform public.create_journal(NEW.company_id, NEW.branch_id, (now() at time zone 'Africa/Dar_es_Salaam')::date, 'late_cost_sale_void', NEW.id, NEW.document_number,
    'Late cost follows units of voided sale ' || coalesce(NEW.document_number, ''), coalesce(NEW.voided_by, NEW.posted_by), jl);
  return NEW;
end; $$;
drop trigger if exists trg_sales_late_cost_void on public.sales;
create trigger trg_sales_late_cost_void after update of document_status on public.sales
  for each row execute function public.sales_late_cost_void();

-- ---------------------------------------------------------------------------
-- 5b. Propagation functions, unchanged except that every part of a delta is
-- recorded in cost_delta_lines (where it went, units, reference).
-- ---------------------------------------------------------------------------
create or replace function public._propagate_from_movement(
  p_company uuid, p_branch uuid, p_product uuid, p_start_at timestamptz, p_start_id uuid,
  p_units numeric, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_depth int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mv record; remaining numeric := p_units; take numeric; before numeric; parts jsonb := '[]'::jsonb;
  s record; jl jsonb := '[]'::jsonb; unabsorbed numeric(18,2); kind text;
  sold jsonb := '{}'::jsonb; doc uuid; tot numeric; back numeric; k text; typ text;
begin
  if p_amount = 0 or p_units <= 0 then return '[]'::jsonb; end if;
  if p_depth > 10 then raise exception 'Cost propagation chain too deep' using errcode = 'P0001'; end if;
  for mv in select * from public.stock_movements
            where company_id = p_company and branch_id = p_branch and product_id = p_product
              and (created_at, id) > (p_start_at, p_start_id)
              and ((qty_out > 0 and movement_type <> 'rebag_void')
                or (qty_in > 0 and movement_type in ('sale_void','sales_return','rebag_return','rebag_void')))
            order by created_at, id loop
    if mv.qty_in > 0 then
      if mv.movement_type in ('sale_void','sales_return') then
        typ := 'sale';
        doc := case when mv.movement_type = 'sale_void' then mv.source_id
                    else (select r.sale_id from public.sales_returns r where r.id = mv.source_id) end;
      else
        typ := 'rebag'; doc := mv.source_id;
      end if;
      k := doc::text;
      if doc is null or not (sold ? k) then continue; end if;
      select coalesce(sum(qty_out), 0) into tot from public.stock_movements
        where source_id = doc and branch_id = p_branch and product_id = p_product
          and movement_type = any(case when typ = 'sale' then array['sale'] else array['rebag_issue','rebag_consume'] end);
      if tot <= 0 then continue; end if;
      back := least((sold->k->>'cur')::numeric, (sold->k->>'orig')::numeric * mv.qty_in / tot);
      if back <= 0 then continue; end if;
      sold := jsonb_set(sold, array[k, 'cur'], to_jsonb((sold->k->>'cur')::numeric - back));
      remaining := remaining + back;
      continue;
    end if;
    if remaining <= 0 then continue; end if;
    before := mv.balance_qty + mv.qty_out;
    if before <= 0 then continue; end if;
    take := least(remaining, remaining * mv.qty_out / before);
    remaining := remaining - take;
    if mv.movement_type in ('sale','rebag_issue','rebag_consume') then
      k := mv.source_id::text;
      sold := jsonb_set(sold, array[k], jsonb_build_object(
                'orig', coalesce((sold->k->>'orig')::numeric, 0) + take,
                'cur',  coalesce((sold->k->>'cur')::numeric, 0) + take,
                'typ',  case when mv.movement_type = 'sale' then 'sale' else 'rebag' end));
      continue;
    end if;
    kind := case mv.movement_type
              when 'sales_return_void' then 'cogs'
              when 'adjustment_decrease' then 'loss' when 'adjustment_void' then 'loss' when 'import_receipt_void' then 'loss'
              when 'purchase_return' then 'ppv'
              when 'transfer_out' then 'transfer'
              else 'cogs' end;
    parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', kind, 'factor', take, 'mv', mv.id);
  end loop;
  for k in select jsonb_object_keys(sold) loop
    if (sold->k->>'cur')::numeric > 0 then
      parts := parts || jsonb_build_object('id', gen_random_uuid(),
                 'kind', case when sold->k->>'typ' = 'sale' then 'cogs' else 'rebag' end,
                 'factor', (sold->k->>'cur')::numeric, 'doc', k);
    end if;
  end loop;
  if remaining > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'held', 'factor', remaining); end if;
  if jsonb_array_length(parts) = 0 then
    parts := jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'kind', 'cogs', 'factor', 1));
  end if;

  for s in select p.value as part, a.amount from jsonb_array_elements(parts) p
           join public.allocate_amount(round(p_amount, 2), 'quantity', parts) a on a.target_id = (p.value->>'id')::uuid loop
    kind := s.part->>'kind';
    if kind = 'held' then
      unabsorbed := public._stock_value_adjust(p_company, p_branch, p_product, s.amount, p_src_type, p_src_id, p_docnum, p_user);
      jl := jl || public._jl(public.account_id_by_code(p_company, '1150'), s.amount - unabsorbed, 'Late cost to stock held')
               || public._jl(public.account_for(p_company, 'inventory.cost_of_sales'), unabsorbed, 'Late cost (stock no longer held)');
      perform public._dl(p_company, p_src_type, p_src_id, 'stock', p_branch, p_product, 'movement', p_start_id, (s.part->>'factor')::numeric, s.amount - unabsorbed);
      perform public._dl(p_company, p_src_type, p_src_id, 'cogs', p_branch, p_product, 'movement', p_start_id, null, unabsorbed);
    elsif kind = 'cogs' then
      jl := jl || public._jl(public.account_for(p_company, 'inventory.cost_of_sales'), s.amount, 'Late cost to cost of sales');
      perform public._dl(p_company, p_src_type, p_src_id, 'cogs', p_branch, p_product, case when s.part ? 'doc' then 'sale' else 'movement' end,
        coalesce((s.part->>'doc')::uuid, (s.part->>'mv')::uuid), case when s.part ? 'doc' or s.part ? 'mv' then (s.part->>'factor')::numeric end, s.amount);
    elsif kind = 'loss' then
      jl := jl || public._jl(public.account_for(p_company, 'inventory.loss'), s.amount, 'Late cost to stock written off');
      perform public._dl(p_company, p_src_type, p_src_id, 'loss', p_branch, p_product, 'movement', (s.part->>'mv')::uuid, (s.part->>'factor')::numeric, s.amount);
    elsif kind = 'ppv' then
      jl := jl || public._jl(public.account_for(p_company, 'inventory.price_variance'), s.amount, 'Late cost to returned stock');
      perform public._dl(p_company, p_src_type, p_src_id, 'ppv', p_branch, p_product, 'movement', (s.part->>'mv')::uuid, (s.part->>'factor')::numeric, s.amount);
    elsif kind = 'rebag' then
      jl := jl || public._propagate_rebag((s.part->>'doc')::uuid, p_product, s.amount, p_src_type, p_src_id, p_docnum, p_user, p_depth);
    else
      jl := jl || public._propagate_transfer((s.part->>'mv')::uuid, (s.part->>'factor')::numeric, s.amount,
                    p_src_type, p_src_id, p_docnum, p_user, p_depth);
    end if;
  end loop;
  return jl;
end; $$;

create or replace function public._propagate_rebag(
  p_order uuid, p_product uuid, p_amount numeric, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_depth int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.rebag_orders; t jsonb := '[]'::jsonb; a record; op record; ip record; jl jsonb := '[]'::jsonb;
  consumed numeric; f numeric; out_bags numeric; loss_id uuid := gen_random_uuid(); mv public.stock_movements;
begin
  if p_amount = 0 then return '[]'::jsonb; end if;
  select * into o from public.rebag_orders where id = p_order for update;
  if o.document_status = 'issued' then
    -- Still in production: the bulk held on the order carries the cost.
    perform set_config('letiq.rebag_posting', 'on', true);
    update public.rebag_orders set issued_value = issued_value + p_amount, issue_unit_cost = round((issued_value + p_amount) / issued_kg, 4)
      where id = p_order;
    perform set_config('letiq.rebag_posting', 'off', true);
    perform public._dl(o.company_id, p_src_type, p_src_id, 'wip', o.branch_id, p_product, 'rebag_order', o.id, null, p_amount);
    return public._jl(public.account_for(o.company_id, 'inventory.bulk'), p_amount, 'Late cost to bulk in rebagging ' || o.document_number);
  end if;
  if o.document_status <> 'completed' then
    perform public._dl(o.company_id, p_src_type, p_src_id, 'cogs', o.branch_id, p_product, 'rebag_order', o.id, null, p_amount);
    return public._jl(public.account_for(o.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (reversed rebagging)');
  end if;
  if p_product = o.bulk_product_id then
    -- Consumed kg = packed kg + normal loss + abnormal loss. Outputs carry the
    -- packed kg plus the normal loss (in proportion to kg); abnormal loss is
    -- expensed, as at completion.
    consumed := o.issued_kg - o.returned_kg;
    select sum(net_kg) into f from public.rebag_outputs where order_id = p_order;
    for op in select * from public.rebag_outputs where order_id = p_order order by line_no, id loop
      t := t || jsonb_build_object('id', op.id, 'factor', op.net_kg * (consumed - o.abnormal_loss_kg) / f);
    end loop;
    if o.abnormal_loss_kg > 0 then t := t || jsonb_build_object('id', loss_id, 'factor', o.abnormal_loss_kg); end if;
  else
    select sum(bags) into out_bags from public.rebag_outputs where order_id = p_order;
    for op in select * from public.rebag_outputs where order_id = p_order order by line_no, id loop
      f := 0;
      for ip in select * from public.rebag_inputs where order_id = p_order and input_kind = 'packaging' and product_id = p_product loop
        f := f + case when ip.target_output_id = op.id then ip.quantity
                      when ip.target_output_id is null then ip.quantity * op.bags / out_bags else 0 end;
      end loop;
      if f > 0 then t := t || jsonb_build_object('id', op.id, 'factor', f); end if;
    end loop;
  end if;
  if jsonb_array_length(t) = 0 then
    perform public._dl(o.company_id, p_src_type, p_src_id, 'cogs', o.branch_id, p_product, 'rebag_order', o.id, null, p_amount);
    return public._jl(public.account_for(o.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (untraced rebagging)');
  end if;
  for a in select * from public.allocate_amount(round(p_amount, 2), 'quantity', t) loop
    if a.target_id = loss_id then
      jl := jl || public._jl(public.account_for(o.company_id, 'inventory.loss'), a.amount, 'Late cost to abnormal rebagging loss');
      perform public._dl(o.company_id, p_src_type, p_src_id, 'loss', o.branch_id, p_product, 'rebag_order', o.id, o.abnormal_loss_kg, a.amount);
      continue;
    end if;
    select * into op from public.rebag_outputs where id = a.target_id;
    select * into mv from public.stock_movements where id = op.movement_id;
    perform set_config('letiq.rebag_posting', 'on', true);
    update public.rebag_outputs set cost_delta_tzs = cost_delta_tzs + a.amount where id = op.id;
    perform set_config('letiq.rebag_posting', 'off', true);
    jl := jl || public._propagate_from_movement(o.company_id, o.branch_id, op.product_id, mv.created_at, mv.id, op.bags, a.amount,
                  p_src_type, p_src_id, p_docnum, p_user, p_depth + 1);
  end loop;
  return jl;
end; $$;

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
      perform public._dl(t.company_id, p_src_type, p_src_id, 'transit', t.destination_branch_id, l.product_id, 'transfer_trip_line', dl.id, pool, s.amount);
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
      perform public._dl(t.company_id, p_src_type, p_src_id, 'stock', t.destination_branch_id, l.product_id, 'transfer_trip_line', dl.id, dl.qty_lost_normal, s.amount - unabs);
      perform public._dl(t.company_id, p_src_type, p_src_id, 'cogs', t.destination_branch_id, l.product_id, 'transfer_trip_line', dl.id, null, unabs);
    else
      update public.stock_transfer_dispatch_lines set lost_value = lost_value + s.amount where id = dl.id;
      jl := jl || public._jl(public.account_for(t.company_id, 'inventory.loss'), s.amount, 'Cost on goods lost in transit');
      perform public._dl(t.company_id, p_src_type, p_src_id, 'loss', t.destination_branch_id, l.product_id, 'transfer_trip_line', dl.id, dl.qty_lost_abnormal, s.amount);
    end if;
  end loop;
  update public.stock_transfer_dispatch_lines set charges_applied = charges_applied + round(p_amount, 2) where id = dl.id;
  return jl;
end; $$;

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
    perform public._dl(mo.company_id, p_src_type, p_src_id, 'cogs', mo.branch_id, mo.product_id, 'movement', p_out_mv, p_units, p_amount);
    return public._jl(public.account_for(mo.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (untraced outflow)');
  end if;
  if t.posts_in_transit then
    select * into dl from public.stock_transfer_dispatch_lines where movement_id = p_out_mv;
    if dl.id is null then
      perform public._dl(mo.company_id, p_src_type, p_src_id, 'cogs', mo.branch_id, mo.product_id, 'movement', p_out_mv, p_units, p_amount);
      return public._jl(public.account_for(mo.company_id, 'inventory.cost_of_sales'), p_amount, 'Late cost (untraced transfer)');
    end if;
    select status into trip from public.stock_transfer_dispatches where id = dl.dispatch_id;
    if trip = 'voided' then
      -- the units went back to the source pool
      unabs := public._stock_value_adjust(mo.company_id, mo.branch_id, mo.product_id, p_amount, p_src_type, p_src_id, p_docnum, p_user);
      perform public._dl(mo.company_id, p_src_type, p_src_id, 'stock', mo.branch_id, mo.product_id, 'transfer_trip_line', dl.id, p_units, p_amount - unabs);
      perform public._dl(mo.company_id, p_src_type, p_src_id, 'cogs', mo.branch_id, mo.product_id, 'transfer_trip_line', dl.id, null, unabs);
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
    perform public._dl(mo.company_id, p_src_type, p_src_id, 'cogs', mo.branch_id, mo.product_id, 'movement', p_out_mv, p_units, p_amount);
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
    perform public._dl(mo.company_id, p_src_type, p_src_id, 'loss', mo.branch_id, mo.product_id, 'stock_transfer', t.id, p_units, p_amount);
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
      perform public._dl(mo.company_id, p_src_type, p_src_id, 'transit_legacy', t.destination_branch_id, mo.product_id, 'stock_transfer', t.id, d - rc, s.amount);
    else
      jl := jl || public._propagate_from_movement(mo.company_id, t.destination_branch_id, mo.product_id,
                    (s.part->>'at')::timestamptz, (s.part->>'mv')::uuid, (s.part->>'units')::numeric, s.amount,
                    p_src_type, p_src_id, p_docnum, p_user, p_depth + 1);
    end if;
  end loop;
  return jl;
end; $$;

create or replace function public._apply_line_cost_delta(
  p_line uuid, p_amount numeric, p_date date, p_src_type text, p_src_id uuid, p_docnum text, p_user uuid, p_source uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.import_shipment_lines; rec_f numeric; transit_f numeric; loss_f numeric; parts jsonb := '[]'::jsonb;
  s record; jl jsonb := '[]'::jsonb; rparts jsonb; r record; rl record; co uuid;
begin
  if p_amount = 0 then return '[]'::jsonb; end if;
  select * into l from public.import_shipment_lines where id = p_line for update;
  co := l.company_id;
  rec_f := l.received_kg + case when l.line_closed then l.short_normal_kg else 0 end;
  transit_f := public._line_transit_kg(l);
  loss_f := l.short_writeoff_kg + l.short_claim_kg;
  if rec_f > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'received', 'factor', rec_f); end if;
  if transit_f > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'transit', 'factor', transit_f); end if;
  if loss_f > 0 then parts := parts || jsonb_build_object('id', gen_random_uuid(), 'kind', 'loss', 'factor', loss_f); end if;
  if jsonb_array_length(parts) = 0 then raise exception 'Shipment line has no quantity to carry cost' using errcode = 'P0001'; end if;

  for s in select p.value as part, a.amount from jsonb_array_elements(parts) p
           join public.allocate_amount(round(p_amount, 2), 'quantity', parts) a on a.target_id = (p.value->>'id')::uuid loop
    if s.part->>'kind' = 'transit' then
      update public.import_shipment_lines set git_value = git_value + s.amount where id = l.id;
      jl := jl || public._jl(public.account_for(co, 'import.goods_in_transit'), s.amount, 'Import goods in transit');
      perform public._dl(co, p_src_type, p_src_id, 'import_transit', null, l.product_id, 'import_shipment_line', l.id, transit_f, s.amount);
      perform public._ship_ledger(l.shipment_id, l.id, p_source, 'git', s.amount, p_src_type, p_src_id, p_date);
    elsif s.part->>'kind' = 'loss' then
      jl := jl || public._jl(public.account_for(co, 'inventory.loss'), s.amount, 'Cost of import shortage');
      perform public._dl(co, p_src_type, p_src_id, 'loss', null, l.product_id, 'import_shipment_line', l.id, loss_f, s.amount);
      perform public._ship_ledger(l.shipment_id, l.id, p_source, 'loss', s.amount, p_src_type, p_src_id, p_date);
    else
      rparts := '[]'::jsonb;
      for r in select irl.* from public.import_receipt_lines irl join public.import_receipts ir on ir.id = irl.receipt_id
               where irl.shipment_line_id = l.id and ir.document_status = 'posted' and irl.net_kg_received > 0 order by ir.receipt_date, irl.id loop
        rparts := rparts || jsonb_build_object('id', r.id, 'factor', r.net_kg_received);
      end loop;
      for rl in select irl.*, a.amount as share, ir.branch_id, ir.document_number
                from public.allocate_amount(s.amount, 'quantity', rparts) a
                join public.import_receipt_lines irl on irl.id = a.target_id
                join public.import_receipts ir on ir.id = irl.receipt_id loop
        update public.import_receipt_lines set cost_delta_tzs = cost_delta_tzs + rl.share where id = rl.id;
        jl := jl || public._propagate_from_movement(co, rl.branch_id, l.product_id,
                      (select created_at from public.stock_movements where id = rl.movement_id), rl.movement_id,
                      rl.quantity_received, rl.share, p_src_type, p_src_id, p_docnum, p_user, 0);
        perform public._ship_ledger(l.shipment_id, l.id, p_source, 'inventory', rl.share, p_src_type, p_src_id, p_date);
      end loop;
    end if;
  end loop;
  return jl;
end; $$;


-- ---------------------------------------------------------------------------
-- 6. Cost invoices: purchase landed costs, and credit notes beyond the open
-- balance (vendor already paid) become supplier credits.
-- ---------------------------------------------------------------------------
create or replace function public.post_cost_invoice(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ci public.cost_invoices; cr public.cost_invoices; ln record; s public.cost_sources; cat public.cost_categories;
  sh public.import_shipments; ro public.rebag_orders; tr public.stock_transfers; pu public.purchases; payred numeric(18,2); credit numeric(18,2) := 0; prior_cr numeric(18,2); pb public.supplier_payables; docnum text; sgn int;
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
    sh := null; ro := null; tr := null; pu := null;
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
    elsif s.owner_type = 'purchase' then
      select * into pu from public.purchases where id = s.purchase_id for update;
      if pu.document_status <> 'posted' then
        raise exception 'Purchase % is %; its landed costs cannot change', coalesce(pu.document_number, 'draft'), pu.document_status using errcode = 'P0001'; end if;
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
      elsif pu.id is not null then
        jl := jl || public._apply_purchase_delta(s.id, delta, ci.document_date, 'cost_invoice', p_id, docnum, p_user);
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
    elsif pu.id is not null then
      null;
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
    -- Credits may not exceed the credited invoice; what the open balance
    -- cannot absorb (invoice already paid) becomes a supplier credit (1170),
    -- which can be used on other invoices or refunded.
    select coalesce(sum(grand_total), 0) into prior_cr from public.cost_invoices where credited_invoice_id = cr.id and document_status = 'posted';
    if prior_cr + v_grand > cr.grand_total then
      raise exception 'Credits (%) would exceed the credited invoice (%)', prior_cr + v_grand, cr.grand_total using errcode = 'P0001'; end if;
    select * into pb from public.supplier_payables where cost_invoice_id = cr.id for update;
    payred := least(coalesce(pb.outstanding, 0), v_grand);
    credit := v_grand - payred;
    if payred > 0 then
      update public.supplier_payables set outstanding = outstanding - payred,
        status = case when outstanding - payred <= 0 then 'settled' else 'partial' end where id = pb.id;
      jl := jl || public._jl(public.account_id_by_code(ci.company_id, '2110'), payred, 'Credit note reduces payable');
    end if;
    if credit > 0 then
      insert into public.supplier_credits(company_id, supplier_id, amount, remaining, status, currency_code, fc_amount, fc_remaining, credit_date)
        values (ci.company_id, ci.supplier_id, credit, credit, 'open', 'TZS', credit, credit, ci.document_date);
      jl := jl || public._jl(public.account_id_by_code(ci.company_id, '1170'), credit, 'Supplier credit (invoice already paid)');
    end if;
  end if;
  perform public.create_journal(ci.company_id, ci.branch_id, ci.document_date, 'cost_invoice', ci.id, docnum,
    case when sgn > 0 then 'Cost invoice ' else 'Cost credit note ' end || docnum, p_user, jl);

  update public.cost_invoices set document_status = 'posted', document_number = docnum, net_total = v_net, tax_total = v_tax,
    grand_total = v_grand, credit_created = credit, posted_at = now(), posted_by = p_user where id = p_id;
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
-- 7. Reversal of a posted cost invoice (no payment, credit or credit note on
-- it): the payable and VAT are reversed, the accrual it replaced is
-- re-instated, and only the difference it had made comes out of the goods.
-- The invoice and its journal stay; the supplier number is freed.
-- ---------------------------------------------------------------------------
alter table public.cost_invoices add column if not exists credit_created numeric(18,2) not null default 0;

create or replace function public.void_cost_invoice(p_id uuid, p_user uuid, p_reason text, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ci public.cost_invoices; pb public.supplier_payables; ln record; s public.cost_sources; cat public.cost_categories;
  rec numeric(18,2); nonrec numeric(18,2); cost numeric(18,2); acc numeric(18,2); delta numeric(18,2); v_rec numeric(18,2) := 0;
  jl jsonb := '[]'::jsonb; d date;
begin
  perform public._require_key(p_idem);
  select * into ci from public.cost_invoices where id = p_id for update;
  if not found then raise exception 'Cost invoice not found' using errcode = 'P0001'; end if;
  if public._is_replay(p_idem, 'void_cost_invoice', p_id) then return p_id; end if;
  perform public.assert_actor(p_user, ci.company_id, 'cost_invoices.void', ci.branch_id);
  if ci.document_status <> 'posted' then raise exception 'Only a posted cost invoice can be reversed' using errcode = 'P0001'; end if;
  if ci.document_kind <> 'invoice' then raise exception 'Credit notes are corrected with a new invoice' using errcode = 'P0001'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = 'P0001'; end if;
  if exists (select 1 from public.cost_invoices where credited_invoice_id = p_id and document_status = 'posted') then
    raise exception 'Credit notes were posted against this invoice; it cannot be reversed' using errcode = 'P0001'; end if;
  select * into pb from public.supplier_payables where cost_invoice_id = p_id for update;
  if pb.id is not null and (pb.outstanding <> pb.original_amount
       or exists (select 1 from public.supplier_payment_allocations a join public.supplier_payments sp on sp.id = a.payment_id
                  where a.payable_id = pb.id and sp.document_status = 'posted')
       or exists (select 1 from public.supplier_credit_applications where payable_id = pb.id)) then
    raise exception 'This invoice has payments or credits; reverse those first' using errcode = 'P0001'; end if;
  if not public.claim_idempotency(p_idem, 'void_cost_invoice', p_id) then return p_id; end if;
  d := (now() at time zone 'Africa/Dar_es_Salaam')::date;
  perform public.assert_period_open(ci.company_id, d);
  for ln in select * from public.cost_invoice_lines where cost_invoice_id = p_id order by cost_source_id nulls last, line_no, id loop
    rec := case when ln.is_recoverable then ln.tax_amount else 0 end; nonrec := ln.tax_amount - rec;
    cost := round(ln.net_amount + nonrec, 2); v_rec := v_rec + rec;
    select * into cat from public.cost_categories where id = ln.cost_category_id;
    if ln.cost_source_id is null then
      jl := jl || public._jl(cat.expense_account_id, -cost, 'Reversed: ' || coalesce(ln.description, cat.name));
      continue;
    end if;
    select * into s from public.cost_sources where id = ln.cost_source_id for update;
    acc := case when s.accrual_date is not null then s.accrued_amount else 0 end;
    delta := -(cost - acc);
    if acc > 0 then
      jl := jl || public._jl(public.account_for(ci.company_id, 'import.accrued_costs'), -acc, 'Accrual re-instated');
      if s.owner_type = 'import_shipment' then perform public._ship_ledger(s.import_shipment_id, null, s.id, 'accrual', -acc, 'cost_invoice_void', p_id, d); end if;
    end if;
    if s.inventory_treatment = 'capitalize' then
      jl := jl || case s.owner_type
        when 'import_shipment' then public._apply_source_delta(s.id, delta, d, 'cost_invoice_void', p_id, ci.document_number, p_user)
        when 'rebag_order' then public._apply_rebag_delta(s.id, delta, d, 'cost_invoice_void', p_id, ci.document_number, p_user)
        when 'stock_transfer' then public._apply_transfer_delta(s.id, delta, d, 'cost_invoice_void', p_id, ci.document_number, p_user)
        else public._apply_purchase_delta(s.id, delta, d, 'cost_invoice_void', p_id, ci.document_number, p_user) end;
    else
      jl := jl || public._jl(s.expense_account_id, delta, 'Reversed: ' || coalesce(ln.description, cat.name));
      if s.owner_type = 'import_shipment' then perform public._ship_ledger(s.import_shipment_id, null, s.id, 'expense', delta, 'cost_invoice_void', p_id, d); end if;
    end if;
    delete from public.cost_source_actuals where cost_source_id = s.id and cost_invoice_line_id = ln.id;
    update public.cost_sources set status = case when acc > 0 then 'accrued' else 'estimated' end, actual_amount = 0, updated_by = p_user where id = s.id;
    if s.owner_type = 'import_shipment' then
      update public.import_shipments set cost_status = 'provisional' where id = s.import_shipment_id and cost_status in ('finalized','adjusted');
    elsif s.owner_type = 'stock_transfer' then
      update public.stock_transfers set cost_status = 'provisional' where id = s.stock_transfer_id;
    elsif s.owner_type = 'rebag_order' then
      perform set_config('letiq.rebag_posting', 'on', true);
      update public.rebag_orders set cost_status = 'provisional' where id = s.rebag_order_id;
      perform set_config('letiq.rebag_posting', 'off', true);
    end if;
  end loop;
  jl := jl || public._jl(public.account_for(ci.company_id, 'tax.input_vat'), -v_rec, 'Input VAT reversed')
     || public._jl(public.account_id_by_code(ci.company_id, '2110'), ci.grand_total, 'Payable reversed');
  perform public.create_journal(ci.company_id, ci.branch_id, d, 'cost_invoice_void', ci.id, ci.document_number,
    'Reversal of cost invoice ' || ci.document_number || ' (' || ci.document_date || ')', p_user, jl);
  if pb.id is not null then update public.supplier_payables set outstanding = 0, status = 'voided' where id = pb.id; end if;
  delete from public.supplier_invoice_registry where source_type = 'cost_invoice' and source_id = ci.id;
  update public.cost_invoices set document_status = 'voided', voided_at = now(), voided_by = p_user, void_reason = trim(p_reason) where id = p_id;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (ci.company_id, 'cost_invoice', p_id, 'posted', 'voided', trim(p_reason), p_user);
  return p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 8. Late-cost report: every delta line with the posting date, the original
-- document it reached and whether that document's period is closed (a
-- current-period catch-up).
-- ---------------------------------------------------------------------------
create or replace function public.late_cost_report(p_company uuid, p_from date, p_to date)
returns table(src_type text, src_id uuid, src_number text, posting_date date, target text, branch_code text, product_name text,
  ref_type text, ref_id uuid, ref_number text, ref_date date, units numeric, amount numeric, catch_up boolean)
language sql stable security definer set search_path = public as $$
  with lines as (
    select l.*, (select j.entry_date from public.journal_entries j where j.source_id = l.src_id and j.company_id = l.company_id
                  order by j.created_at desc limit 1) pdate
    from public.cost_delta_lines l where l.company_id = p_company
  ), refs as (
    select x.*,
      case x.ref_type when 'sale' then (select document_number from public.sales where id = x.ref_id)
                      when 'rebag_order' then (select document_number from public.rebag_orders where id = x.ref_id)
                      when 'stock_transfer' then (select document_number from public.stock_transfers where id = x.ref_id)
                      when 'transfer_trip_line' then (select d.document_number from public.stock_transfer_dispatch_lines dl join public.stock_transfer_dispatches d on d.id = dl.dispatch_id where dl.id = x.ref_id)
                      when 'import_shipment_line' then (select s.document_number from public.import_shipment_lines sl join public.import_shipments s on s.id = sl.shipment_id where sl.id = x.ref_id)
                      when 'movement' then (select source_number from public.stock_movements where id = x.ref_id) end rnum,
      case x.ref_type when 'sale' then (select document_date from public.sales where id = x.ref_id)
                      when 'movement' then (select (created_at at time zone 'Africa/Dar_es_Salaam')::date from public.stock_movements where id = x.ref_id) end rdate
    from lines x where x.pdate is null or x.pdate between p_from and p_to
  )
  select r.src_type, r.src_id,
    coalesce((select document_number from public.cost_invoices where id = r.src_id), (select document_number from public.purchase_cost_adjustments where id = r.src_id),
             (select document_number from public.purchases where id = r.src_id), (select coalesce(description, 'accrual') from public.cost_sources where id = r.src_id),
             (select document_number from public.sales_returns where id = r.src_id), (select document_number from public.sales where id = r.src_id)),
    r.pdate, r.target, (select code from public.branches where id = r.branch_id), (select name from public.products where id = r.product_id),
    r.ref_type, r.ref_id, r.rnum, r.rdate, r.units, r.amount,
    coalesce(r.rdate is not null and exists (select 1 from public.accounting_periods ap where ap.company_id = p_company
              and r.rdate between ap.start_date and ap.end_date and ap.status in ('closed','locked')), false)
  from refs r order by r.pdate nulls last, r.created_at;
$$;

-- ---------------------------------------------------------------------------
-- 9. Reconciliation checks (current position).
-- ---------------------------------------------------------------------------
create or replace function public.cost_reconciliation_checks(p_company uuid)
returns table(check_key text, label text, ok boolean, expected numeric, actual numeric, detail text)
language plpgsql stable security definer set search_path = public as $$
declare gl numeric; sub numeric; n int; det text;
begin
  -- quantities
  select count(*) into n from public.stock_balances b where b.company_id = p_company and b.quantity <>
    coalesce((select sum(m.qty_in - m.qty_out) from public.stock_movements m where m.branch_id = b.branch_id and m.product_id = b.product_id and m.company_id = p_company), 0);
  return query select 'qty_movements', 'Stock quantities equal the sum of their movements', n = 0, 0::numeric, n::numeric, n || ' location(s) differ';
  select count(*) into n from public.stock_balances b where b.company_id = p_company and exists (select 1 from public.stock_movements m where m.branch_id = b.branch_id and m.product_id = b.product_id)
    and b.stock_value <> (select m.balance_value from public.stock_movements m where m.branch_id = b.branch_id and m.product_id = b.product_id order by m.created_at desc, m.id desc limit 1);
  return query select 'value_movements', 'Stock values equal the last movement balance', n = 0, 0::numeric, n::numeric, n || ' location(s) differ';
  select count(*) into n from public.stock_transfer_lines l join public.stock_transfers t on t.id = l.transfer_id where t.company_id = p_company and t.posts_in_transit
    and l.qty_dispatched < l.qty_received + l.qty_quarantined + l.qty_short_pending + l.qty_lost_normal + l.qty_lost_abnormal;
  return query select 'qty_transfers', 'Transfers: dispatched = accepted + quarantined + short + lost + still in transit', n = 0, 0::numeric, n::numeric, n || ' line(s) over-accounted';
  select count(*) into n from public.rebag_orders r where r.company_id = p_company and r.document_status in ('completed','voided')
    and r.issued_kg <> r.returned_kg + r.normal_loss_kg + r.abnormal_loss_kg + coalesce((select sum(net_kg) from public.rebag_outputs where order_id = r.id), 0);
  return query select 'qty_rebag', 'Rebagging: kg issued = packed + returned + losses', n = 0, 0::numeric, n::numeric, n || ' order(s) out of balance';
  -- allocations
  select count(*) into n from public.cost_allocation_runs r where r.company_id = p_company
    and r.total_amount <> coalesce((select sum(amount) from public.cost_allocations a where a.run_id = r.id), 0);
  return query select 'allocations', 'Every allocation equals its source amount', n = 0, 0::numeric, n::numeric, n || ' run(s) differ';
  select count(*) into n from (select j.id from public.journal_entries j join public.journal_lines l on l.journal_id = j.id
    where j.company_id = p_company group by j.id having sum(l.debit) <> sum(l.credit)) x;
  return query select 'journals', 'Every journal balances', n = 0, 0::numeric, n::numeric, n || ' unbalanced';
  -- inventory and transit
  gl := coalesce((select sum(l.debit - l.credit) from public.journal_lines l join public.journal_entries j on j.id = l.journal_id
                  where j.company_id = p_company and l.account_id = public.account_id_by_code(p_company, '1150')), 0);
  sub := coalesce((select sum(stock_value) from public.stock_balances where company_id = p_company), 0)
       + coalesce((select sum(issued_value) from public.rebag_orders where company_id = p_company and document_status = 'issued'), 0)
       + coalesce((select sum(round((l.qty_dispatched - l.qty_received) * l.unit_cost, 2)) from public.stock_transfer_lines l join public.stock_transfers t on t.id = l.transfer_id
                   where t.company_id = p_company and not t.posts_in_transit and t.status in ('dispatched','partially_received')), 0);
  return query select 'inventory_gl', 'Inventory subledger (+ rebagging WIP, pre-upgrade transit) = GL 1150', abs(gl - sub) < 0.01, sub, gl, 'difference ' || (gl - sub);
  gl := coalesce((select sum(l.debit - l.credit) from public.journal_lines l join public.journal_entries j on j.id = l.journal_id
                  where j.company_id = p_company and l.account_id = public.account_for(p_company, 'transfer.goods_in_transit')), 0);
  sub := coalesce((select sum(x.transit_value) from public.stock_transfer_dispatch_lines x join public.stock_transfer_dispatches d on d.id = x.dispatch_id
                   where d.company_id = p_company and d.status not in ('draft','voided')), 0);
  select string_agg(distinct d.document_number, ', ') into det from public.stock_transfer_dispatch_lines x join public.stock_transfer_dispatches d on d.id = x.dispatch_id
    where d.company_id = p_company and d.status not in ('draft','voided') and x.transit_value <> 0;
  return query select 'transit_gl', 'Stock in transit (1155) = value on trips not yet received', abs(gl - sub) < 0.01, sub, gl, coalesce('open: ' || det, 'no open trips');
  gl := coalesce((select sum(l.debit - l.credit) from public.journal_lines l join public.journal_entries j on j.id = l.journal_id
                  where j.company_id = p_company and l.account_id = public.account_for(p_company, 'import.goods_in_transit')), 0);
  sub := coalesce((select sum(git_value) from public.import_shipment_lines where company_id = p_company), 0);
  return query select 'import_transit_gl', 'Import goods in transit (1157) = shipment lines in transit', abs(gl - sub) < 0.01, sub, gl, 'difference ' || (gl - sub);
  -- clearing accounts: only explained open items
  gl := coalesce((select sum(l.debit - l.credit) from public.journal_lines l join public.journal_entries j on j.id = l.journal_id
                  where j.company_id = p_company and l.account_id = public.account_for(p_company, 'import.gr_ir')), 0);
  sub := coalesce((select sum(amount) from public.import_shipment_ledger where company_id = p_company and account_key = 'grir'), 0);
  select string_agg(s.document_number || ' ' || x.amt, ', ') into det from (select shipment_id, sum(amount) amt from public.import_shipment_ledger
    where company_id = p_company and account_key = 'grir' group by shipment_id having sum(amount) <> 0) x join public.import_shipments s on s.id = x.shipment_id;
  return query select 'grir', 'GR/IR (2130) = open items per shipment', abs(gl - sub) < 0.01, sub, gl, coalesce('open: ' || det, 'no open items');
  gl := -coalesce((select sum(l.debit - l.credit) from public.journal_lines l join public.journal_entries j on j.id = l.journal_id
                   where j.company_id = p_company and l.account_id = public.account_for(p_company, 'import.accrued_costs')), 0);
  sub := coalesce((select sum(accrued_amount) from public.cost_sources where company_id = p_company and status = 'accrued'), 0);
  select string_agg(coalesce(description, 'cost') || ' ' || accrued_amount, ', ') into det from public.cost_sources where company_id = p_company and status = 'accrued';
  return query select 'accruals', 'Accrued costs (2140) = accrued charges awaiting invoice', abs(gl - sub) < 0.01, sub, gl, coalesce('open: ' || det, 'no open accruals');
  gl := -coalesce((select sum(l.debit - l.credit) from public.journal_lines l join public.journal_entries j on j.id = l.journal_id
                   where j.company_id = p_company and l.account_id = public.account_id_by_code(p_company, '2110')), 0);
  sub := coalesce((select sum(outstanding) from public.supplier_payables where company_id = p_company and status <> 'voided'), 0)
       + coalesce((select sum(outstanding) from public.supplier_opening_balances where company_id = p_company and document_status = 'posted'), 0);
  return query select 'ap', 'Accounts payable (2110) = supplier ledger', abs(gl - sub) < 0.01, sub, gl, 'difference ' || (gl - sub);
  gl := coalesce((select sum(l.debit - l.credit) from public.journal_lines l join public.journal_entries j on j.id = l.journal_id
                  where j.company_id = p_company and l.account_id = public.account_id_by_code(p_company, '1170')), 0);
  sub := coalesce((select sum(remaining) from public.supplier_credits where company_id = p_company and status = 'open'), 0);
  return query select 'supplier_credits', 'Supplier credits (1170) = open credits', abs(gl - sub) < 0.01, sub, gl, 'difference ' || (gl - sub);
end; $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             '_dl','_apply_purchase_line_delta','_apply_purchase_delta','accrue_purchase_cost','post_purchase_cost_adjustment',
             'refund_supplier_credit','_late_cost_return','void_cost_invoice','late_cost_report','cost_reconciliation_checks','post_cost_invoice',
             '_propagate_from_movement','_propagate_rebag','_apply_tdl_delta','_propagate_transfer','_apply_line_cost_delta') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
do $$
declare t text;
begin
  foreach t in array array['cost_delta_lines','cost_source_history','purchase_cost_adjustments','purchase_cost_adjustment_lines','supplier_credit_refunds'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_company_access(company_id))', t || '_select', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
