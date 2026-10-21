-- ============================================================================
-- Letiq ERP - Migration 0025: Import upgrade Stage 2 - shared foundations and
-- secure posting primitives. Additive; existing documents, stock, journals and
-- balances are untouched. New workflows stay behind feature flags (default
-- OFF) until their stages are complete.
-- ----------------------------------------------------------------------------
--  A. Actor checks (permission / branch) for RPCs that receive p_user
--  B. Strict idempotency (claim_operation)
--  C. Account mappings + new system accounts (1145, 1175)
--  D. Feature flags
--  E. Journal posting wrapper with company / account / period validation
--  F. Ordered stock-balance locking
--  G. Allocation engine (direct / weight / value / volume / quantity /
--     percent / manual) with deterministic largest-remainder rounding
--  H. Supplier-invoice registry (one supplier invoice -> one document)
--  I. Import shipments, foreign purchase fields, cost sources, cost invoices,
--     allocations (runs), receipts
--  J. Package / rebagging lineage, provenance lots
--  K. Transfer logistics, costing and receipts
--  L. Document attachments + versions (metadata) and private Storage bucket
--  M. RLS, grants, function lock-down
-- ============================================================================

-- ===========================================================================
-- A. Actor checks
-- ===========================================================================
create or replace function public._user_is_owner(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_profiles up join public.roles r on r.id = up.role_id
                 where up.id = p_user and up.is_active and r.code = 'OWNER');
$$;

