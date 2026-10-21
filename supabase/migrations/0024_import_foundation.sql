-- ============================================================================
-- Letiq ERP - Migration 0024: Import / rebagging / transfer upgrade - Stage 0
-- foundation. Additive and idempotent; safe on upgraded and clean databases.
-- ----------------------------------------------------------------------------
--  1. public.ensure_company_defaults(company): one idempotent place that gives
--     a company every system account, document sequence and default master
--     record the posting functions rely on. Earlier migrations only added
--     these to companies that existed when they ran, so clean installs were
--     missing them (opening stock / purchases / openings failed).
--  2. New system accounts for imports, accruals, goods in transit, FX and
--     storage (codes 1155, 1157, 2130, 2140, 4400, 4410, 6150, 6400, 6410).
--  3. cost_categories: approved rules for which acquisition / conversion /
--     transfer costs are capitalised into inventory and which are expensed.
--  4. currencies + exchange_rates (TZS functional; foreign currency is for
--     import-origin supplier documents only - enforced by later stages).
--  5. kg base weight: units.kg_factor, products.stock_role / net_weight_kg /
--     bulk_product_id, with server-side validation.
-- Existing stock, journals and balances are not touched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- TZS is the functional and reporting currency.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.companies where base_currency <> 'TZS') then
    raise exception 'Upgrade requires every company to use TZS as base currency';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'companies_base_currency_tzs') then
    alter table public.companies add constraint companies_base_currency_tzs check (base_currency = 'TZS');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Units: kg conversion factor for weight units only (KG = 1, MT = 1000).