create or replace function public._user_can(p_user uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select public._user_is_owner(p_user) or exists (
    select 1 from public.user_profiles up
      join public.role_permissions rp on rp.role_id = up.role_id
      join public.permissions p on p.id = rp.permission_id
    where up.id = p_user and up.is_active and p.code = p_permission);
$$;

create or replace function public._user_has_company(p_user uuid, p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public._user_is_owner(p_user) or exists (
    select 1 from public.user_company_access where user_id = p_user and company_id = p_company);
$$;

create or replace function public._user_has_branch(p_user uuid, p_branch uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public._user_is_owner(p_user) or exists (
    select 1 from public.user_branch_access where user_id = p_user and branch_id = p_branch);
$$;

-- Raises (SQLSTATE 42501) unless p_user is active, belongs to the company, holds
-- the permission and (when given) has the branch.
create or replace function public.assert_actor(
  p_user uuid, p_company uuid, p_permission text, p_branch uuid default null
) returns void language plpgsql stable security definer set search_path = public as $$
begin
  if p_user is null or not exists (select 1 from public.user_profiles where id = p_user and is_active) then
    raise exception 'Not authorised: inactive or unknown user' using errcode = '42501';
  end if;
  if not public._user_has_company(p_user, p_company) then
    raise exception 'Not authorised for this company' using errcode = '42501';
  end if;
  if p_permission is not null and not public._user_can(p_user, p_permission) then
    raise exception 'Not authorised: missing permission %', p_permission using errcode = '42501';
  end if;
  if p_branch is not null then
    if not exists (select 1 from public.branches where id = p_branch and company_id = p_company) then
      raise exception 'Branch does not belong to this company' using errcode = '42501';
    end if;
    if not public._user_has_branch(p_user, p_branch) then
      raise exception 'Not authorised for this branch' using errcode = '42501';
    end if;
  end if;
end; $$;

-- ===========================================================================
-- B. Strict idempotency: a key must be supplied; a replay of the same
-- operation on the same document is reported (returns false); reusing a key
-- for anything else is an error.
-- ===========================================================================
create or replace function public.claim_operation(p_key text, p_operation text, p_document uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare existing public.idempotency_keys;
begin
  if p_key is null or length(p_key) < 16 then
    raise exception 'An idempotency key of at least 16 characters is required' using errcode = 'P0001';
  end if;
  begin
    insert into public.idempotency_keys(key, operation, result_id) values (p_key, p_operation, p_document);
    return true;
  exception when unique_violation then
    select * into existing from public.idempotency_keys where key = p_key;
    if existing.operation = p_operation and existing.result_id is not distinct from p_document then
      return false; -- replay of an already-processed request
    end if;
    raise exception 'Idempotency key was already used for a different operation' using errcode = 'P0001';
  end;
end; $$;

-- ===========================================================================
-- C. Account mappings and new accounts. Posting code for the new workflows
-- resolves accounts by mapping key, never by hard-coded id. A mapping change
-- affects only future postings (journal lines store account ids).
-- Inventory stays on the single 1150 control account (bulk / packaged /
-- packaging keys map to it) so no duplicate control account is created; a
-- company can repoint a key to a posting sub-account later.
-- ===========================================================================
create table if not exists public.account_mappings (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  mapping_key text not null check (mapping_key in (
    'inventory.standard','inventory.bulk','inventory.packaged','inventory.packaging',
    'transfer.goods_in_transit','import.goods_in_transit','import.gr_ir','import.accrued_costs',
    'import.supplier_advances','import.claims_receivable',
    'fx.realised_gain','fx.realised_loss','fx.unrealised_gain','fx.unrealised_loss',
    'inventory.loss','inventory.cost_of_sales','inventory.price_variance',
    'tax.input_vat','payables.trade')),
  account_id  uuid not null references public.chart_of_accounts(id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  unique (company_id, mapping_key)
);

drop trigger if exists trg_account_mappings_company on public.account_mappings;
create trigger trg_account_mappings_company before insert or update on public.account_mappings
  for each row execute function public.check_company_consistency('account_id', 'chart_of_accounts');

create or replace function public.account_mappings_validate()
returns trigger language plpgsql security definer set search_path = public as $$
declare acc public.chart_of_accounts; expected text;
begin
  select * into acc from public.chart_of_accounts where id = NEW.account_id;
  if not acc.allow_posting or not acc.is_active then
    raise exception 'Mapped account % must be an active posting account', acc.code using errcode = '23514';
  end if;
  expected := case
    when NEW.mapping_key like 'inventory.%' and NEW.mapping_key not in ('inventory.loss','inventory.cost_of_sales','inventory.price_variance') then 'asset'
    when NEW.mapping_key in ('transfer.goods_in_transit','import.goods_in_transit','import.supplier_advances','import.claims_receivable','tax.input_vat') then 'asset'
    when NEW.mapping_key in ('import.gr_ir','import.accrued_costs','payables.trade') then 'liability'
    when NEW.mapping_key in ('fx.realised_gain','fx.unrealised_gain') then 'revenue'
    when NEW.mapping_key in ('fx.realised_loss','fx.unrealised_loss','inventory.loss') then 'expense'
    when NEW.mapping_key in ('inventory.cost_of_sales','inventory.price_variance') then 'cost_of_sales'
  end;
  if acc.account_type <> expected then
    raise exception 'Mapping % needs a % account (got % %)', NEW.mapping_key, expected, acc.code, acc.account_type
      using errcode = '23514';
  end if;
  NEW.updated_at := now();
  return NEW;
end; $$;

drop trigger if exists trg_account_mappings_validate on public.account_mappings;
create trigger trg_account_mappings_validate before insert or update on public.account_mappings
  for each row execute function public.account_mappings_validate();

create or replace function public.account_for(p_company uuid, p_key text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare a uuid;
begin
  select account_id into a from public.account_mappings where company_id = p_company and mapping_key = p_key;
  if a is null then
    raise exception 'Account mapping % is not configured for this company', p_key using errcode = 'P0001';
  end if;
  return a;
end; $$;

-- ===========================================================================
-- D. Feature flags (per company, default OFF).
-- ===========================================================================
create table if not exists public.feature_flags (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  flag_key   text not null check (flag_key in ('imports','rebagging','transfer_logistics','attachments','fx_settlement')),
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  unique (company_id, flag_key)
);
drop trigger if exists trg_feature_flags_updated on public.feature_flags;
create trigger trg_feature_flags_updated before update on public.feature_flags
  for each row execute function public.set_updated_at();

create or replace function public.feature_enabled(p_company uuid, p_flag text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_enabled from public.feature_flags where company_id = p_company and flag_key = p_flag), false);
$$;

create or replace function public.assert_feature(p_company uuid, p_flag text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.feature_enabled(p_company, p_flag) then
    raise exception 'The % feature is not enabled for this company', p_flag using errcode = 'P0001';
  end if;
end; $$;

-- ===========================================================================
-- Company defaults v2: keep everything from 0024 and add this stage's
-- accounts, mappings and flags.
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = '_ensure_company_defaults_0024') then
    alter function public.ensure_company_defaults(uuid) rename to _ensure_company_defaults_0024;
  end if;
end $$;

create or replace function public.ensure_company_defaults(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m record;
begin
  perform public._ensure_company_defaults_0024(p_company);

  perform public._ensure_system_account(p_company, '1145', 'Claims Receivable (Insurers / Transporters)', 'asset', '1100', 'debit', true);
  perform public._ensure_system_account(p_company, '1175', 'Supplier Advances (Imports)', 'asset', '1100', 'debit', true);

  for m in select * from (values
    ('inventory.standard','1150'), ('inventory.bulk','1150'), ('inventory.packaged','1150'), ('inventory.packaging','1150'),
    ('transfer.goods_in_transit','1155'), ('import.goods_in_transit','1157'),
    ('import.gr_ir','2130'), ('import.accrued_costs','2140'),
    ('import.supplier_advances','1175'), ('import.claims_receivable','1145'),
    ('fx.realised_gain','4400'), ('fx.realised_loss','6400'),
    ('fx.unrealised_gain','4410'), ('fx.unrealised_loss','6410'),
    ('inventory.loss','6300'), ('inventory.cost_of_sales','5100'), ('inventory.price_variance','5300'),
    ('tax.input_vat','1160'), ('payables.trade','2110')
  ) as v(k, code) loop
    insert into public.account_mappings(company_id, mapping_key, account_id)
      values (p_company, m.k, public.account_id_by_code(p_company, m.code))
      on conflict (company_id, mapping_key) do nothing;
  end loop;

  insert into public.feature_flags(company_id, flag_key)
    select p_company, f from unnest(array['imports','rebagging','transfer_logistics','attachments','fx_settlement']) f
    on conflict (company_id, flag_key) do nothing;

  update public.cost_categories set component = 'freight'
    where company_id = p_company and code = 'FREIGHT' and component is null;
  update public.cost_categories set component = 'insurance'
    where company_id = p_company and code = 'INSURANCE' and component is null;

  perform public._ensure_doc_sequence(p_company, 'import_shipment', 'IMP');
  perform public._ensure_doc_sequence(p_company, 'import_receipt', 'GRN');
  perform public._ensure_doc_sequence(p_company, 'cost_invoice', 'CIN');
  perform public._ensure_doc_sequence(p_company, 'rebag_order', 'RBG');
  perform public._ensure_doc_sequence(p_company, 'transfer_receipt', 'TRC');
end; $$;

-- Cost categories: which shipment component (if any) a category represents,
-- so a CIF shipment cannot be charged freight/insurance twice.
alter table public.cost_categories add column if not exists component text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cost_categories_component_check') then
    alter table public.cost_categories add constraint cost_categories_component_check
      check (component is null or component in ('freight','insurance'));
  end if;
end $$;

-- ===========================================================================
-- E. Journal wrapper: every account must belong to the company and be an
-- active posting account; the period must be open; lines non-negative.
-- create_journal() then enforces balance.
-- ===========================================================================
create or replace function public.post_balanced_journal(
  p_company uuid, p_branch uuid, p_date date, p_source_type text, p_source_id uuid,
  p_source_number text, p_memo text, p_user uuid, p_lines jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare ln jsonb; acc public.chart_of_accounts; dr numeric; cr numeric; j uuid;
begin
  perform public.assert_period_open(p_company, p_date);
  if p_branch is not null and not exists (select 1 from public.branches where id = p_branch and company_id = p_company) then
    raise exception 'Journal branch does not belong to this company' using errcode = '23514';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal needs at least two lines' using errcode = 'P0001';
  end if;
  for ln in select * from jsonb_array_elements(p_lines) loop
    select * into acc from public.chart_of_accounts where id = (ln->>'account_id')::uuid;
    if not found or acc.company_id <> p_company then
      raise exception 'Journal account does not belong to this company' using errcode = '23514';
    end if;
    if not acc.allow_posting or not acc.is_active then
      raise exception 'Account % is not an active posting account', acc.code using errcode = '23514';
    end if;
    dr := coalesce((ln->>'debit')::numeric, 0); cr := coalesce((ln->>'credit')::numeric, 0);
    if dr < 0 or cr < 0 or (dr > 0 and cr > 0) then
      raise exception 'Journal lines need a non-negative debit or credit, not both' using errcode = 'P0001';
    end if;
    if dr <> round(dr, 2) or cr <> round(cr, 2) then
      raise exception 'Journal amounts must have at most 2 decimals' using errcode = 'P0001';
    end if;
  end loop;
  j := public.create_journal(p_company, p_branch, p_date, p_source_type, p_source_id, p_source_number, p_memo, p_user, p_lines);
  if j is null then
    raise exception 'Journal has no amounts' using errcode = 'P0001';
  end if;
  return j;
end; $$;

-- ===========================================================================
-- F. Ordered stock-balance locks: callers that touch several products lock
-- them all first, in (branch, product) order, to avoid deadlocks.
-- p_keys: [{"branch_id": "...", "product_id": "..."}, ...]
-- ===========================================================================
create or replace function public.lock_stock_balances(p_company uuid, p_keys jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k record;
begin
  for k in select distinct (e->>'branch_id')::uuid b, (e->>'product_id')::uuid p
           from jsonb_array_elements(p_keys) e order by 1, 2 loop
    if not exists (select 1 from public.branches where id = k.b and company_id = p_company)
       or not exists (select 1 from public.products where id = k.p and company_id = p_company) then
      raise exception 'Stock key does not belong to this company' using errcode = '23514';
    end if;
    insert into public.stock_balances(company_id, branch_id, product_id) values (p_company, k.b, k.p)
      on conflict (company_id, branch_id, product_id) do nothing;
    perform 1 from public.stock_balances
      where company_id = p_company and branch_id = k.b and product_id = k.p for update;
  end loop;
end; $$;

-- ===========================================================================
-- G. Allocation engine.
--   p_basis  : 'direct' | 'weight' | 'value' | 'volume' | 'quantity' | 'percent' | 'manual'
--   p_targets: [{"id": uuid, "factor": n}]  (weight / value / volume / quantity)
--              [{"id": uuid, "percent": n}] (percent, must total exactly 100)
--              [{"id": uuid, "amount": n}]  (manual, must total exactly p_total)
--              [{"id": uuid}]               (direct, exactly one target)
-- Shares are computed in numeric, rounded to 2 dp; the remaining cents go to
-- the largest fractional remainders (ties: larger base share, then id), so
-- the result always sums exactly to p_total. Negative totals (credits) are
-- allocated by magnitude and keep their sign.
-- ===========================================================================
create or replace function public.allocate_amount(p_total numeric, p_basis text, p_targets jsonb)
returns table(target_id uuid, amount numeric)
language plpgsql immutable security definer set search_path = public as $$
declare
  n int; denom numeric := 0; t jsonb; total_abs numeric; sgn int;
  cents bigint;
begin
  if p_total is null or p_total <> round(p_total, 2) then
    raise exception 'Allocation total must be a 2-decimal amount' using errcode = 'P0001';
  end if;
  if p_targets is null or jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) = 0 then
    raise exception 'Allocation needs at least one target' using errcode = 'P0001';
  end if;
  n := jsonb_array_length(p_targets);
  if (select count(distinct e->>'id') from jsonb_array_elements(p_targets) e) <> n
     or exists (select 1 from jsonb_array_elements(p_targets) e where e->>'id' is null) then
    raise exception 'Allocation targets must have distinct ids' using errcode = 'P0001';
  end if;
  sgn := case when p_total < 0 then -1 else 1 end;
  total_abs := abs(p_total);
  cents := (total_abs * 100)::bigint;

  if p_basis = 'direct' then
    if n <> 1 then raise exception 'Direct allocation needs exactly one target' using errcode = 'P0001'; end if;
    return query select (p_targets->0->>'id')::uuid, round(p_total, 2);
    return;
  elsif p_basis = 'manual' then
    for t in select * from jsonb_array_elements(p_targets) loop
      if t->>'amount' is null or (t->>'amount')::numeric <> round((t->>'amount')::numeric, 2) then
        raise exception 'Manual allocation amounts must be 2-decimal amounts' using errcode = 'P0001';
      end if;
      if sign((t->>'amount')::numeric) * sgn < 0 then
        raise exception 'Manual allocation amounts must share the sign of the total' using errcode = 'P0001';
      end if;
      denom := denom + (t->>'amount')::numeric;
    end loop;
    if denom <> p_total then
      raise exception 'Manual allocations total % but must equal %', denom, p_total using errcode = 'P0001';
    end if;
    return query select (e->>'id')::uuid, round((e->>'amount')::numeric, 2) from jsonb_array_elements(p_targets) e;
    return;
  elsif p_basis = 'percent' then
    for t in select * from jsonb_array_elements(p_targets) loop
      if t->>'percent' is null or (t->>'percent')::numeric < 0 or (t->>'percent')::numeric > 100 then
        raise exception 'Percentages must be between 0 and 100' using errcode = 'P0001';
      end if;
      denom := denom + (t->>'percent')::numeric;
    end loop;
    if denom <> 100 then
      raise exception 'Percentages total % but must total exactly 100', denom using errcode = 'P0001';
    end if;
    -- fall through to proportional split using percent as the factor
    p_targets := (select jsonb_agg(jsonb_build_object('id', e->>'id', 'factor', e->>'percent')) from jsonb_array_elements(p_targets) e);
  elsif p_basis in ('weight','value','volume','quantity') then
    for t in select * from jsonb_array_elements(p_targets) loop
      if t->>'factor' is null then
        raise exception 'Every target needs a % factor', p_basis using errcode = 'P0001';
      end if;
      if (t->>'factor')::numeric < 0 then
        raise exception 'Allocation factors cannot be negative' using errcode = 'P0001';
      end if;
      denom := denom + (t->>'factor')::numeric;
    end loop;
    if denom = 0 then
      raise exception 'Cannot allocate by %: the factors total zero', p_basis using errcode = 'P0001';
    end if;
  else
    raise exception 'Unknown allocation basis %', p_basis using errcode = 'P0001';
  end if;

  -- Proportional split with largest remainder (in cents).
  return query
  with base as (
    select (e->>'id')::uuid as id, (e->>'factor')::numeric as f
    from jsonb_array_elements(p_targets) e
  ), shares as (
    select id, f,
           (cents::numeric * f / (select sum(f) from base)) as exact_cents
    from base
  ), floored as (
    select id, f, exact_cents, floor(exact_cents)::bigint as fl, exact_cents - floor(exact_cents) as rem
    from shares
  ), ranked as (
    select id, fl, row_number() over (order by rem desc, f desc, id) as rk,
           cents - (select sum(fl) from floored) as left_over
    from floored
  )
  select id, round(sgn * (fl + case when rk <= left_over then 1 else 0 end)::numeric / 100, 2)
  from ranked;
end; $$;

-- ===========================================================================
-- Shared helper: insert-only tables.
-- ===========================================================================
create or replace function public.block_update_delete()
returns trigger language plpgsql as $$
begin
  raise exception '% rows cannot be changed or deleted', TG_TABLE_NAME using errcode = '0A000';
end; $$;

-- ===========================================================================
-- H. Supplier-invoice registry: one supplier invoice number can back only one
-- posted document across purchases and cost invoices (expenses have no
-- supplier-invoice field today; see docs).
-- ===========================================================================
create table if not exists public.supplier_invoice_registry (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete restrict,
  supplier_id  uuid not null references public.suppliers(id) on delete restrict,
  invoice_norm text not null check (invoice_norm <> ''),
  source_type  text not null check (source_type in ('purchase','cost_invoice')),
  source_id    uuid not null,
  created_at   timestamptz not null default now(),
  unique (company_id, supplier_id, invoice_norm),
  unique (source_type, source_id)
);
drop trigger if exists trg_sir_company on public.supplier_invoice_registry;
create trigger trg_sir_company before insert or update on public.supplier_invoice_registry
  for each row execute function public.check_company_consistency('supplier_id', 'suppliers');

create or replace function public.register_supplier_invoice(
  p_company uuid, p_supplier uuid, p_invoice text, p_source_type text, p_source_id uuid
) returns void language plpgsql security definer set search_path = public as $$
declare norm text; existing public.supplier_invoice_registry;
begin
  norm := public.norm_invoice(p_invoice);
  if norm is null or norm = '' then return; end if;
  select * into existing from public.supplier_invoice_registry
    where company_id = p_company and supplier_id = p_supplier and invoice_norm = norm;
  if found then
    if existing.source_type = p_source_type and existing.source_id = p_source_id then return; end if;
    raise exception 'Supplier invoice % is already recorded on another % document', p_invoice, existing.source_type
      using errcode = '23505';
  end if;
  insert into public.supplier_invoice_registry(company_id, supplier_id, invoice_norm, source_type, source_id)
    values (p_company, p_supplier, norm, p_source_type, p_source_id);
end; $$;

-- Backfill from posted purchases (already unique per supplier among purchases).
insert into public.supplier_invoice_registry(company_id, supplier_id, invoice_norm, source_type, source_id)
  select company_id, supplier_id, supplier_invoice_norm, 'purchase', id
  from public.purchases
  where document_status = 'posted' and supplier_invoice_norm is not null and supplier_invoice_norm <> ''
on conflict do nothing;

-- Purchases posted from now on register automatically; a void frees the number.
create or replace function public.purchases_register_invoice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.document_status = 'posted' and OLD.document_status = 'draft' then
    perform public.register_supplier_invoice(NEW.company_id, NEW.supplier_id, NEW.supplier_invoice_number, 'purchase', NEW.id);
  elsif NEW.document_status = 'voided' and OLD.document_status = 'posted' then
    delete from public.supplier_invoice_registry where source_type = 'purchase' and source_id = NEW.id;
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_purchases_register_invoice on public.purchases;
create trigger trg_purchases_register_invoice after update of document_status on public.purchases
  for each row execute function public.purchases_register_invoice();

-- ===========================================================================
-- I. Import shipments
-- ===========================================================================
create table if not exists public.import_shipments (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete restrict,
  branch_id                uuid not null references public.branches(id) on delete restrict,
  supplier_id              uuid not null references public.suppliers(id) on delete restrict,
  document_number          text,
  reference                text,
  bill_of_lading           text,
  vessel                   text,
  container_refs           text,
  incoterm                 text not null check (incoterm in ('EXW','FCA','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')),
  goods_includes_freight   boolean not null,
  goods_includes_insurance boolean not null,
  currency_code            text not null default 'TZS' references public.currencies(code) on delete restrict,
  title_date               date,
  eta                      date,
  logistics_status         text not null default 'draft'
                             check (logistics_status in ('draft','ready','dispatched','partially_received','received','closed','cancelled')),
  cost_status              text not null default 'estimated'
                             check (cost_status in ('estimated','provisional','finalized','adjusted')),
  has_open_discrepancy     boolean not null default false,
  notes                    text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create unique index if not exists import_shipments_docnum on public.import_shipments(company_id, document_number) where document_number is not null;
create unique index if not exists import_shipments_bl on public.import_shipments(company_id, upper(btrim(bill_of_lading)))
  where bill_of_lading is not null and btrim(bill_of_lading) <> '';
create index if not exists import_shipments_company_idx on public.import_shipments(company_id, logistics_status);
drop trigger if exists trg_import_shipments_company on public.import_shipments;
create trigger trg_import_shipments_company before insert or update on public.import_shipments
  for each row execute function public.check_company_consistency('branch_id','branches','supplier_id','suppliers');
drop trigger if exists trg_import_shipments_updated on public.import_shipments;
create trigger trg_import_shipments_updated before update on public.import_shipments
  for each row execute function public.set_updated_at();

create table if not exists public.import_shipment_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete restrict,
  shipment_id   uuid not null references public.import_shipments(id) on delete cascade,
  product_id    uuid not null references public.products(id) on delete restrict,
  quantity      numeric(18,4) not null check (quantity > 0),
  net_kg        numeric(18,4) not null check (net_kg > 0),
  gross_kg      numeric(18,4) check (gross_kg is null or gross_kg > 0),
  volume_m3     numeric(18,4) check (volume_m3 is null or volume_m3 > 0),
  fc_unit_price numeric(18,6) not null default 0 check (fc_unit_price >= 0),
  fc_amount     numeric(18,2) not null default 0 check (fc_amount >= 0),
  tax_code_id   uuid references public.tax_codes(id) on delete set null,
  line_no       integer not null default 0,
  check (gross_kg is null or gross_kg >= net_kg)
);
create index if not exists import_shipment_lines_shipment_idx on public.import_shipment_lines(shipment_id);
drop trigger if exists trg_import_shipment_lines_company on public.import_shipment_lines;
create trigger trg_import_shipment_lines_company before insert or update on public.import_shipment_lines
  for each row execute function public.check_company_consistency(
    'shipment_id','import_shipments','product_id','products','tax_code_id','tax_codes');

-- ---------------------------------------------------------------------------
-- Foreign purchase amounts on the existing purchases model.
--   posting_mode 'stock_on_post' : today's behaviour (default for every row)
--   posting_mode 'invoice_only'  : import goods invoice, no stock movement;
--                                  posting is blocked until Stage 3 ships its
--                                  posting function (guard trigger below).
-- ---------------------------------------------------------------------------
alter table public.purchases add column if not exists import_shipment_id uuid references public.import_shipments(id) on delete restrict;
alter table public.purchases add column if not exists posting_mode text not null default 'stock_on_post';
alter table public.purchases add column if not exists currency_code text not null default 'TZS' references public.currencies(code) on delete restrict;
alter table public.purchases add column if not exists exchange_rate numeric(18,6) not null default 1;
alter table public.purchases add column if not exists fc_subtotal numeric(18,2) not null default 0;
alter table public.purchases add column if not exists fc_tax_total numeric(18,2) not null default 0;
alter table public.purchases add column if not exists fc_grand_total numeric(18,2) not null default 0;
alter table public.purchase_lines add column if not exists import_shipment_line_id uuid references public.import_shipment_lines(id) on delete restrict;
alter table public.purchase_lines add column if not exists fc_unit_cost numeric(18,6);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchases_posting_mode_check') then
    alter table public.purchases add constraint purchases_posting_mode_check check (posting_mode in ('stock_on_post','invoice_only'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchases_rate_positive') then
    alter table public.purchases add constraint purchases_rate_positive check (exchange_rate > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchases_tzs_rate_one') then
    alter table public.purchases add constraint purchases_tzs_rate_one check (currency_code <> 'TZS' or exchange_rate = 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchases_fc_import_only') then
    alter table public.purchases add constraint purchases_fc_import_only
      check (currency_code = 'TZS' or (import_shipment_id is not null and posting_mode = 'invoice_only'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchases_invoice_only_import') then
    alter table public.purchases add constraint purchases_invoice_only_import
      check (posting_mode = 'stock_on_post' or import_shipment_id is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchases_fc_nonnegative') then
    alter table public.purchases add constraint purchases_fc_nonnegative
      check (fc_subtotal >= 0 and fc_tax_total >= 0 and fc_grand_total >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchase_lines_fc_cost_nonnegative') then
    alter table public.purchase_lines add constraint purchase_lines_fc_cost_nonnegative
      check (fc_unit_cost is null or fc_unit_cost >= 0);
  end if;
end $$;
create index if not exists purchases_shipment_idx on public.purchases(import_shipment_id) where import_shipment_id is not null;

drop trigger if exists trg_purchases_import_company on public.purchases;
create trigger trg_purchases_import_company before insert or update of import_shipment_id on public.purchases
  for each row execute function public.check_company_consistency('import_shipment_id','import_shipments');

create or replace function public.purchases_guard_import()
returns trigger language plpgsql security definer set search_path = public as $$
declare sh public.import_shipments;
begin
  if NEW.import_shipment_id is not null then
    select * into sh from public.import_shipments where id = NEW.import_shipment_id;
    if not found or sh.company_id <> NEW.company_id then
      raise exception 'Cross-company reference on purchases.import_shipment_id' using errcode = '23514';
    end if;
    if sh.supplier_id <> NEW.supplier_id then
      raise exception 'The goods invoice supplier must be the shipment supplier' using errcode = '23514';
    end if;
    if NEW.currency_code <> sh.currency_code then
      raise exception 'The goods invoice currency must be the shipment currency (%)', sh.currency_code using errcode = '23514';
    end if;
  end if;
  -- invoice_only purchases are posted only by the import posting function.
  if TG_OP = 'UPDATE' and NEW.posting_mode = 'invoice_only'
     and NEW.document_status = 'posted' and OLD.document_status = 'draft'
     and coalesce(current_setting('letiq.import_posting', true), '') <> 'on' then
    raise exception 'Import goods invoices can only be posted through the import workflow' using errcode = 'P0001';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_purchases_guard_import on public.purchases;
create trigger trg_purchases_guard_import before insert or update on public.purchases
  for each row execute function public.purchases_guard_import();

create or replace function public.purchase_lines_guard_import()
returns trigger language plpgsql security definer set search_path = public as $$
declare pur public.purchases; sl public.import_shipment_lines;
begin
  if NEW.import_shipment_line_id is null then return NEW; end if;
  select * into pur from public.purchases where id = NEW.purchase_id;
  select * into sl from public.import_shipment_lines where id = NEW.import_shipment_line_id;
  if pur.import_shipment_id is null or sl.shipment_id <> pur.import_shipment_id then
    raise exception 'Purchase line must reference a line of the purchase''s own shipment' using errcode = '23514';
  end if;
  if sl.product_id <> NEW.product_id then
    raise exception 'Purchase line product must match the shipment line product' using errcode = '23514';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_purchase_lines_guard_import on public.purchase_lines;
create trigger trg_purchase_lines_guard_import before insert or update on public.purchase_lines
  for each row execute function public.purchase_lines_guard_import();

-- ---------------------------------------------------------------------------
-- Cost invoices (supplier service invoices: port, clearing, transport...).
-- Credit adjustments are explicit credit notes with positive amounts that
-- name the invoice they credit.
-- ---------------------------------------------------------------------------
create table if not exists public.cost_invoices (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies(id) on delete restrict,
  branch_id               uuid not null references public.branches(id) on delete restrict,
  supplier_id             uuid not null references public.suppliers(id) on delete restrict,
  document_kind           text not null default 'invoice' check (document_kind in ('invoice','credit_note')),
  credited_invoice_id     uuid references public.cost_invoices(id) on delete restrict,
  document_status         text not null default 'draft' check (document_status in ('draft','posted','voided')),
  document_number         text,
  document_date           date not null default current_date,
  supplier_invoice_number text,
  due_date                date,
  currency_code           text not null default 'TZS' references public.currencies(code) on delete restrict,
  exchange_rate           numeric(18,6) not null default 1 check (exchange_rate > 0),
  net_total               numeric(18,2) not null default 0 check (net_total >= 0),
  tax_total               numeric(18,2) not null default 0 check (tax_total >= 0),
  grand_total             numeric(18,2) not null default 0 check (grand_total >= 0),
  fc_grand_total          numeric(18,2) not null default 0 check (fc_grand_total >= 0),
  notes                   text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  posted_at  timestamptz,
  posted_by  uuid references auth.users(id) on delete set null,
  voided_at  timestamptz,
  voided_by  uuid references auth.users(id) on delete set null,
  void_reason text,
  check (currency_code <> 'TZS' or exchange_rate = 1),
  check ((document_kind = 'credit_note') = (credited_invoice_id is not null))
);
create unique index if not exists cost_invoices_docnum on public.cost_invoices(company_id, document_number) where document_number is not null;
drop trigger if exists trg_cost_invoices_company on public.cost_invoices;
create trigger trg_cost_invoices_company before insert or update on public.cost_invoices
  for each row execute function public.check_company_consistency(
    'branch_id','branches','supplier_id','suppliers','credited_invoice_id','cost_invoices');
drop trigger if exists trg_cost_invoices_updated on public.cost_invoices;
create trigger trg_cost_invoices_updated before update on public.cost_invoices
  for each row execute function public.set_updated_at();

create or replace function public.cost_invoices_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare cr public.cost_invoices;
begin
  if NEW.credited_invoice_id is not null then
    select * into cr from public.cost_invoices where id = NEW.credited_invoice_id;
    if cr.document_kind <> 'invoice' or cr.supplier_id <> NEW.supplier_id then
      raise exception 'A credit note must credit an invoice from the same supplier' using errcode = '23514';
    end if;
  end if;
  if TG_OP = 'UPDATE' and OLD.document_status <> 'draft' and (
       NEW.net_total, NEW.tax_total, NEW.grand_total, NEW.supplier_id, NEW.currency_code, NEW.exchange_rate, NEW.document_date
     ) is distinct from (
       OLD.net_total, OLD.tax_total, OLD.grand_total, OLD.supplier_id, OLD.currency_code, OLD.exchange_rate, OLD.document_date) then
    raise exception 'A posted cost invoice cannot be edited; post a credit note instead' using errcode = 'P0001';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_cost_invoices_guard on public.cost_invoices;
create trigger trg_cost_invoices_guard before insert or update on public.cost_invoices
  for each row execute function public.cost_invoices_guard();

-- ---------------------------------------------------------------------------
-- Cost sources: one expected cost on a shipment, transfer or rebag order.
-- The category's treatment / account / commercial flag are SNAPSHOTTED at
-- creation and frozen once the source is accrued or invoiced, so editing a
-- category's defaults never changes an old posting.
-- ---------------------------------------------------------------------------
create table if not exists public.cost_sources (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references public.companies(id) on delete restrict,
  owner_type                 text not null check (owner_type in ('import_shipment','stock_transfer','rebag_order')),
  import_shipment_id         uuid references public.import_shipments(id) on delete restrict,
  stock_transfer_id          uuid references public.stock_transfers(id) on delete restrict,
  rebag_order_id             uuid,  -- FK added after rebag_orders exists
  cost_category_id           uuid not null references public.cost_categories(id) on delete restrict,
  supplier_id                uuid references public.suppliers(id) on delete restrict,
  description                text,
  status                     text not null default 'estimated' check (status in ('estimated','accrued','invoiced','voided')),
  inventory_treatment        text not null default 'capitalize' check (inventory_treatment in ('capitalize','expense')),
  expense_account_id         uuid references public.chart_of_accounts(id) on delete restrict,
  allocation_basis           text check (allocation_basis in ('direct','weight','value','volume','quantity','percent','manual')),
  include_in_commercial_cost boolean not null default true,
  estimated_amount           numeric(18,2) not null default 0 check (estimated_amount >= 0),
  accrued_amount             numeric(18,2) not null default 0 check (accrued_amount >= 0),
  actual_amount              numeric(18,2) not null default 0 check (actual_amount >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  check ((import_shipment_id is not null)::int + (stock_transfer_id is not null)::int + (rebag_order_id is not null)::int = 1),
  check ((owner_type = 'import_shipment') = (import_shipment_id is not null)),
  check ((owner_type = 'stock_transfer') = (stock_transfer_id is not null)),
  check ((owner_type = 'rebag_order') = (rebag_order_id is not null))
);
create index if not exists cost_sources_shipment_idx on public.cost_sources(import_shipment_id);
create index if not exists cost_sources_transfer_idx on public.cost_sources(stock_transfer_id);
create index if not exists cost_sources_rebag_idx on public.cost_sources(rebag_order_id);
drop trigger if exists trg_cost_sources_company on public.cost_sources;
create trigger trg_cost_sources_company before insert or update on public.cost_sources
  for each row execute function public.check_company_consistency(
    'import_shipment_id','import_shipments','stock_transfer_id','stock_transfers',
    'cost_category_id','cost_categories','supplier_id','suppliers','expense_account_id','chart_of_accounts');

create or replace function public.cost_sources_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare cat public.cost_categories; sh public.import_shipments;
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
       or (NEW.owner_type = 'rebag_order' and not cat.applies_to_rebagging) then
      raise exception 'Cost category % does not apply to %', cat.code, NEW.owner_type using errcode = '23514';
    end if;
    -- snapshot the classification (the category row may change later)
    NEW.inventory_treatment := cat.inventory_treatment;
    NEW.expense_account_id := cat.expense_account_id;
    NEW.include_in_commercial_cost := cat.include_in_commercial_cost;
    if NEW.allocation_basis is null or TG_OP = 'UPDATE' then
      NEW.allocation_basis := case cat.allocation_basis when 'net_weight' then 'weight' else cat.allocation_basis end;
    end if;
    -- no double freight / insurance on CIF-style shipments
    if NEW.import_shipment_id is not null and cat.component is not null then
      select * into sh from public.import_shipments where id = NEW.import_shipment_id;
      if (cat.component = 'freight' and sh.goods_includes_freight)
         or (cat.component = 'insurance' and sh.goods_includes_insurance) then
        raise exception 'This shipment''s goods value already includes %; it cannot be added again', cat.component
          using errcode = '23514';
      end if;
    end if;
  end if;
  if TG_OP = 'UPDATE' and OLD.status <> 'estimated' and (
       NEW.inventory_treatment, NEW.expense_account_id, NEW.include_in_commercial_cost, NEW.allocation_basis,
       NEW.owner_type, NEW.import_shipment_id, NEW.stock_transfer_id, NEW.rebag_order_id
     ) is distinct from (
       OLD.inventory_treatment, OLD.expense_account_id, OLD.include_in_commercial_cost, OLD.allocation_basis,
       OLD.owner_type, OLD.import_shipment_id, OLD.stock_transfer_id, OLD.rebag_order_id) then
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
drop trigger if exists trg_cost_sources_guard on public.cost_sources;
create trigger trg_cost_sources_guard before insert or update on public.cost_sources
  for each row execute function public.cost_sources_guard();
drop trigger if exists trg_cost_sources_updated on public.cost_sources;
create trigger trg_cost_sources_updated before update on public.cost_sources
  for each row execute function public.set_updated_at();

create table if not exists public.cost_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete restrict,
  cost_invoice_id   uuid not null references public.cost_invoices(id) on delete cascade,
  cost_category_id  uuid not null references public.cost_categories(id) on delete restrict,
  cost_source_id    uuid references public.cost_sources(id) on delete restrict,
  description       text,
  net_amount        numeric(18,2) not null check (net_amount >= 0),
  tax_code_id       uuid references public.tax_codes(id) on delete set null,
  tax_rate          numeric(9,4) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  is_recoverable    boolean not null default true,
  tax_amount        numeric(18,2) not null default 0 check (tax_amount >= 0),
  fc_net_amount     numeric(18,2) check (fc_net_amount is null or fc_net_amount >= 0),
  line_no           integer not null default 0
);
create index if not exists cost_invoice_lines_invoice_idx on public.cost_invoice_lines(cost_invoice_id);
drop trigger if exists trg_cost_invoice_lines_company on public.cost_invoice_lines;
create trigger trg_cost_invoice_lines_company before insert or update on public.cost_invoice_lines
  for each row execute function public.check_company_consistency(
    'cost_invoice_id','cost_invoices','cost_category_id','cost_categories',
    'cost_source_id','cost_sources','tax_code_id','tax_codes');

-- A cost source can be actualised by one line of one posted invoice only.
create table if not exists public.cost_source_actuals (
  cost_source_id       uuid primary key references public.cost_sources(id) on delete restrict,
  cost_invoice_line_id uuid not null unique references public.cost_invoice_lines(id) on delete restrict,
  company_id           uuid not null references public.companies(id) on delete restrict,
  created_at           timestamptz not null default now()
);
drop trigger if exists trg_cost_source_actuals_company on public.cost_source_actuals;
create trigger trg_cost_source_actuals_company before insert or update on public.cost_source_actuals
  for each row execute function public.check_company_consistency(
    'cost_source_id','cost_sources','cost_invoice_line_id','cost_invoice_lines');

-- Supplier balances gain cost invoices and foreign-currency amounts.
alter table public.supplier_payables add column if not exists cost_invoice_id uuid references public.cost_invoices(id) on delete cascade;
alter table public.supplier_payables add column if not exists currency_code text not null default 'TZS' references public.currencies(code);
alter table public.supplier_payables add column if not exists fc_original numeric(18,2) not null default 0;
alter table public.supplier_payables add column if not exists fc_outstanding numeric(18,2) not null default 0;
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.supplier_payables'::regclass and contype = 'c'
             and conname not in ('supplier_payables_sources_one','supplier_payables_source_match','supplier_payables_fc_nonnegative')
             and (pg_get_constraintdef(oid) ilike '%purchase_id%' or pg_get_constraintdef(oid) ilike '%source_type%') loop
    execute format('alter table public.supplier_payables drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'supplier_payables_sources_one') then
    alter table public.supplier_payables add constraint supplier_payables_sources_one check (
      (purchase_id is not null)::int + (expense_id is not null)::int + (cost_invoice_id is not null)::int = 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'supplier_payables_source_match') then
    alter table public.supplier_payables add constraint supplier_payables_source_match check (
      (source_type = 'purchase' and purchase_id is not null)
      or (source_type = 'expense' and expense_id is not null)
      or (source_type = 'cost_invoice' and cost_invoice_id is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'supplier_payables_fc_nonnegative') then
    alter table public.supplier_payables add constraint supplier_payables_fc_nonnegative
      check (fc_original >= 0 and fc_outstanding >= 0 and fc_outstanding <= fc_original);
  end if;
end $$;
create unique index if not exists payable_cost_invoice_unique on public.supplier_payables(cost_invoice_id) where cost_invoice_id is not null;

-- ---------------------------------------------------------------------------
-- Import goods receipts (GRN). Posting arrives in Stage 3.
-- ---------------------------------------------------------------------------
create table if not exists public.import_receipts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  shipment_id     uuid not null references public.import_shipments(id) on delete restrict,
  branch_id       uuid not null references public.branches(id) on delete restrict,
  document_number text,
  receipt_date    date not null default current_date,
  document_status text not null default 'draft' check (document_status in ('draft','posted','voided')),
  notes           text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  posted_at  timestamptz,
  posted_by  uuid references auth.users(id) on delete set null
);
create unique index if not exists import_receipts_docnum on public.import_receipts(company_id, document_number) where document_number is not null;
drop trigger if exists trg_import_receipts_company on public.import_receipts;
create trigger trg_import_receipts_company before insert or update on public.import_receipts
  for each row execute function public.check_company_consistency('shipment_id','import_shipments','branch_id','branches');

create table if not exists public.import_receipt_lines (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete restrict,
  receipt_id        uuid not null references public.import_receipts(id) on delete cascade,
  shipment_line_id  uuid not null references public.import_shipment_lines(id) on delete restrict,
  quantity_received numeric(18,4) not null check (quantity_received >= 0),
  net_kg_received   numeric(18,4) not null check (net_kg_received >= 0),
  shortage_kg       numeric(18,4) not null default 0 check (shortage_kg >= 0),
  damaged_kg        numeric(18,4) not null default 0 check (damaged_kg >= 0),
  resolution        text check (resolution in ('normal_loss','write_off','claim')),
  resolved_by       uuid references auth.users(id) on delete set null,
  resolved_at       timestamptz,
  line_no           integer not null default 0
);
drop trigger if exists trg_import_receipt_lines_company on public.import_receipt_lines;
create trigger trg_import_receipt_lines_company before insert or update on public.import_receipt_lines
  for each row execute function public.check_company_consistency(
    'receipt_id','import_receipts','shipment_line_id','import_shipment_lines');

create or replace function public.import_receipt_lines_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r public.import_receipts; sl public.import_shipment_lines;
begin
  select * into r from public.import_receipts where id = NEW.receipt_id;
  select * into sl from public.import_shipment_lines where id = NEW.shipment_line_id;
  if sl.shipment_id <> r.shipment_id then
    raise exception 'Receipt line must belong to the receipt''s shipment' using errcode = '23514';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_import_receipt_lines_guard on public.import_receipt_lines;
create trigger trg_import_receipt_lines_guard before insert or update on public.import_receipt_lines
  for each row execute function public.import_receipt_lines_guard();

-- ===========================================================================
-- J. Package configuration, rebagging lineage and provenance lots
-- ===========================================================================
-- Packaged bags are counted in whole units: their base unit must not allow
-- decimals (extends the 0024 stock-role validation).
create or replace function public.products_validate_pack_unit()
returns trigger language plpgsql security definer set search_path = public as $$
declare dec boolean;
begin
  if NEW.stock_role = 'packaged' then
    select allow_decimal into dec from public.units where id = NEW.base_unit_id;
    if dec is distinct from false then
      raise exception 'A packaged product needs a whole-number unit (decimals not allowed), e.g. BAG'
        using errcode = '23514';
    end if;
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_products_pack_unit on public.products;
create trigger trg_products_pack_unit before insert or update on public.products
  for each row execute function public.products_validate_pack_unit();

create table if not exists public.rebag_orders (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete restrict,
  branch_id         uuid not null references public.branches(id) on delete restrict,
  bulk_product_id   uuid not null references public.products(id) on delete restrict,
  document_number   text,
  order_date        date not null default current_date,
  document_status   text not null default 'draft' check (document_status in ('draft','posted','voided')),
  cost_status       text not null default 'estimated' check (cost_status in ('estimated','provisional','finalized','adjusted')),
  normal_loss_kg    numeric(18,4) not null default 0 check (normal_loss_kg >= 0),
  abnormal_loss_kg  numeric(18,4) not null default 0 check (abnormal_loss_kg >= 0),
  notes             text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  posted_at  timestamptz,
  posted_by  uuid references auth.users(id) on delete set null
);
create unique index if not exists rebag_orders_docnum on public.rebag_orders(company_id, document_number) where document_number is not null;
drop trigger if exists trg_rebag_orders_company on public.rebag_orders;
create trigger trg_rebag_orders_company before insert or update on public.rebag_orders
  for each row execute function public.check_company_consistency('branch_id','branches','bulk_product_id','products');

create or replace function public.rebag_orders_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.products where id = NEW.bulk_product_id and stock_role = 'bulk') then
    raise exception 'A rebag order consumes a bulk product' using errcode = '23514';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_rebag_orders_guard on public.rebag_orders;
create trigger trg_rebag_orders_guard before insert or update on public.rebag_orders
  for each row execute function public.rebag_orders_guard();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cost_sources_rebag_order_fk') then
    alter table public.cost_sources add constraint cost_sources_rebag_order_fk
      foreign key (rebag_order_id) references public.rebag_orders(id) on delete restrict;
  end if;
end $$;
drop trigger if exists trg_cost_sources_company_rebag on public.cost_sources;
create trigger trg_cost_sources_company_rebag before insert or update on public.cost_sources
  for each row execute function public.check_company_consistency('rebag_order_id','rebag_orders');

create table if not exists public.rebag_outputs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  order_id    uuid not null references public.rebag_orders(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete restrict,
  bags        numeric(18,4) not null check (bags > 0 and bags = trunc(bags)),
  net_kg      numeric(18,4) not null check (net_kg > 0),
  line_no     integer not null default 0
);
drop trigger if exists trg_rebag_outputs_company on public.rebag_outputs;
create trigger trg_rebag_outputs_company before insert or update on public.rebag_outputs
  for each row execute function public.check_company_consistency('order_id','rebag_orders','product_id','products');

create table if not exists public.rebag_inputs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  order_id         uuid not null references public.rebag_orders(id) on delete cascade,
  input_kind       text not null check (input_kind in ('bulk','packaging')),
  product_id       uuid not null references public.products(id) on delete restrict,
  quantity         numeric(18,4) not null check (quantity > 0),
  target_output_id uuid references public.rebag_outputs(id) on delete cascade,
  line_no          integer not null default 0,
  check ((input_kind = 'packaging') = (target_output_id is not null))
);
drop trigger if exists trg_rebag_inputs_company on public.rebag_inputs;
create trigger trg_rebag_inputs_company before insert or update on public.rebag_inputs
  for each row execute function public.check_company_consistency(
    'order_id','rebag_orders','product_id','products','target_output_id','rebag_outputs');

-- Lineage: outputs are bags filled from the order's bulk product with the
-- product's fixed net kg; bulk inputs are that bulk product; packaging inputs
-- are packaging materials aimed at an output of the same order.
create or replace function public.rebag_lines_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare o public.rebag_orders; p public.products; tgt public.rebag_outputs;
begin
  select * into o from public.rebag_orders where id = NEW.order_id;
  if o.document_status <> 'draft' then
    raise exception 'Lines of a posted rebag order cannot change' using errcode = 'P0001';
  end if;
  select * into p from public.products where id = NEW.product_id;
  if TG_TABLE_NAME = 'rebag_outputs' then
    if p.stock_role <> 'packaged' or p.bulk_product_id <> o.bulk_product_id then
      raise exception 'Rebag outputs must be bags filled from the order''s bulk product' using errcode = '23514';
    end if;
    if NEW.net_kg <> round(NEW.bags * p.net_weight_kg, 4) then
      raise exception 'Output net kg must equal bags x % kg', p.net_weight_kg using errcode = '23514';
    end if;
  else
    if NEW.input_kind = 'bulk' and NEW.product_id <> o.bulk_product_id then
      raise exception 'The bulk input must be the order''s bulk product' using errcode = '23514';
    end if;
    if NEW.input_kind = 'packaging' then
      if p.stock_role <> 'packaging_material' then
        raise exception 'Packaging inputs must be packaging materials' using errcode = '23514';
      end if;
      select * into tgt from public.rebag_outputs where id = NEW.target_output_id;
      if tgt.order_id <> NEW.order_id then
        raise exception 'Packaging must target an output of the same order' using errcode = '23514';
      end if;
    end if;
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_rebag_outputs_guard on public.rebag_outputs;
create trigger trg_rebag_outputs_guard before insert or update on public.rebag_outputs
  for each row execute function public.rebag_lines_guard();
drop trigger if exists trg_rebag_inputs_guard on public.rebag_inputs;
create trigger trg_rebag_inputs_guard before insert or update on public.rebag_inputs
  for each row execute function public.rebag_lines_guard();

-- Provenance lots: quantity only, never value (valuation stays weighted
-- average in stock_balances). Maintained by the posting functions of later
-- stages.
create table if not exists public.stock_lots (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  product_id  uuid not null references public.products(id) on delete restrict,
  origin_type text not null check (origin_type in ('import_receipt_line','rebag_output','untracked')),
  origin_id   uuid,
  original_quantity numeric(18,4) not null check (original_quantity >= 0),
  lot_code    text,
  created_at  timestamptz not null default now(),
  check ((origin_type = 'untracked') = (origin_id is null))
);
create unique index if not exists stock_lots_origin on public.stock_lots(origin_type, origin_id) where origin_id is not null;
drop trigger if exists trg_stock_lots_company on public.stock_lots;
create trigger trg_stock_lots_company before insert or update on public.stock_lots
  for each row execute function public.check_company_consistency('product_id','products');

create table if not exists public.stock_lot_balances (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  branch_id  uuid not null references public.branches(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  lot_id     uuid not null references public.stock_lots(id) on delete restrict,
  quantity   numeric(18,4) not null default 0 check (quantity >= 0),
  unique (branch_id, product_id, lot_id)
);
drop trigger if exists trg_stock_lot_balances_company on public.stock_lot_balances;
create trigger trg_stock_lot_balances_company before insert or update on public.stock_lot_balances
  for each row execute function public.check_company_consistency('branch_id','branches','product_id','products','lot_id','stock_lots');

create table if not exists public.stock_lot_flows (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete restrict,
  movement_id        uuid references public.stock_movements(id) on delete restrict,
  flow_type          text not null check (flow_type in (
                       'receipt','sale','sales_return','transfer_out','transfer_in','rebag_consume','rebag_produce',
                       'adjustment','write_off','purchase_return','void')),
  from_lot_id        uuid references public.stock_lots(id) on delete restrict,
  to_lot_id          uuid references public.stock_lots(id) on delete restrict,
  branch_id          uuid not null references public.branches(id) on delete restrict,
  quantity           numeric(18,4) not null check (quantity > 0),
  cost_delta_applied numeric(18,2) not null default 0,
  created_at         timestamptz not null default now(),
  check (from_lot_id is not null or to_lot_id is not null)
);
create index if not exists stock_lot_flows_from_idx on public.stock_lot_flows(from_lot_id);
create index if not exists stock_lot_flows_to_idx on public.stock_lot_flows(to_lot_id);
drop trigger if exists trg_stock_lot_flows_company on public.stock_lot_flows;
create trigger trg_stock_lot_flows_company before insert or update on public.stock_lot_flows
  for each row execute function public.check_company_consistency(
    'movement_id','stock_movements','from_lot_id','stock_lots','to_lot_id','stock_lots','branch_id','branches');

-- ===========================================================================
-- K. Transfer logistics, costing and partial receipts
-- ===========================================================================
create table if not exists public.drivers (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete restrict,
  name           text not null,
  phone          text,
  licence_number text,
  transporter_id uuid references public.suppliers(id) on delete restrict,
  is_active      boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
drop trigger if exists trg_drivers_company on public.drivers;
create trigger trg_drivers_company before insert or update on public.drivers
  for each row execute function public.check_company_consistency('transporter_id','suppliers');

create table if not exists public.vehicles (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete restrict,
  registration   text not null,
  description    text,
  transporter_id uuid references public.suppliers(id) on delete restrict,
  is_active      boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create unique index if not exists vehicles_registration on public.vehicles(company_id, upper(regexp_replace(registration, '\s', '', 'g')));
drop trigger if exists trg_vehicles_company on public.vehicles;
create trigger trg_vehicles_company before insert or update on public.vehicles
  for each row execute function public.check_company_consistency('transporter_id','suppliers');

alter table public.stock_transfers add column if not exists cost_status text not null default 'estimated';
alter table public.stock_transfers add column if not exists transporter_id uuid references public.suppliers(id) on delete restrict;
alter table public.stock_transfers add column if not exists driver_id uuid references public.drivers(id) on delete restrict;
alter table public.stock_transfers add column if not exists vehicle_id uuid references public.vehicles(id) on delete restrict;
alter table public.stock_transfers add column if not exists driver_name text;
alter table public.stock_transfers add column if not exists driver_phone text;
alter table public.stock_transfers add column if not exists driver_licence text;
alter table public.stock_transfers add column if not exists vehicle_registration text;
alter table public.stock_transfers add column if not exists trailer_registration text;
alter table public.stock_transfers add column if not exists agent_name text;
alter table public.stock_transfers add column if not exists agent_phone text;
alter table public.stock_transfers add column if not exists ready_by uuid references auth.users(id) on delete set null;
alter table public.stock_transfers add column if not exists ready_at timestamptz;
alter table public.stock_transfers add column if not exists closed_by uuid references auth.users(id) on delete set null;
alter table public.stock_transfers add column if not exists closed_at timestamptz;
alter table public.stock_transfers add column if not exists has_open_discrepancy boolean not null default false;
alter table public.stock_transfer_lines add column if not exists company_id uuid references public.companies(id) on delete restrict;
update public.stock_transfer_lines l set company_id = t.company_id
  from public.stock_transfers t where t.id = l.transfer_id and l.company_id is null;

do $$
declare c record;
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_cost_status_check') then
    alter table public.stock_transfers add constraint stock_transfers_cost_status_check
      check (cost_status in ('estimated','provisional','finalized','adjusted'));
  end if;
  -- Logistics states gain 'ready' and 'closed' (existing values unchanged).
  for c in select conname from pg_constraint
           where conrelid = 'public.stock_transfers'::regclass and contype = 'c'
             and conname <> 'stock_transfers_status_v2'
             and pg_get_constraintdef(oid) ilike '%partially_received%' loop
    execute format('alter table public.stock_transfers drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_status_v2') then
    alter table public.stock_transfers add constraint stock_transfers_status_v2
      check (status in ('draft','ready','dispatched','partially_received','received','closed','voided'));
  end if;
end $$;

drop trigger if exists trg_stock_transfers_logistics_company on public.stock_transfers;
create trigger trg_stock_transfers_logistics_company before insert or update on public.stock_transfers
  for each row execute function public.check_company_consistency(
    'source_branch_id','branches','destination_branch_id','branches',
    'transporter_id','suppliers','driver_id','drivers','vehicle_id','vehicles');

create or replace function public.stock_transfer_lines_company()
returns trigger language plpgsql security definer set search_path = public as $$
declare t public.stock_transfers;
begin
  select * into t from public.stock_transfers where id = NEW.transfer_id;
  if NEW.company_id is null then NEW.company_id := t.company_id; end if;
  if NEW.company_id <> t.company_id
     or not exists (select 1 from public.products where id = NEW.product_id and company_id = t.company_id) then
    raise exception 'Transfer line must use the transfer''s company and its products' using errcode = '23514';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_stock_transfer_lines_company on public.stock_transfer_lines;
create trigger trg_stock_transfer_lines_company before insert or update on public.stock_transfer_lines
  for each row execute function public.stock_transfer_lines_company();

create table if not exists public.stock_transfer_receipts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  transfer_id     uuid not null references public.stock_transfers(id) on delete restrict,
  document_number text,
  received_at     timestamptz not null default now(),
  received_by     uuid references auth.users(id) on delete set null,
  document_status text not null default 'posted' check (document_status in ('posted','voided')),
  notes           text
);
create unique index if not exists stock_transfer_receipts_docnum on public.stock_transfer_receipts(company_id, document_number) where document_number is not null;
drop trigger if exists trg_stock_transfer_receipts_company on public.stock_transfer_receipts;
create trigger trg_stock_transfer_receipts_company before insert or update on public.stock_transfer_receipts
  for each row execute function public.check_company_consistency('transfer_id','stock_transfers');

create table if not exists public.stock_transfer_receipt_lines (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  receipt_id       uuid not null references public.stock_transfer_receipts(id) on delete cascade,
  transfer_line_id uuid not null references public.stock_transfer_lines(id) on delete restrict,
  qty_received     numeric(18,4) not null default 0 check (qty_received >= 0),
  qty_short        numeric(18,4) not null default 0 check (qty_short >= 0),
  qty_damaged      numeric(18,4) not null default 0 check (qty_damaged >= 0),
  resolution       text check (resolution in ('normal_loss','write_off','claim')),
  resolved_by      uuid references auth.users(id) on delete set null,
  resolved_at      timestamptz,
  check (qty_received + qty_short + qty_damaged > 0)
);
drop trigger if exists trg_stock_transfer_receipt_lines_company on public.stock_transfer_receipt_lines;
create trigger trg_stock_transfer_receipt_lines_company before insert or update on public.stock_transfer_receipt_lines
  for each row execute function public.check_company_consistency(
    'receipt_id','stock_transfer_receipts','transfer_line_id','stock_transfer_lines');

-- ===========================================================================
-- G (cont). Allocation runs: allocate one cost source over its owner's
-- targets. Factors for weight / value / quantity / volume are read from the
-- database (never trusted from the caller). Runs and allocations are
-- insert-only; a new run supersedes the previous one.
-- ===========================================================================
create table if not exists public.cost_allocation_runs (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete restrict,
  cost_source_id uuid not null references public.cost_sources(id) on delete restrict,
  amount_kind    text not null check (amount_kind in ('estimated','accrued','actual','delta')),
  basis          text not null check (basis in ('direct','weight','value','volume','quantity','percent','manual')),
  total_amount   numeric(18,2) not null,
  is_current     boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null
);
create unique index if not exists cost_allocation_runs_current
  on public.cost_allocation_runs(cost_source_id, amount_kind) where is_current;
drop trigger if exists trg_cost_allocation_runs_company on public.cost_allocation_runs;
create trigger trg_cost_allocation_runs_company before insert or update on public.cost_allocation_runs
  for each row execute function public.check_company_consistency('cost_source_id','cost_sources');

create or replace function public.cost_allocation_runs_guard()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Allocation runs cannot be deleted' using errcode = '0A000';
  end if;
  if (NEW.company_id, NEW.cost_source_id, NEW.amount_kind, NEW.basis, NEW.total_amount, NEW.created_at, NEW.created_by)
     is distinct from (OLD.company_id, OLD.cost_source_id, OLD.amount_kind, OLD.basis, OLD.total_amount, OLD.created_at, OLD.created_by)
     or (OLD.is_current = false and NEW.is_current = true) then
    raise exception 'Allocation runs are immutable (only superseding is allowed)' using errcode = '0A000';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_cost_allocation_runs_guard on public.cost_allocation_runs;
create trigger trg_cost_allocation_runs_guard before update or delete on public.cost_allocation_runs
  for each row execute function public.cost_allocation_runs_guard();

create table if not exists public.cost_allocations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  run_id      uuid not null references public.cost_allocation_runs(id) on delete restrict,
  target_type text not null check (target_type in ('import_shipment_line','import_receipt_line','stock_transfer_line','rebag_output')),
  target_id   uuid not null,
  factor      numeric(28,10),
  amount      numeric(18,2) not null,
  unique (run_id, target_id)
);
create index if not exists cost_allocations_target_idx on public.cost_allocations(target_type, target_id);
drop trigger if exists trg_cost_allocations_company on public.cost_allocations;
create trigger trg_cost_allocations_company before insert or update on public.cost_allocations
  for each row execute function public.check_company_consistency('run_id','cost_allocation_runs');
drop trigger if exists trg_cost_allocations_immutable on public.cost_allocations;
create trigger trg_cost_allocations_immutable before update or delete on public.cost_allocations
  for each row execute function public.block_update_delete();

create or replace function public.allocate_cost_source(
  p_source uuid, p_amount_kind text, p_amount numeric, p_basis text, p_targets jsonb,
  p_user uuid, p_idem text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  s public.cost_sources; perm text; flag text; branch uuid; ttype text;
  v_run uuid; t jsonb := '[]'::jsonb; rec record; total numeric; n_targets int;
begin
  select * into s from public.cost_sources where id = p_source for update;
  if not found then raise exception 'Cost source not found' using errcode = 'P0001'; end if;
  if s.status = 'voided' then raise exception 'Cost source is voided' using errcode = 'P0001'; end if;

  if s.owner_type = 'import_shipment' then
    perm := 'imports.edit_draft'; flag := 'imports'; ttype := 'import_shipment_line';
    select branch_id into branch from public.import_shipments where id = s.import_shipment_id;
  elsif s.owner_type = 'stock_transfer' then
    perm := 'inventory.transfer_create'; flag := 'transfer_logistics'; ttype := 'stock_transfer_line';
    select source_branch_id into branch from public.stock_transfers where id = s.stock_transfer_id;
  else
    perm := 'rebagging.create'; flag := 'rebagging'; ttype := 'rebag_output';
    select branch_id into branch from public.rebag_orders where id = s.rebag_order_id;
  end if;
  perform public.assert_feature(s.company_id, flag);
  perform public.assert_actor(p_user, s.company_id, perm, branch);
  if p_amount_kind not in ('estimated','accrued','actual','delta') then
    raise exception 'Unknown amount kind %', p_amount_kind using errcode = 'P0001';
  end if;
  if p_amount_kind <> 'delta' and p_amount < 0 then
    raise exception 'Allocated amount cannot be negative' using errcode = 'P0001';
  end if;
  if s.inventory_treatment = 'expense' then
    raise exception 'Expensed costs are not allocated to stock' using errcode = 'P0001';
  end if;
  if not public.claim_operation(p_idem, 'allocate_cost_source:' || p_amount_kind, p_source) then
    select id into v_run from public.cost_allocation_runs
      where cost_source_id = p_source and amount_kind = p_amount_kind and is_current;
    return v_run;
  end if;

  -- Build the target list. Targets must be the owner's own lines.
  for rec in
    select x.id, x.weight, x.value, x.qty, x.volume from (
      select l.id, l.net_kg weight, l.fc_amount value, l.quantity qty, l.volume_m3 volume
        from public.import_shipment_lines l where s.owner_type = 'import_shipment' and l.shipment_id = s.import_shipment_id
      union all
      select l.id, l.qty_requested * p.net_weight_kg, l.qty_requested * l.unit_cost, l.qty_requested, null
        from public.stock_transfer_lines l join public.products p on p.id = l.product_id
        where s.owner_type = 'stock_transfer' and l.transfer_id = s.stock_transfer_id
      union all
      select o.id, o.net_kg, null, o.bags, null
        from public.rebag_outputs o where s.owner_type = 'rebag_order' and o.order_id = s.rebag_order_id
    ) x
    where p_targets is null or jsonb_array_length(p_targets) = 0
       or exists (select 1 from jsonb_array_elements(p_targets) e where (e->>'id')::uuid = x.id)
  loop
    t := t || case p_basis
      when 'weight'   then jsonb_build_object('id', rec.id, 'factor', rec.weight)
      when 'value'    then jsonb_build_object('id', rec.id, 'factor', rec.value)
      when 'quantity' then jsonb_build_object('id', rec.id, 'factor', rec.qty)
      when 'volume'   then jsonb_build_object('id', rec.id, 'factor', rec.volume)
      else (select e from jsonb_array_elements(p_targets) e where (e->>'id')::uuid = rec.id)
    end;
  end loop;
  n_targets := jsonb_array_length(t);
  if p_targets is not null and jsonb_array_length(p_targets) > 0 and n_targets <> jsonb_array_length(p_targets) then
    raise exception 'Some allocation targets do not belong to this cost source''s document' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(t) e where p_basis in ('weight','value','quantity','volume') and e->'factor' = 'null'::jsonb) then
    raise exception 'Every target needs a % figure before allocating by %', p_basis, p_basis using errcode = 'P0001';
  end if;

  update public.cost_allocation_runs set is_current = false
    where cost_source_id = p_source and amount_kind = p_amount_kind and is_current;
  insert into public.cost_allocation_runs(company_id, cost_source_id, amount_kind, basis, total_amount, created_by)
    values (s.company_id, p_source, p_amount_kind, p_basis, p_amount, p_user) returning id into v_run;
  insert into public.cost_allocations(company_id, run_id, target_type, target_id, factor, amount)
    select s.company_id, v_run, ttype, a.target_id,
           (select (e->>'factor')::numeric from jsonb_array_elements(t) e where (e->>'id')::uuid = a.target_id),
           a.amount
    from public.allocate_amount(p_amount, p_basis, t) a;

  select sum(amount) into total from public.cost_allocations where run_id = v_run;
  if total is distinct from p_amount then
    raise exception 'Allocation does not conserve the total (% vs %)', total, p_amount using errcode = 'P0001';
  end if;
  return v_run;
end; $$;

-- ===========================================================================
-- L. Document attachments (metadata) and generated-document versions.
-- Files live in the private Storage bucket "documents" at
-- <company>/<owner_type>/<owner_id>/<uuid>; the user's file name is never
-- part of the path. Rows are insert-only: a replacement is a new version that
-- supersedes the old one (which stays readable for audit).
-- ===========================================================================
create table if not exists public.document_attachments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete restrict,
  owner_type        text not null check (owner_type in (
                      'import_shipment','import_receipt','cost_invoice','purchase',
                      'stock_transfer','stock_transfer_receipt','rebag_order')),
  owner_id          uuid not null,
  category          text not null check (category in (
                      'bill_of_lading','packing_list','customs_entry','supplier_invoice','cost_invoice',
                      'delivery_note','proof_of_delivery','photo','other')),
  storage_bucket    text not null default 'documents' check (storage_bucket = 'documents'),
  storage_path      text not null unique,
  original_filename text not null,
  download_name     text not null check (download_name ~ '^[A-Za-z0-9._ -]{1,120}$'),
  content_type      text not null check (content_type in ('application/pdf','image/jpeg','image/png','image/webp')),
  size_bytes        bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  version           integer not null default 1 check (version >= 1),
  supersedes_id     uuid references public.document_attachments(id) on delete restrict,
  uploaded_by       uuid not null references auth.users(id) on delete restrict,
  uploaded_at       timestamptz not null default now(),
  check ((version = 1) = (supersedes_id is null))
);
create index if not exists document_attachments_owner_idx on public.document_attachments(owner_type, owner_id);
create unique index if not exists document_attachments_supersedes on public.document_attachments(supersedes_id) where supersedes_id is not null;
drop trigger if exists trg_document_attachments_immutable on public.document_attachments;
create trigger trg_document_attachments_immutable before update or delete on public.document_attachments
  for each row execute function public.block_update_delete();

create table if not exists public.document_versions (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete restrict,
  owner_type     text not null check (owner_type in ('import_receipt','stock_transfer','stock_transfer_receipt','rebag_order')),
  owner_id       uuid not null,
  kind           text not null check (kind in ('delivery_note','goods_received_note','rebag_sheet')),
  version        integer not null check (version >= 1),
  snapshot       jsonb not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  unique (owner_type, owner_id, kind, version)
);
drop trigger if exists trg_document_versions_immutable on public.document_versions;
create trigger trg_document_versions_immutable before update or delete on public.document_versions
  for each row execute function public.block_update_delete();

-- Owner record resolution: company, branches allowed to see it, permission
-- needed. Raises when the owner does not exist.
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
  elsif p_owner_type = 'rebag_order' then
    select o.company_id, array[o.branch_id], 'rebagging.view' into company_id, branch_ids, view_permission
      from public.rebag_orders o where o.id = p_owner_id;
  end if;
  if company_id is null then
    raise exception 'Document owner not found' using errcode = 'P0001';
  end if;
end; $$;

create or replace function public.can_access_document_owner(p_user uuid, p_owner_type text, p_owner_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare o record;
begin
  select * into o from public._document_owner(p_owner_type, p_owner_id);
  if not exists (select 1 from public.user_profiles where id = p_user and is_active) then return false; end if;
  if not public._user_has_company(p_user, o.company_id) then return false; end if;
  if not public._user_can(p_user, o.view_permission) then return false; end if;
  if o.branch_ids is not null and not exists (
       select 1 from unnest(o.branch_ids) b where public._user_has_branch(p_user, b)) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end; $$;

create or replace function public.register_attachment(
  p_user uuid, p_owner_type text, p_owner_id uuid, p_category text, p_storage_path text,
  p_original_filename text, p_download_name text, p_content_type text, p_size bigint, p_sha256 text,
  p_supersedes uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare o record; prev public.document_attachments; ver int := 1; new_id uuid;
begin
  select * into o from public._document_owner(p_owner_type, p_owner_id);
  perform public.assert_feature(o.company_id, 'attachments');
  perform public.assert_actor(p_user, o.company_id, 'documents.upload');
  if not public.can_access_document_owner(p_user, p_owner_type, p_owner_id) then
    raise exception 'Not authorised for this document' using errcode = '42501';
  end if;
  if p_category in ('supplier_invoice','cost_invoice') and not public._user_can(p_user, 'documents.view_financial') then
    raise exception 'Not authorised for financial documents' using errcode = '42501';
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

-- Private bucket on Supabase (skipped where the storage schema does not exist,
-- e.g. the PGlite test database). No storage.objects policies are created, so
-- anon / authenticated clients cannot read or write objects directly; the
-- server uses the service role after the checks above and issues short-lived
-- signed URLs.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    execute $q$
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('documents', 'documents', false, 10485760,
              array['application/pdf','image/jpeg','image/png','image/webp'])
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types
    $q$;
  end if;
end $$;

-- ===========================================================================
-- M. RLS (read by company access; no client writes), grants, lock-down.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'account_mappings','feature_flags','supplier_invoice_registry','import_shipments','import_shipment_lines',
    'cost_invoices','cost_invoice_lines','cost_sources','cost_source_actuals','import_receipts','import_receipt_lines',
    'rebag_orders','rebag_outputs','rebag_inputs','stock_lots','stock_lot_balances','stock_lot_flows',
    'drivers','vehicles','stock_transfer_receipts','stock_transfer_receipt_lines',
    'cost_allocation_runs','cost_allocations','document_attachments','document_versions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_company_access(company_id))', t || '_select', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Every function defined by this migration is server-only.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             '_user_is_owner','_user_can','_user_has_company','_user_has_branch','assert_actor','claim_operation',
             'account_mappings_validate','account_for','feature_enabled','assert_feature','ensure_company_defaults',
             '_ensure_company_defaults_0024','post_balanced_journal','lock_stock_balances','allocate_amount',
             'block_update_delete','register_supplier_invoice','purchases_register_invoice','purchases_guard_import',
             'purchase_lines_guard_import','cost_invoices_guard','cost_sources_guard','import_receipt_lines_guard',
             'products_validate_pack_unit','rebag_orders_guard','rebag_lines_guard','stock_transfer_lines_company',
             'cost_allocation_runs_guard','allocate_cost_source','_document_owner','can_access_document_owner',
             'register_attachment') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- Apply this stage's defaults to every existing company.
do $$
declare c record;
begin
  for c in select id from public.companies loop
    perform public.ensure_company_defaults(c.id);
  end loop;
end $$;