-- Other units (PCS, LTR, BAG, CTN...) keep kg_factor NULL.
-- ---------------------------------------------------------------------------
alter table public.units add column if not exists kg_factor numeric(18,6);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'units_kg_factor_positive') then
    alter table public.units add constraint units_kg_factor_positive check (kg_factor is null or kg_factor > 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Products: stock role and net weight.
--   standard           - unchanged behaviour (default for every existing row)
--   bulk               - stocked in kg (base unit must have kg_factor = 1)
--   packaged           - a bag SKU: fixed net kg per unit, made from a bulk SKU
--   packaging_material - empty bags, labels, thread... consumed by rebagging
-- ---------------------------------------------------------------------------
alter table public.products add column if not exists stock_role text not null default 'standard';
alter table public.products add column if not exists net_weight_kg numeric(18,4);
alter table public.products add column if not exists bulk_product_id uuid references public.products(id) on delete restrict;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_stock_role_check') then
    alter table public.products add constraint products_stock_role_check
      check (stock_role in ('standard','bulk','packaged','packaging_material'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_net_weight_positive') then
    alter table public.products add constraint products_net_weight_positive
      check (net_weight_kg is null or net_weight_kg > 0);
  end if;
end $$;
create index if not exists products_bulk_product_idx on public.products(bulk_product_id);

create or replace function public.products_validate_stock_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  unit_factor numeric;
  bulk public.products;
begin
  if NEW.stock_role = 'bulk' then
    select kg_factor into unit_factor from public.units where id = NEW.base_unit_id;
    if unit_factor is distinct from 1 then
      raise exception 'A bulk product must use a kilogram base unit (kg factor 1)' using errcode = '23514';
    end if;
    if NEW.bulk_product_id is not null then
      raise exception 'A bulk product cannot reference another bulk product' using errcode = '23514';
    end if;
    if not NEW.track_inventory then
      raise exception 'A bulk product must track inventory' using errcode = '23514';
    end if;
    NEW.net_weight_kg := 1;
  elsif NEW.stock_role = 'packaged' then
    if NEW.net_weight_kg is null then
      raise exception 'A packaged product needs its net kg per unit' using errcode = '23514';
    end if;
    if NEW.bulk_product_id is null then
      raise exception 'A packaged product must name the bulk product it is filled from' using errcode = '23514';
    end if;
    select * into bulk from public.products where id = NEW.bulk_product_id;
    if not found or bulk.company_id <> NEW.company_id or bulk.stock_role <> 'bulk' then
      raise exception 'The source product must be a bulk product in the same company' using errcode = '23514';
    end if;
    if not NEW.track_inventory then
      raise exception 'A packaged product must track inventory' using errcode = '23514';
    end if;
  elsif NEW.stock_role = 'packaging_material' then
    if NEW.bulk_product_id is not null then
      raise exception 'Packaging material cannot reference a bulk product' using errcode = '23514';
    end if;
    if not NEW.track_inventory then
      raise exception 'Packaging material must track inventory' using errcode = '23514';
    end if;
  else -- standard
    if NEW.bulk_product_id is not null then
      raise exception 'Only packaged products reference a bulk product' using errcode = '23514';
    end if;
  end if;

  -- Weight definition is frozen once stock has moved, so historic bag counts
  -- and kg totals keep meaning the same thing.
  if TG_OP = 'UPDATE'
     and (NEW.stock_role is distinct from OLD.stock_role
          or NEW.net_weight_kg is distinct from OLD.net_weight_kg
          or NEW.bulk_product_id is distinct from OLD.bulk_product_id
          or (NEW.stock_role in ('bulk','packaged') and NEW.base_unit_id is distinct from OLD.base_unit_id))
     and exists (select 1 from public.stock_movements where product_id = NEW.id) then
    raise exception 'Stock role, unit and net weight cannot change after the product has stock movements'
      using errcode = '23514';
  end if;
  return NEW;
end; $$;

drop trigger if exists trg_products_stock_role on public.products;
create trigger trg_products_stock_role before insert or update on public.products
  for each row execute function public.products_validate_stock_role();

-- ---------------------------------------------------------------------------
-- Currencies (global) and exchange rates (per company, TZS per 1 unit).
-- Documents that use a rate snapshot it, so editing a rate never changes a
-- posted document.
-- ---------------------------------------------------------------------------
create table if not exists public.currencies (
  code          text primary key check (code ~ '^[A-Z]{3}$'),
  name          text not null,
  minor_units   smallint not null default 2 check (minor_units between 0 and 4),
  is_functional boolean not null default false,
  is_active     boolean not null default true
);
create unique index if not exists currencies_one_functional on public.currencies(is_functional) where is_functional;

insert into public.currencies(code, name, minor_units, is_functional) values
  ('TZS','Tanzanian Shilling',2,true),
  ('USD','US Dollar',2,false),
  ('EUR','Euro',2,false),
  ('GBP','Pound Sterling',2,false),
  ('CNY','Chinese Yuan',2,false),
  ('INR','Indian Rupee',2,false),
  ('AED','UAE Dirham',2,false),
  ('KES','Kenyan Shilling',2,false),
  ('ZAR','South African Rand',2,false)
on conflict (code) do nothing;

create table if not exists public.exchange_rates (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete restrict,
  currency_code text not null references public.currencies(code) on delete restrict
                  check (currency_code <> 'TZS'),
  rate_date     date not null,
  rate          numeric(18,6) not null check (rate > 0),
  source        text,
  notes         text,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id) on delete set null,
  unique (company_id, currency_code, rate_date)
);
create index if not exists exchange_rates_lookup_idx
  on public.exchange_rates(company_id, currency_code, rate_date desc);
comment on column public.exchange_rates.rate is 'TZS per 1 unit of currency_code';

drop trigger if exists trg_exchange_rates_updated on public.exchange_rates;
create trigger trg_exchange_rates_updated before update on public.exchange_rates
  for each row execute function public.set_updated_at();

-- Latest rate on or before a date. Raises if none, so callers never post with
-- a silent default rate.
create or replace function public.exchange_rate_on(p_company uuid, p_currency text, p_date date)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare r numeric(18,6);
begin
  if p_currency = 'TZS' then return 1; end if;
  select rate into r from public.exchange_rates
    where company_id = p_company and currency_code = p_currency and rate_date <= p_date
    order by rate_date desc limit 1;
  if r is null then
    raise exception 'No % exchange rate on or before %', p_currency, to_char(p_date, 'DD/MM/YYYY')
      using errcode = 'P0001';
  end if;
  return r;
end; $$;

-- ---------------------------------------------------------------------------
-- Cost categories: approved capitalise / expense rules.
--   inventory_treatment = 'capitalize' -> part of inventory accounting cost
--   inventory_treatment = 'expense'    -> posted to expense_account_id
--   include_in_commercial_cost         -> shown in the pricing (commercial)
--                                         cost view; never a second posting
--   default_tax_code_id                -> suggestion only; documents carry
--                                         their own tax code (no 18% assumed)
-- ---------------------------------------------------------------------------
create table if not exists public.cost_categories (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references public.companies(id) on delete restrict,
  code                       text not null,
  name                       text not null,
  description                text,
  inventory_treatment        text not null check (inventory_treatment in ('capitalize','expense')),
  expense_account_id         uuid references public.chart_of_accounts(id) on delete restrict,
  include_in_commercial_cost boolean not null default true,
  default_tax_code_id        uuid references public.tax_codes(id) on delete set null,
  allocation_basis           text not null default 'net_weight'
                               check (allocation_basis in ('net_weight','value','quantity','manual')),
  applies_to_import          boolean not null default false,
  applies_to_transfer        boolean not null default false,
  applies_to_rebagging       boolean not null default false,
  is_goods_value             boolean not null default false,
  is_system                  boolean not null default false,
  is_active                  boolean not null default true,
  created_at                 timestamptz not null default now(),
  created_by                 uuid references auth.users(id) on delete set null,
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references auth.users(id) on delete set null,
  unique (company_id, code),
  check (inventory_treatment = 'capitalize' or expense_account_id is not null),
  check (not is_goods_value or inventory_treatment = 'capitalize')
);
create index if not exists cost_categories_company_idx on public.cost_categories(company_id);

drop trigger if exists trg_cost_categories_company on public.cost_categories;
create trigger trg_cost_categories_company before insert or update on public.cost_categories
  for each row execute function public.check_company_consistency(
    'expense_account_id', 'chart_of_accounts',
    'default_tax_code_id', 'tax_codes');

drop trigger if exists trg_cost_categories_updated on public.cost_categories;
create trigger trg_cost_categories_updated before update on public.cost_categories
  for each row execute function public.set_updated_at();

create or replace function public.cost_categories_validate()
returns trigger language plpgsql security definer set search_path = public as $$
declare acc public.chart_of_accounts;
begin
  if NEW.expense_account_id is not null then
    select * into acc from public.chart_of_accounts where id = NEW.expense_account_id;
    if not acc.allow_posting or acc.account_type not in ('expense','cost_of_sales') then
      raise exception 'Cost category expense account must be a posting expense or cost-of-sales account'
        using errcode = '23514';
    end if;
  end if;
  if not (NEW.applies_to_import or NEW.applies_to_transfer or NEW.applies_to_rebagging) then
    raise exception 'A cost category must apply to at least one of import, transfer or rebagging'
      using errcode = '23514';
  end if;
  return NEW;
end; $$;

drop trigger if exists trg_cost_categories_validate on public.cost_categories;
create trigger trg_cost_categories_validate before insert or update on public.cost_categories
  for each row execute function public.cost_categories_validate();

-- ---------------------------------------------------------------------------
-- System account helper: create if missing; refuse to reuse a code that a
-- different kind of account already occupies (never mis-post silently).
-- ---------------------------------------------------------------------------
create or replace function public._ensure_system_account(
  p_company uuid, p_code text, p_name text, p_type text, p_parent_code text,
  p_normal text, p_control boolean default false, p_cashflow text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare existing public.chart_of_accounts; parent uuid; new_id uuid;
begin
  select * into existing from public.chart_of_accounts where company_id = p_company and code = p_code;
  if found then
    if existing.account_type <> p_type then
      raise exception 'Account code % is already used by a % account (%); system account "%" needs a % account',
        p_code, existing.account_type, existing.name, p_name, p_type using errcode = '23514';
    end if;
    if p_control and not existing.is_control then
      update public.chart_of_accounts set is_control = true where id = existing.id;
    end if;
    return existing.id;
  end if;
  select id into parent from public.chart_of_accounts where company_id = p_company and code = p_parent_code;
  insert into public.chart_of_accounts(company_id, code, name, account_type, parent_id, normal_balance,
      allow_posting, is_system, is_active, is_control, cashflow_class)
    values (p_company, p_code, p_name, p_type, parent, p_normal, true, true, true, p_control,
      coalesce(p_cashflow, case when p_type in ('revenue','cost_of_sales','expense') then 'operating' else 'unclassified' end))
    returning id into new_id;
  return new_id;
end; $$;

create or replace function public._ensure_doc_sequence(p_company uuid, p_type text, p_prefix text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.document_sequences
                  where company_id = p_company and document_type = p_type and branch_id is null) then
    insert into public.document_sequences(company_id, document_type, prefix, current_number, number_length, reset_frequency)
      values (p_company, p_type, p_prefix, 0, 5, 'never');
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- ensure_company_defaults: everything a company needs beyond the base seed.
-- Idempotent; call after the base chart of accounts exists (scripts/seed.ts
-- does). Later stages extend this function instead of adding one-off loops.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_company_defaults(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.companies where id = p_company) then
    raise exception 'Company % not found', p_company using errcode = 'P0001';
  end if;

  -- Accounts from 0007 (Phase 2).
  perform public._ensure_system_account(p_company, '3200', 'Opening Balance Equity', 'equity', '3000', 'credit', false, 'excluded_transfer');
  perform public._ensure_system_account(p_company, '4300', 'Inventory Adjustment Gain', 'revenue', '4000', 'credit');
  perform public._ensure_system_account(p_company, '4900', 'Sales Returns', 'revenue', '4000', 'debit');
  perform public._ensure_system_account(p_company, '6300', 'Inventory Shrinkage / Loss', 'expense', '6000', 'debit');
  -- Accounts from 0013 (Phase 3).
  perform public._ensure_system_account(p_company, '1170', 'Supplier Credits', 'asset', '1100', 'debit');
  perform public._ensure_system_account(p_company, '5200', 'Purchase Returns', 'cost_of_sales', '5000', 'credit');
  perform public._ensure_system_account(p_company, '5300', 'Purchase Price Variance', 'cost_of_sales', '5000', 'debit');
  perform public._ensure_system_account(p_company, '1121', 'NMB Bank', 'asset', '1120', 'debit', true);
  perform public._ensure_system_account(p_company, '1122', 'CRDB Bank', 'asset', '1120', 'debit', true);
  perform public._ensure_system_account(p_company, '1131', 'M-Pesa', 'asset', '1130', 'debit', true);
  perform public._ensure_system_account(p_company, '1132', 'MIX', 'asset', '1130', 'debit', true);

  -- New accounts (this upgrade).
  perform public._ensure_system_account(p_company, '1155', 'Goods in Transit (Branch Transfers)', 'asset', '1100', 'debit', true);
  perform public._ensure_system_account(p_company, '1157', 'Import Goods in Transit', 'asset', '1100', 'debit', true);
  perform public._ensure_system_account(p_company, '2130', 'Goods Received Not Invoiced', 'liability', '2100', 'credit', true);
  perform public._ensure_system_account(p_company, '2140', 'Accrued Import and Landed Costs', 'liability', '2100', 'credit', true);
  perform public._ensure_system_account(p_company, '4400', 'Realised Foreign Exchange Gain', 'revenue', '4000', 'credit');
  perform public._ensure_system_account(p_company, '4410', 'Unrealised Foreign Exchange Gain', 'revenue', '4000', 'credit');
  perform public._ensure_system_account(p_company, '6150', 'Storage and Warehousing', 'expense', '6000', 'debit');
  perform public._ensure_system_account(p_company, '6400', 'Realised Foreign Exchange Loss', 'expense', '6000', 'debit');
  perform public._ensure_system_account(p_company, '6410', 'Unrealised Foreign Exchange Loss', 'expense', '6000', 'debit');

  -- Control accounts owned by subledgers (0019 list).
  update public.chart_of_accounts set is_control = true
    where company_id = p_company and not is_control
      and code in ('1110','1120','1121','1122','1130','1131','1132','1140','1150','1160','2110','2120');
  update public.chart_of_accounts set cashflow_class = 'operating'
    where company_id = p_company and cashflow_class = 'unclassified'
      and account_type in ('revenue','cost_of_sales','expense');

  -- Seeded payment accounts get their own ledger, but only while they still
  -- point at the generic header account (never override a user's choice).
  update public.payment_accounts pa set ledger_account_id = c.id
    from public.chart_of_accounts c, public.chart_of_accounts cur
    where pa.company_id = p_company and c.company_id = p_company and cur.id = pa.ledger_account_id
      and cur.code in ('1120','1130')
      and ((pa.code = 'NMB' and c.code = '1121') or (pa.code = 'CRDB' and c.code = '1122')
        or (pa.code = 'MPESA' and c.code = '1131') or (pa.code = 'MIX' and c.code = '1132'));

  -- Document sequences used by posting functions.
  perform public._ensure_doc_sequence(p_company, 'sales_invoice', 'INV');
  perform public._ensure_doc_sequence(p_company, 'sales_receipt', 'RCP');
  perform public._ensure_doc_sequence(p_company, 'sales_return', 'SRN');
  perform public._ensure_doc_sequence(p_company, 'purchase', 'PUR');
  perform public._ensure_doc_sequence(p_company, 'purchase_return', 'PRN');
  perform public._ensure_doc_sequence(p_company, 'expense', 'EXP');
  perform public._ensure_doc_sequence(p_company, 'other_income', 'OIN');
  perform public._ensure_doc_sequence(p_company, 'cash_transfer', 'CTR');
  perform public._ensure_doc_sequence(p_company, 'stock_transfer', 'STR');
  perform public._ensure_doc_sequence(p_company, 'stock_adjustment', 'ADJ');
  perform public._ensure_doc_sequence(p_company, 'journal_entry', 'JRN');
  perform public._ensure_doc_sequence(p_company, 'inventory_opening', 'OPB');
  perform public._ensure_doc_sequence(p_company, 'supplier_payment', 'SPY');
  perform public._ensure_doc_sequence(p_company, 'financial_opening_balance', 'FOB');

  -- Weight units.
  insert into public.units(company_id, code, name, symbol, allow_decimal, kg_factor)
    values (p_company, 'KG', 'Kilogram', 'kg', true, 1)
    on conflict (company_id, code) do nothing;
  update public.units set kg_factor = 1 where company_id = p_company and code = 'KG' and kg_factor is null;
  insert into public.units(company_id, code, name, symbol, allow_decimal, kg_factor)
    values (p_company, 'MT', 'Metric Tonne', 't', true, 1000)
    on conflict (company_id, code) do nothing;

  -- Default cost categories (editable under Admin > Cost Categories).
  insert into public.cost_categories(company_id, code, name, description, inventory_treatment, expense_account_id,
      include_in_commercial_cost, allocation_basis, applies_to_import, applies_to_transfer, applies_to_rebagging,
      is_goods_value, is_system)
  select p_company, v.code, v.name, v.descr, v.treat,
         case when v.acc is null then null else public.account_id_by_code(p_company, v.acc) end,
         v.commercial, v.basis, v.imp, v.trf, v.rbg, v.goods, true
  from (values
    ('GOODS',      'Goods value (invoice / CIF)',            'Supplier goods value. Record whether it already includes freight and insurance on the shipment.', 'capitalize', null::text, true, 'value',      true,  false, false, true),
    ('FREIGHT',    'International freight',                   'Only when not already included in the goods value (e.g. FOB).',  'capitalize', null, true, 'net_weight', true,  false, false, false),
    ('INSURANCE',  'Cargo insurance',                         'Only when not already included in the goods value.',              'capitalize', null, true, 'value',      true,  false, false, false),
    ('DUTY',       'Customs duty (non-recoverable)',          'Recoverable import VAT is NOT a cost; record it through the tax code.', 'capitalize', null, true, 'value', true, false, false, false),
    ('LEVY',       'Import levies and statutory fees',        'Non-recoverable levies and fees on importation.',                 'capitalize', null, true, 'value',      true,  false, false, false),
    ('PORT',       'Port and terminal handling',              null,                                                              'capitalize', null, true, 'net_weight', true,  false, false, false),
    ('CLEARING',   'Clearing and forwarding / agency',        null,                                                              'capitalize', null, true, 'net_weight', true,  false, false, false),
    ('INSPECTION', 'Inspection and certification',            null,                                                              'capitalize', null, true, 'net_weight', true,  false, false, false),
    ('INLAND',     'Inland transport to warehouse',           null,                                                              'capitalize', null, true, 'net_weight', true,  true,  false, false),
    ('LOADING',    'Loading and offloading',                  null,                                                              'capitalize', null, true, 'net_weight', true,  true,  true,  false),
    ('TRANSPORT',  'Branch transfer transport',               'Transport between own branches, capitalised to the receiving stock.', 'capitalize', null, true, 'net_weight', false, true, false, false),
    ('REBAG_LAB',  'Rebagging labour',                        null,                                                              'capitalize', null, true, 'quantity',   false, false, true,  false),
    ('STORAGE',    'Storage rent (expensed)',                 'Ordinary storage is an expense; included in the commercial (pricing) view only.', 'expense', '6150', true, 'net_weight', true, true, true, false),
    ('DEMURRAGE',  'Demurrage and detention (expensed)',      'Abnormal delay cost; expensed, not capitalised.',                 'expense',    '6100', true, 'net_weight', true,  false, false, false),
    ('BANK_CHG',   'Bank and transfer charges (expensed)',    null,                                                              'expense',    '6200', false, 'manual',    true,  true,  false, false)
  ) as v(code, name, descr, treat, acc, commercial, basis, imp, trf, rbg, goods)
  on conflict (company_id, code) do nothing;
end; $$;

-- Apply to every existing company (production upgrade path).
do $$
declare c record;
begin
  for c in select id from public.companies loop
    perform public.ensure_company_defaults(c.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security (same model as 0005: read by company access, write Owner).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['cost_categories','exchange_rates'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_company_access(company_id))', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_owner())', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_owner()) with check (public.is_owner())', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_owner())', t || '_delete', t);
  end loop;
end $$;

alter table public.currencies enable row level security;
alter table public.currencies force row level security;
drop policy if exists currencies_select on public.currencies;
create policy currencies_select on public.currencies for select to authenticated using (true);
drop policy if exists currencies_write on public.currencies;
create policy currencies_write on public.currencies for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- ---------------------------------------------------------------------------
-- Grants (0023 default privileges cover new tables; restate explicitly) and
-- keep the setup / helper functions server-only.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.cost_categories, public.exchange_rates, public.currencies
  to anon, authenticated, service_role;

revoke all on function public.ensure_company_defaults(uuid) from public, anon, authenticated;
revoke all on function public._ensure_system_account(uuid,text,text,text,text,text,boolean,text) from public, anon, authenticated;
revoke all on function public._ensure_doc_sequence(uuid,text,text) from public, anon, authenticated;
revoke all on function public.exchange_rate_on(uuid,text,date) from public, anon, authenticated;
revoke all on function public.products_validate_stock_role() from public, anon, authenticated;
revoke all on function public.cost_categories_validate() from public, anon, authenticated;
grant execute on function public.ensure_company_defaults(uuid) to service_role;
grant execute on function public._ensure_system_account(uuid,text,text,text,text,text,boolean,text) to service_role;
grant execute on function public._ensure_doc_sequence(uuid,text,text) to service_role;
grant execute on function public.exchange_rate_on(uuid,text,date) to service_role;
