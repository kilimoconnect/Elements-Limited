-- ============================================================================
-- Letiq ERP - Migration 0026: Import upgrade Stage 3 - foreign-currency
-- purchases with TZS books.
-- ----------------------------------------------------------------------------
-- Extends the existing purchases, supplier payables, supplier payments,
-- supplier credits and purchase returns (no parallel foreign ledger):
--   * purchase invoices in a configured currency with rate (TZS per 1 unit),
--     rate source / reference, original amounts and immutable posted TZS;
--   * foreign supplier balances keep original-currency outstanding and a TZS
--     carrying amount, maintained through an append-only event log;
--   * settlements through existing TZS bank / cash accounts recording the
--     foreign amount settled and the actual TZS paid; difference to FX
--     gain/loss; bank charges separately; advances (non-monetary) applied at
--     their historical TZS on invoice posting;
--   * period-end revaluation at an authorised closing rate that updates the
--     carrying amount (later settlements measure realised FX from it);
--   * supplier credits / returns in original currency and TZS;
--   * foreign currency confined to purchase-origin documents.
-- All foreign-currency entry points require the fx_settlement feature flag
-- and dedicated permissions. TZS purchases keep their existing behaviour.
-- ============================================================================

-- ===========================================================================
-- 1. Schema
-- ===========================================================================

-- Purchases: rate provenance + advance application totals.
alter table public.purchases add column if not exists rate_source text;
alter table public.purchases add column if not exists rate_reference text;
alter table public.purchases add column if not exists advance_applied_fc numeric(18,2) not null default 0;
alter table public.purchases add column if not exists advance_applied_tzs numeric(18,2) not null default 0;
alter table public.purchases add column if not exists advance_applied_at_rate numeric(18,2) not null default 0;
do $$
begin
  -- Stage 2 limited foreign currency to import goods invoices; purchase-origin
  -- foreign invoices are now allowed (still never sales/expenses/transfers).
  if exists (select 1 from pg_constraint where conname = 'purchases_fc_import_only') then
    alter table public.purchases drop constraint purchases_fc_import_only;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchases_rate_source_check') then
    alter table public.purchases add constraint purchases_rate_source_check
      check (rate_source is null or rate_source in ('manual','rate_table'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchases_advance_nonnegative') then
    alter table public.purchases add constraint purchases_advance_nonnegative
      check (advance_applied_fc >= 0 and advance_applied_tzs >= 0 and advance_applied_at_rate >= 0);
  end if;
end $$;

alter table public.purchase_lines add column if not exists fc_discount numeric(18,2);
alter table public.purchase_lines add column if not exists fc_net_amount numeric(18,2);
alter table public.purchase_lines add column if not exists fc_tax_amount numeric(18,2);
alter table public.purchase_lines add column if not exists fc_gross_amount numeric(18,2);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_lines_fc_amounts_nonnegative') then
    alter table public.purchase_lines add constraint purchase_lines_fc_amounts_nonnegative check (
      coalesce(fc_discount,0) >= 0 and coalesce(fc_net_amount,0) >= 0
      and coalesce(fc_tax_amount,0) >= 0 and coalesce(fc_gross_amount,0) >= 0);
  end if;
end $$;

-- Foreign payables come only from purchases.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_payables_fc_purchase_only') then
    alter table public.supplier_payables add constraint supplier_payables_fc_purchase_only
      check (currency_code = 'TZS' or source_type = 'purchase');
  end if;
end $$;

-- Cost invoices (import service charges) stay TZS: foreign import-origin
-- charges must go through the purchase invoice path.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cost_invoices_tzs_only') then
    alter table public.cost_invoices add constraint cost_invoices_tzs_only check (currency_code = 'TZS' and exchange_rate = 1);
  end if;
end $$;

-- Supplier advances (prepayments): non-monetary, carried at the TZS paid,
-- never revalued.
create table if not exists public.supplier_advances (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete restrict,
  branch_id      uuid not null references public.branches(id) on delete restrict,
  supplier_id    uuid not null references public.suppliers(id) on delete restrict,
  payment_id     uuid not null unique references public.supplier_payments(id) on delete restrict,
  currency_code  text not null references public.currencies(code),
  advance_date   date not null,
  fc_amount      numeric(18,2) not null check (fc_amount > 0),
  tzs_amount     numeric(18,2) not null check (tzs_amount > 0),
  fc_remaining   numeric(18,2) not null check (fc_remaining >= 0),
  tzs_remaining  numeric(18,2) not null check (tzs_remaining >= 0),
  status         text not null default 'open' check (status in ('open','applied','voided')),
  created_at     timestamptz not null default now(),
  check (fc_remaining <= fc_amount and tzs_remaining <= tzs_amount),
  check (currency_code <> 'TZS' or fc_amount = tzs_amount)
);
create index if not exists supplier_advances_supplier_idx on public.supplier_advances(supplier_id, currency_code, status);
drop trigger if exists trg_supplier_advances_company on public.supplier_advances;
create trigger trg_supplier_advances_company before insert or update on public.supplier_advances
  for each row execute function public.check_company_consistency('branch_id','branches','supplier_id','suppliers','payment_id','supplier_payments');

create table if not exists public.purchase_advance_applications (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  advance_id  uuid not null references public.supplier_advances(id) on delete restrict,
  fc_amount   numeric(18,2) not null check (fc_amount > 0),
  tzs_amount  numeric(18,2),           -- historical TZS released, set when posted
  created_at  timestamptz not null default now(),
  unique (purchase_id, advance_id)
);
drop trigger if exists trg_paa_company on public.purchase_advance_applications;
create trigger trg_paa_company before insert or update on public.purchase_advance_applications
  for each row execute function public.check_company_consistency('purchase_id','purchases','advance_id','supplier_advances');

-- Supplier payments: currency, foreign total, advance, FX, bank charges.
alter table public.supplier_payments add column if not exists currency_code text not null default 'TZS' references public.currencies(code);
alter table public.supplier_payments add column if not exists fc_total numeric(18,2) not null default 0;
alter table public.supplier_payments add column if not exists advance_fc_amount numeric(18,2) not null default 0;
alter table public.supplier_payments add column if not exists fx_difference numeric(18,2) not null default 0;
alter table public.supplier_payments add column if not exists bank_charges numeric(18,2) not null default 0;
alter table public.supplier_payments add column if not exists bank_charges_account_id uuid references public.payment_accounts(id) on delete restrict;
-- One payment per form submission: a retried request finds the first one.
alter table public.supplier_payments add column if not exists client_request_id text;
create unique index if not exists supplier_payments_client_request on public.supplier_payments(company_id, client_request_id)
  where client_request_id is not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_payments_fc_amounts') then
    alter table public.supplier_payments add constraint supplier_payments_fc_amounts
      check (fc_total >= 0 and advance_fc_amount >= 0 and bank_charges >= 0
             and (bank_charges = 0 or bank_charges_account_id is not null));
  end if;
end $$;

alter table public.supplier_payment_allocations add column if not exists fc_amount numeric(18,2);
alter table public.supplier_payment_allocations add column if not exists tzs_paid numeric(18,2);
alter table public.supplier_payment_allocations add column if not exists fx_difference numeric(18,2) not null default 0;
do $$
declare c record;
begin
  -- amount (TZS carrying released) is computed at posting for foreign
  -- allocations, so a foreign draft allocation may hold 0 until then.
  for c in select conname from pg_constraint
           where conrelid = 'public.supplier_payment_allocations'::regclass and contype = 'c'
             and conname <> 'spa_amounts_v2' and pg_get_constraintdef(oid) ilike '%amount > %' loop
    execute format('alter table public.supplier_payment_allocations drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'spa_amounts_v2') then
    alter table public.supplier_payment_allocations add constraint spa_amounts_v2
      check (amount >= 0 and (amount > 0 or fc_amount > 0) and (fc_amount is null or fc_amount > 0));
  end if;
end $$;

-- Supplier credits: original currency + TZS carrying.
alter table public.supplier_credits add column if not exists currency_code text not null default 'TZS' references public.currencies(code);
alter table public.supplier_credits add column if not exists fc_amount numeric(18,2);
alter table public.supplier_credits add column if not exists fc_remaining numeric(18,2);
alter table public.supplier_credits add column if not exists credit_date date;
update public.supplier_credits set fc_amount = amount, fc_remaining = remaining where fc_amount is null;
update public.supplier_credits c set credit_date = coalesce(r.document_date, c.created_at::date)
  from public.purchase_returns r where r.id = c.source_return_id and c.credit_date is null;
update public.supplier_credits set credit_date = created_at::date where credit_date is null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_credits_fc_check') then
    alter table public.supplier_credits add constraint supplier_credits_fc_check
      check (fc_amount is not null and fc_remaining is not null and fc_remaining >= 0 and fc_remaining <= fc_amount
             and (currency_code <> 'TZS' or (fc_amount = amount)));
  end if;
end $$;

create table if not exists public.supplier_credit_applications (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete restrict,
  credit_id             uuid not null references public.supplier_credits(id) on delete restrict,
  payable_id            uuid not null references public.supplier_payables(id) on delete restrict,
  application_date      date not null,
  fc_amount             numeric(18,2) not null check (fc_amount > 0),
  credit_tzs_released   numeric(18,2) not null check (credit_tzs_released >= 0),
  payable_tzs_released  numeric(18,2) not null check (payable_tzs_released >= 0),
  fx_difference         numeric(18,2) not null default 0,
  document_number       text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now()
);
create index if not exists sca_payable_idx on public.supplier_credit_applications(payable_id);
drop trigger if exists trg_sca_company on public.supplier_credit_applications;
create trigger trg_sca_company before insert or update on public.supplier_credit_applications
  for each row execute function public.check_company_consistency('credit_id','supplier_credits','payable_id','supplier_payables');
drop trigger if exists trg_sca_immutable on public.supplier_credit_applications;
create trigger trg_sca_immutable before update or delete on public.supplier_credit_applications
  for each row execute function public.block_update_delete();

-- Purchase returns: original currency amounts.
alter table public.purchase_returns add column if not exists currency_code text not null default 'TZS' references public.currencies(code);
alter table public.purchase_returns add column if not exists fc_total numeric(18,2) not null default 0;
alter table public.purchase_returns add column if not exists fx_unrealised_reversal numeric(18,2) not null default 0;
alter table public.purchase_return_lines add column if not exists fc_line_total numeric(18,2);

-- Event log for foreign payables: every change to original-currency
-- outstanding or TZS carrying is one immutable row. Balances "as of" a date
-- and statements are rebuilt from it.
create table if not exists public.supplier_payable_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  payable_id  uuid not null references public.supplier_payables(id) on delete restrict,
  event_type  text not null check (event_type in (
                'invoice','settlement','settlement_void','return','return_void',
                'credit_application','revaluation','revaluation_void','invoice_void')),
  source_type text not null,
  source_id   uuid not null,
  event_date  date not null,
  fc_delta    numeric(18,2) not null,
  tzs_delta   numeric(18,2) not null,
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists spe_payable_idx on public.supplier_payable_events(payable_id, created_at);
drop trigger if exists trg_spe_company on public.supplier_payable_events;
create trigger trg_spe_company before insert on public.supplier_payable_events
  for each row execute function public.check_company_consistency('payable_id','supplier_payables');
drop trigger if exists trg_spe_immutable on public.supplier_payable_events;
create trigger trg_spe_immutable before update or delete on public.supplier_payable_events
  for each row execute function public.block_update_delete();

-- Period-end revaluation.
create table if not exists public.fx_revaluations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  document_number  text,
  revaluation_date date not null,
  status           text not null default 'posted' check (status in ('posted','voided')),
  total_loss       numeric(18,2) not null default 0,
  total_gain       numeric(18,2) not null default 0,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default clock_timestamp(),
  voided_by        uuid references auth.users(id) on delete set null,
  voided_at        timestamptz,
  void_reason      text
);
create unique index if not exists fx_revaluations_one_per_date on public.fx_revaluations(company_id, revaluation_date) where status = 'posted';
create table if not exists public.fx_revaluation_rates (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  revaluation_id  uuid not null references public.fx_revaluations(id) on delete restrict,
  currency_code   text not null references public.currencies(code) check (currency_code <> 'TZS'),
  closing_rate    numeric(18,6) not null check (closing_rate > 0),
  rate_source     text not null check (rate_source in ('manual','rate_table')),
  rate_reference  text,
  unique (revaluation_id, currency_code)
);
create table if not exists public.fx_revaluation_lines (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  revaluation_id  uuid not null references public.fx_revaluations(id) on delete restrict,
  payable_id      uuid references public.supplier_payables(id) on delete restrict,
  credit_id       uuid references public.supplier_credits(id) on delete restrict,
  currency_code   text not null,
  fc_balance      numeric(18,2) not null,
  carrying_before numeric(18,2) not null,
  carrying_after  numeric(18,2) not null,
  difference      numeric(18,2) not null,
  check ((payable_id is not null)::int + (credit_id is not null)::int = 1)
);
do $$
declare t text;
begin
  foreach t in array array['fx_revaluation_rates','fx_revaluation_lines'] loop
    execute format('drop trigger if exists trg_%1$s_immutable on public.%1$s', t);
    execute format('create trigger trg_%1$s_immutable before update or delete on public.%1$s for each row execute function public.block_update_delete()', t);
  end loop;
end $$;
drop trigger if exists trg_fx_revaluation_lines_company on public.fx_revaluation_lines;
create trigger trg_fx_revaluation_lines_company before insert on public.fx_revaluation_lines
  for each row execute function public.check_company_consistency('revaluation_id','fx_revaluations','payable_id','supplier_payables','credit_id','supplier_credits');

-- Posted purchases: currency, rate and TZS / foreign amounts are immutable.
create or replace function public.purchases_freeze_posted()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if OLD.document_status <> 'draft' and (
      NEW.currency_code, NEW.exchange_rate, NEW.rate_source, NEW.rate_reference,
      NEW.subtotal, NEW.discount_total, NEW.net_total, NEW.tax_total, NEW.recoverable_tax, NEW.nonrecoverable_tax,
      NEW.grand_total, NEW.inventory_value, NEW.fc_subtotal, NEW.fc_tax_total, NEW.fc_grand_total,
      NEW.advance_applied_fc, NEW.advance_applied_tzs, NEW.advance_applied_at_rate, NEW.supplier_id, NEW.document_date
    ) is distinct from (
      OLD.currency_code, OLD.exchange_rate, OLD.rate_source, OLD.rate_reference,
      OLD.subtotal, OLD.discount_total, OLD.net_total, OLD.tax_total, OLD.recoverable_tax, OLD.nonrecoverable_tax,
      OLD.grand_total, OLD.inventory_value, OLD.fc_subtotal, OLD.fc_tax_total, OLD.fc_grand_total,
      OLD.advance_applied_fc, OLD.advance_applied_tzs, OLD.advance_applied_at_rate, OLD.supplier_id, OLD.document_date) then
    raise exception 'Posted purchase amounts, currency and rate cannot change' using errcode = 'P0001';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_purchases_freeze_posted on public.purchases;
create trigger trg_purchases_freeze_posted before update on public.purchases
  for each row execute function public.purchases_freeze_posted();

create or replace function public.purchase_children_freeze_posted()
returns trigger language plpgsql security definer set search_path = public as $$
declare st text; cur text;
begin
  select document_status, currency_code into st, cur from public.purchases
    where id = coalesce(NEW.purchase_id, OLD.purchase_id);
  if TG_TABLE_NAME = 'purchase_lines' and TG_OP = 'UPDATE' and st = 'draft' then return NEW; end if;
  if TG_TABLE_NAME = 'purchase_lines' and TG_OP = 'UPDATE' and current_setting('letiq.posting_purchase', true) = 'on' then
    return NEW;
  end if;
  if st <> 'draft' then
    raise exception '% of a posted purchase cannot change', TG_TABLE_NAME using errcode = 'P0001';
  end if;
  if TG_TABLE_NAME = 'purchase_payments' and TG_OP = 'INSERT' and cur <> 'TZS' then
    raise exception 'Foreign-currency purchases are paid through a supplier payment' using errcode = 'P0001';
  end if;
  return coalesce(NEW, OLD);
end; $$;
drop trigger if exists trg_purchase_lines_freeze on public.purchase_lines;
create trigger trg_purchase_lines_freeze before insert or update or delete on public.purchase_lines
  for each row execute function public.purchase_children_freeze_posted();
drop trigger if exists trg_purchase_payments_freeze on public.purchase_payments;
create trigger trg_purchase_payments_freeze before insert or update or delete on public.purchase_payments
  for each row execute function public.purchase_children_freeze_posted();
drop trigger if exists trg_paa_freeze on public.purchase_advance_applications;
create trigger trg_paa_freeze before insert or delete on public.purchase_advance_applications
  for each row execute function public.purchase_children_freeze_posted();

-- ===========================================================================
-- 2. Helpers
-- ===========================================================================
-- A request already processed with this key for this document (retry).
create or replace function public._is_replay(p_key text, p_operation text, p_document uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_key is not null and exists (select 1 from public.idempotency_keys
    where key = p_key and operation = p_operation and result_id is not distinct from p_document);
$$;

create or replace function public._require_key(p_key text)
returns void language plpgsql immutable as $$
begin
  if p_key is null or length(p_key) < 16 then
    raise exception 'An idempotency key of at least 16 characters is required' using errcode = 'P0001';
  end if;
end; $$;

-- Proportional share of a TZS carrying amount for part of a foreign balance;
-- the full remainder when the whole foreign balance is released.
create or replace function public._carry_share(p_carrying numeric, p_fc_part numeric, p_fc_total numeric)
returns numeric language sql immutable as $$
  select case when p_fc_part >= p_fc_total then p_carrying
              when p_fc_total <= 0 then 0
              else round(p_carrying * p_fc_part / p_fc_total, 2) end;
$$;

-- Latest posted revaluation date that touched a payable / credit.
create or replace function public._last_revaluation(p_payable uuid, p_credit uuid)
returns date language sql stable security definer set search_path = public as $$
  select max(r.revaluation_date) from public.fx_revaluation_lines l
    join public.fx_revaluations r on r.id = l.revaluation_id
   where r.status = 'posted' and (l.payable_id = p_payable or l.credit_id = p_credit);
$$;

create or replace function public._payable_event(
  p_payable public.supplier_payables, p_type text, p_source_type text, p_source_id uuid,
  p_date date, p_fc numeric, p_tzs numeric
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_payable.currency_code = 'TZS' then return; end if;
  insert into public.supplier_payable_events(company_id, payable_id, event_type, source_type, source_id, event_date, fc_delta, tzs_delta)
    values (p_payable.company_id, p_payable.id, p_type, p_source_type, p_source_id, p_date, p_fc, p_tzs);
end; $$;

-- Reject reversing a document when the payable has later events.
create or replace function public._assert_no_later_payable_events(p_payable uuid, p_after timestamptz, p_what text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from public.supplier_payable_events where payable_id = p_payable and created_at > p_after) then
    raise exception 'Later transactions exist on this invoice (payments, returns, credits or revaluation); reverse them before voiding this %', p_what
      using errcode = 'P0001';
  end if;
end; $$;

-- Stock receipt at an exact TZS value (no qty x rounded-unit-cost drift), so
-- the stock subledger equals the inventory debit posted.
create or replace function public.record_stock_movement_value(
  p_company uuid, p_branch uuid, p_product uuid, p_movement_type text, p_source_type text,
  p_source_id uuid, p_source_number text, p_qty_in numeric, p_value numeric, p_user uuid
) returns numeric language plpgsql security definer set search_path = public as $$
declare bal public.stock_balances; v numeric(18,2); new_qty numeric(18,4); new_value numeric(18,2); new_avg numeric(18,4);
begin
  if p_qty_in is null or p_qty_in <= 0 then raise exception 'Quantity must be positive' using errcode = 'P0001'; end if;
  if p_value is null or p_value < 0 then raise exception 'Value cannot be negative' using errcode = 'P0001'; end if;
  v := round(p_value, 2);
  select * into bal from public.stock_balances where company_id = p_company and branch_id = p_branch and product_id = p_product for update;
  if not found then
    insert into public.stock_balances(company_id, branch_id, product_id) values (p_company, p_branch, p_product) returning * into bal;
  end if;
  new_qty := bal.quantity + p_qty_in;
  new_value := bal.stock_value + v;
  new_avg := round(new_value / new_qty, 4);
  insert into public.stock_movements(company_id, branch_id, product_id, movement_type, source_type, source_id, source_number,
      qty_in, qty_out, unit_cost, movement_value, balance_qty, avg_cost_after, balance_value, created_by)
    values (p_company, p_branch, p_product, p_movement_type, p_source_type, p_source_id, p_source_number,
      p_qty_in, 0, round(v / p_qty_in, 4), v, new_qty, new_avg, new_value, p_user);
  update public.stock_balances set quantity = new_qty, avg_unit_cost = new_avg, stock_value = new_value,
    last_movement_at = now(), updated_at = now() where id = bal.id;
  return v;
end; $$;

-- ===========================================================================
-- 3. Purchases
-- ===========================================================================
create or replace function public.post_purchase(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v public.purchases; ln record; pay record; app record; adv public.supplier_advances; pb public.supplier_payables;
  docnum text; norm text; is_fc boolean; rate numeric;
  base numeric(18,2); net numeric(18,2); tax numeric(18,2); rec numeric(18,2); nonrec numeric(18,2);
  fc_base numeric(18,2); fc_net numeric(18,2); fc_tax numeric(18,2); cost_val numeric(18,2);
  v_sub numeric(18,2):=0; v_disc numeric(18,2):=0; v_net numeric(18,2):=0; v_tax numeric(18,2):=0;
  v_rec numeric(18,2):=0; v_nonrec numeric(18,2):=0; v_grand numeric(18,2):=0; v_inv numeric(18,2):=0; v_expense numeric(18,2):=0;
  fc_sub numeric(18,2):=0; fc_tax_t numeric(18,2):=0; fc_grand numeric(18,2):=0;
  adv_fc numeric(18,2):=0; adv_tzs numeric(18,2):=0; adv_at_rate numeric(18,2):=0; d numeric(18,2); share record; t jsonb := '[]'::jsonb;
  paid numeric(18,2); outstanding numeric(18,2); fc_out numeric(18,2); jlines jsonb := '[]'::jsonb; mv numeric(18,2);
begin
  select * into v from public.purchases where id=p_id for update;
  if not found then raise exception 'Purchase not found' using errcode='P0001'; end if;
  if public._is_replay(p_idem, 'post_purchase', p_id) then return p_id; end if;
  if v.document_status <> 'draft' then raise exception 'Purchase already %', v.document_status using errcode='P0001'; end if;
  if v.posting_mode = 'invoice_only' then
    raise exception 'Import goods invoices are posted through the import workflow' using errcode='P0001';
  end if;
  is_fc := v.currency_code <> 'TZS';
  rate := v.exchange_rate;
  if is_fc then
    perform public._require_key(p_idem);
    perform public.assert_feature(v.company_id, 'fx_settlement');
    perform public.assert_actor(p_user, v.company_id, 'fx.enter_rate', v.branch_id);
    if rate is null or rate <= 0 then raise exception 'A positive exchange rate is required' using errcode='P0001'; end if;
    if v.rate_source is null then raise exception 'Record the source of the exchange rate' using errcode='P0001'; end if;
    if v.rate_source = 'rate_table' and rate <> public.exchange_rate_on(v.company_id, v.currency_code, v.document_date) then
      raise exception 'The rate does not match the exchange-rate table for %', to_char(v.document_date,'DD/MM/YYYY') using errcode='P0001';
    end if;
    if exists (select 1 from public.purchase_payments where purchase_id=p_id) then
      raise exception 'Foreign-currency purchases are paid through a supplier payment' using errcode='P0001';
    end if;
  end if;
  if not public.claim_idempotency(p_idem, 'post_purchase', p_id) then return p_id; end if;
  perform public.assert_period_open(v.company_id, v.document_date);
  if not exists (select 1 from public.purchase_lines where purchase_id=p_id) then
    raise exception 'Purchase has no lines' using errcode='P0001';
  end if;

  norm := public.norm_invoice(v.supplier_invoice_number);
  if norm is not null and exists (
    select 1 from public.purchases x where x.company_id=v.company_id and x.supplier_id=v.supplier_id
      and x.supplier_invoice_norm = norm and x.document_status='posted' and x.id <> p_id
  ) then
    raise exception 'A posted purchase with this supplier invoice number already exists' using errcode='P0001';
  end if;

  docnum := public.next_document_number(v.company_id, v.branch_id, 'purchase');

  -- Pass 1: amounts (document currency -> TZS), no stock yet.
  for ln in select * from public.purchase_lines where purchase_id=p_id order by line_no, id loop
    if is_fc then
      fc_base := round(ln.quantity * ln.unit_cost - ln.discount, 2);
      if fc_base < 0 then raise exception 'Line discount exceeds line value' using errcode='P0001'; end if;
      if ln.tax_inclusive and ln.tax_rate > 0 then
        fc_net := round(fc_base / (1 + ln.tax_rate/100.0), 2); fc_tax := round(fc_base - fc_net, 2);
      else
        fc_net := fc_base; fc_tax := round(fc_base * ln.tax_rate/100.0, 2);
      end if;
      net := round(fc_net * rate, 2); tax := round(fc_tax * rate, 2);
      fc_sub := fc_sub + round(ln.quantity*ln.unit_cost, 2); fc_tax_t := fc_tax_t + fc_tax;
      fc_grand := fc_grand + fc_net + fc_tax;
      v_sub := v_sub + round(round(ln.quantity*ln.unit_cost, 2) * rate, 2); v_disc := v_disc + round(ln.discount * rate, 2);
    else
      base := round(ln.quantity * ln.unit_cost - ln.discount, 2);
      if base < 0 then raise exception 'Line discount exceeds line value' using errcode='P0001'; end if;
      if ln.tax_inclusive and ln.tax_rate > 0 then
        net := round(base / (1 + ln.tax_rate/100.0), 2); tax := round(base - net, 2);
      else
        net := base; tax := round(base * ln.tax_rate/100.0, 2);
      end if;
      v_sub := v_sub + round(ln.quantity*ln.unit_cost,2); v_disc := v_disc + ln.discount;
    end if;
    rec := case when ln.is_recoverable then tax else 0 end;
    nonrec := tax - rec;
    v_net := v_net + net; v_tax := v_tax + tax; v_rec := v_rec + rec; v_nonrec := v_nonrec + nonrec;
    v_grand := v_grand + round(net + tax, 2);
    cost_val := round(net + nonrec, 2);
    update public.purchase_lines set net_amount=net, tax_amount=tax, recoverable_tax=rec, nonrecoverable_tax=nonrec,
      gross_amount=round(net+tax,2), inventory_value = cost_val,
      fc_unit_cost = case when is_fc then ln.unit_cost else null end,
      fc_discount = case when is_fc then ln.discount else null end,
      fc_net_amount = case when is_fc then fc_net else null end,
      fc_tax_amount = case when is_fc then fc_tax else null end,
      fc_gross_amount = case when is_fc then round(fc_net + fc_tax, 2) else null end
      where id=ln.id;
    if cost_val > 0 then t := t || jsonb_build_object('id', ln.id, 'factor', cost_val); end if;
  end loop;

  -- Advances (prepayments) applied at their historical TZS: the prepaid share
  -- of the goods is measured at the advance rate, no FX gain/loss arises.
  for app in select a.* from public.purchase_advance_applications a where a.purchase_id=p_id order by a.advance_id loop
    select * into adv from public.supplier_advances where id=app.advance_id for update;
    if adv.supplier_id <> v.supplier_id or adv.currency_code <> v.currency_code or adv.status <> 'open' then
      raise exception 'Advance cannot be applied to this purchase' using errcode='P0001';
    end if;
    if adv.advance_date > v.document_date then
      raise exception 'An advance dated after the invoice cannot be applied to it' using errcode='P0001';
    end if;
    if app.fc_amount > adv.fc_remaining then raise exception 'Applied amount exceeds the advance balance' using errcode='P0001'; end if;
    update public.purchase_advance_applications
      set tzs_amount = public._carry_share(adv.tzs_remaining, app.fc_amount, adv.fc_remaining) where id = app.id
      returning tzs_amount into d;
    update public.supplier_advances set fc_remaining = fc_remaining - app.fc_amount, tzs_remaining = tzs_remaining - d,
      status = case when fc_remaining - app.fc_amount = 0 then 'applied' else 'open' end where id = adv.id;
    adv_fc := adv_fc + app.fc_amount; adv_tzs := adv_tzs + d;
  end loop;
  if adv_fc > (case when is_fc then fc_grand else v_grand end) then
    raise exception 'Advances applied exceed the invoice total' using errcode='P0001';
  end if;
  adv_at_rate := case when is_fc then round(adv_fc * rate, 2) else adv_fc end;
  d := adv_tzs - adv_at_rate;
  if d <> 0 then
    if jsonb_array_length(t) = 0 then raise exception 'No cost lines to carry the advance rate difference' using errcode='P0001'; end if;
    for share in select * from public.allocate_amount(d, 'value', t) loop
      update public.purchase_lines set inventory_value = inventory_value + share.amount where id = share.target_id;
    end loop;
  end if;

  -- Pass 2: stock at exact value; expense for non-stock lines.
  for ln in select * from public.purchase_lines where purchase_id=p_id order by product_id, line_no, id loop
    if ln.track_inventory then
      if ln.inventory_value < 0 then raise exception 'Line cost cannot be negative' using errcode='P0001'; end if;
      mv := public.record_stock_movement_value(v.company_id, v.branch_id, ln.product_id,
        'purchase','purchase', v.id, docnum, ln.quantity, ln.inventory_value, p_user);
      update public.purchase_lines set inventory_unit_cost = round(mv / ln.quantity, 4) where id=ln.id;
      v_inv := v_inv + mv;
    else
      v_expense := v_expense + ln.inventory_value;
      update public.purchase_lines set inventory_value = 0, inventory_unit_cost = 0 where id=ln.id;
    end if;
  end loop;

  select coalesce(sum(amount),0) into paid from public.purchase_payments where purchase_id=p_id;
  if paid + adv_at_rate > v_grand + 0.001 then raise exception 'Payments exceed the purchase total' using errcode='P0001'; end if;
  outstanding := round(v_grand - paid - adv_at_rate, 2);
  fc_out := case when is_fc then round(fc_grand - adv_fc, 2) else 0 end;

  if v_inv > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(v.company_id,'1150'),'debit',v_inv,'credit',0,'memo','Inventory'); end if;
  if v_expense > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(v.company_id,'6100'),'debit',v_expense,'credit',0,'memo','Purchases (non-stock)'); end if;
  if v_rec > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(v.company_id,'1160'),'debit',v_rec,'credit',0,'memo','Input VAT'); end if;
  for pay in select public.resolve_payment_ledger(v.company_id, payment_account_id) as acc, sum(amount) as amt
             from public.purchase_payments where purchase_id=p_id group by 1 loop
    jlines := jlines || jsonb_build_object('account_id', pay.acc,'debit',0,'credit',pay.amt,'memo','Payment');
  end loop;
  if adv_tzs > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(v.company_id,'import.supplier_advances'),'debit',0,'credit',adv_tzs,'memo','Advance applied'); end if;
  if outstanding > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(v.company_id,'2110'),'debit',0,'credit',outstanding,'memo',
    case when is_fc then 'Accounts payable ('||v.currency_code||' '||fc_out||')' else 'Accounts payable' end); end if;
  perform public.create_journal(v.company_id, v.branch_id, v.document_date, 'purchase', v.id, docnum, 'Purchase '||docnum, p_user, jlines);

  update public.purchases set document_status='posted', document_number=docnum, supplier_invoice_norm=norm,
    subtotal=v_sub, discount_total=v_disc, net_total=v_net, tax_total=v_tax, recoverable_tax=v_rec,
    nonrecoverable_tax=v_nonrec, grand_total=v_grand, inventory_value=v_inv,
    fc_subtotal = case when is_fc then fc_sub else 0 end, fc_tax_total = case when is_fc then fc_tax_t else 0 end,
    fc_grand_total = case when is_fc then fc_grand else 0 end,
    advance_applied_fc=adv_fc, advance_applied_tzs=adv_tzs, advance_applied_at_rate=adv_at_rate,
    posted_by=p_user, posted_at=now()
    where id=p_id;

  if outstanding > 0 or fc_out > 0 then
    insert into public.supplier_payables(company_id, branch_id, supplier_id, source_type, purchase_id, original_amount, outstanding,
        status, currency_code, fc_original, fc_outstanding)
      values (v.company_id, v.branch_id, v.supplier_id, 'purchase', v.id, outstanding, outstanding, 'open',
        v.currency_code, fc_out, fc_out)
      returning * into pb;
    perform public._payable_event(pb, 'invoice', 'purchase', v.id, v.document_date, fc_out, outstanding);
  end if;

  perform public.recalc_purchase(p_id);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (v.company_id, 'purchase', p_id, 'draft', 'posted', p_user);
  return p_id;
end; $$;

-- Balance derivation. TZS purchases: unchanged formula (plus advances and
-- credit applications). Foreign purchases: the payable is event-maintained;
-- the purchase mirrors it.
create or replace function public.recalc_purchase(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.purchases; pb public.supplier_payables; init_paid numeric(18,2); alloc numeric(18,2);
  ret_total numeric(18,2); ret_payable numeric(18,2); credits numeric(18,2); paid numeric(18,2);
  v_out numeric(18,2); v_status text; ret_fc numeric(18,2);
begin
  select * into v from public.purchases where id=p_id;
  select coalesce(sum(a.amount),0) into alloc
    from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.id=a.payment_id
    join public.supplier_payables p on p.id=a.payable_id
    where p.purchase_id=p_id and sp.document_status='posted';
  select coalesce(sum(c.payable_tzs_released),0) into credits
    from public.supplier_credit_applications c join public.supplier_payables p on p.id=c.payable_id where p.purchase_id=p_id;

  if v.currency_code = 'TZS' then
    select coalesce(sum(amount),0) into init_paid from public.purchase_payments where purchase_id=p_id;
    select coalesce(sum(total),0), coalesce(sum(payable_reduction),0) into ret_total, ret_payable
      from public.purchase_returns where purchase_id=p_id and document_status='posted';
    paid := round(init_paid + alloc + v.advance_applied_at_rate + credits, 2);
    v_out := round(v.grand_total - paid - ret_payable, 2);
    if v_out < 0 then v_out := 0; end if;
    if ret_total >= v.grand_total and v.grand_total > 0 then v_status := 'refunded';
    elsif ret_total > 0 then v_status := 'partially_refunded';
    elsif paid <= 0 then v_status := 'unpaid';
    elsif paid < v.grand_total then v_status := 'partially_paid';
    else v_status := 'paid';
    end if;
    update public.purchases set amount_paid=paid, outstanding=v_out, payment_status=v_status where id=p_id;
    update public.supplier_payables set outstanding=v_out,
      status = case when status = 'voided' then 'voided' when v_out<=0 then 'settled'
                    when paid>0 or ret_payable>0 then 'partial' else 'open' end
      where purchase_id=p_id;
    return;
  end if;

  -- Foreign currency.
  select * into pb from public.supplier_payables where purchase_id=p_id;
  select coalesce(sum(fc_total),0) into ret_fc from public.purchase_returns where purchase_id=p_id and document_status='posted';
  paid := round(alloc + v.advance_applied_tzs + credits, 2);
  if pb.id is null then
    v_out := 0; v_status := case when ret_fc > 0 then 'partially_refunded' else 'paid' end;
  else
    v_out := pb.outstanding;
    if pb.status <> 'voided' then
      update public.supplier_payables set status = case when fc_outstanding <= 0 then 'settled'
        when fc_outstanding < fc_original then 'partial' else 'open' end where id = pb.id
        returning * into pb;
    end if;
    if ret_fc >= v.fc_grand_total and v.fc_grand_total > 0 then v_status := 'refunded';
    elsif ret_fc > 0 then v_status := 'partially_refunded';
    elsif pb.fc_outstanding <= 0 then v_status := 'paid';
    elsif pb.fc_outstanding < v.fc_grand_total then v_status := 'partially_paid';
    else v_status := 'unpaid';
    end if;
  end if;
  update public.purchases set amount_paid=paid, outstanding=v_out, payment_status=v_status where id=p_id;
end; $$;

-- Void: exact reversal of the posting journal; stock leaves at the current
-- average and any difference to the original inventory value goes to purchase
-- price variance (5300) so the stock subledger and GL stay equal (fixes D1 for
-- purchases). Advances applied are restored.
create or replace function public.void_purchase(p_id uuid, p_user uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v public.purchases; ln record; jl record; app record; pb public.supplier_payables;
  jlines jsonb := '[]'::jsonb; removed numeric(18,2) := 0; diff numeric(18,2); j uuid;
begin
  select * into v from public.purchases where id=p_id for update;
  if not found then raise exception 'Purchase not found' using errcode='P0001'; end if;
  if v.document_status <> 'posted' then raise exception 'Only posted purchases can be voided' using errcode='P0001'; end if;
  if coalesce(p_reason,'')='' then raise exception 'A reason is required' using errcode='P0001'; end if;
  perform public.assert_period_open(v.company_id, v.document_date);
  perform public.assert_period_open(v.company_id, current_date);
  if exists (select 1 from public.supplier_payment_allocations a join public.supplier_payments sp on sp.id=a.payment_id
             join public.supplier_payables b on b.id=a.payable_id
             where b.purchase_id=p_id and sp.document_status='posted') then
    raise exception 'Void the supplier payments on this purchase first' using errcode='P0001';
  end if;
  if exists (select 1 from public.purchase_returns where purchase_id=p_id and document_status='posted') then
    raise exception 'Void the purchase returns on this purchase first' using errcode='P0001';
  end if;
  if exists (select 1 from public.supplier_credit_applications c join public.supplier_payables b on b.id=c.payable_id where b.purchase_id=p_id) then
    raise exception 'Supplier credits were applied to this purchase; it cannot be voided' using errcode='P0001';
  end if;
  select * into pb from public.supplier_payables where purchase_id=p_id for update;
  if pb.id is not null then
    perform public._assert_no_later_payable_events(pb.id,
      (select max(created_at) from public.supplier_payable_events where payable_id=pb.id and event_type='invoice'), 'purchase');
  end if;

  for ln in select * from public.purchase_lines where purchase_id=p_id order by product_id, line_no loop
    if ln.track_inventory and ln.quantity>0 then
      removed := removed + public.record_stock_movement(v.company_id, v.branch_id, ln.product_id,
        'purchase_return','purchase_void', v.id, v.document_number, 0, ln.quantity, 0, p_user);
    end if;
  end loop;

  -- Mirror every line of the posting journal.
  select id into j from public.journal_entries where source_type='purchase' and source_id=p_id order by created_at limit 1;
  for jl in select account_id, sum(debit) d, sum(credit) c from public.journal_lines where journal_id=j group by account_id loop
    jlines := jlines || jsonb_build_object('account_id', jl.account_id, 'debit', jl.c, 'credit', jl.d);
  end loop;
  diff := round(v.inventory_value - removed, 2);
  if diff > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(v.company_id,'1150'),'debit',diff,'credit',0,'memo','Stock removed at average')
                     || jsonb_build_object('account_id', public.account_for(v.company_id,'inventory.price_variance'),'debit',0,'credit',diff,'memo','Purchase price variance');
  elsif diff < 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(v.company_id,'1150'),'debit',0,'credit',-diff,'memo','Stock removed at average')
                     || jsonb_build_object('account_id', public.account_for(v.company_id,'inventory.price_variance'),'debit',-diff,'credit',0,'memo','Purchase price variance');
  end if;
  perform public.create_journal(v.company_id, v.branch_id, current_date, 'purchase_void', v.id, v.document_number, 'Void purchase '||v.document_number, p_user, jlines);

  for app in select * from public.purchase_advance_applications where purchase_id=p_id loop
    update public.supplier_advances set fc_remaining = fc_remaining + app.fc_amount,
      tzs_remaining = tzs_remaining + coalesce(app.tzs_amount,0), status = 'open' where id = app.advance_id;
  end loop;

  if pb.id is not null then
    perform public._payable_event(pb, 'invoice_void', 'purchase', p_id, current_date, -pb.fc_outstanding, -pb.outstanding);
    update public.supplier_payables set outstanding=0, fc_outstanding=0, status='voided' where id=pb.id;
  end if;
  update public.purchases set document_status='voided', voided_by=p_user, voided_at=now(), void_reason=p_reason where id=p_id;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (v.company_id, 'purchase', p_id, 'posted', 'voided', p_reason, p_user);
  return p_id;
end; $$;

-- ===========================================================================
-- 4. Supplier payments: TZS (existing behaviour + advances + bank charges)
--    and foreign-currency settlement.
-- ===========================================================================
create or replace function public.post_supplier_payment(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v public.supplier_payments; is_fc boolean; fund_total numeric(18,2); alloc_total numeric(18,2) := 0;
  fc_alloc numeric(18,2) := 0; a record; pb public.supplier_payables; f record; docnum text; jlines jsonb := '[]'::jsonb;
  t jsonb := '[]'::jsonb; released numeric(18,2); paid_share numeric(18,2); fx_total numeric(18,2) := 0;
  rel_total numeric(18,2) := 0; adv_tzs numeric(18,2) := 0; last_rev date;
begin
  select * into v from public.supplier_payments where id=p_id for update;
  if not found then raise exception 'Payment not found' using errcode='P0001'; end if;
  if public._is_replay(p_idem, 'post_supplier_payment', p_id) then return p_id; end if;
  if v.document_status <> 'draft' then raise exception 'Payment already %', v.document_status using errcode='P0001'; end if;
  is_fc := v.currency_code <> 'TZS';
  if is_fc then
    perform public._require_key(p_idem);
    perform public.assert_feature(v.company_id, 'fx_settlement');
    perform public.assert_actor(p_user, v.company_id, 'fx.settle', v.branch_id);
  end if;
  if not public.claim_idempotency(p_idem, 'post_supplier_payment', p_id) then return p_id; end if;
  perform public.assert_period_open(v.company_id, v.document_date);

  select coalesce(sum(amount),0) into fund_total from public.supplier_payment_funding where payment_id=p_id;
  if fund_total <= 0 then raise exception 'Payment amount must be greater than zero' using errcode='P0001'; end if;
  if v.bank_charges > 0 and not exists (select 1 from public.payment_accounts where id=v.bank_charges_account_id and company_id=v.company_id) then
    raise exception 'Bank charges account does not belong to this company' using errcode='23514';
  end if;
  if exists (select 1 from public.supplier_payment_funding fd join public.payment_accounts pa on pa.id=fd.payment_account_id
             where fd.payment_id=p_id and pa.company_id <> v.company_id) then
    raise exception 'Funding account does not belong to this company' using errcode='23514';
  end if;

  if not is_fc then
    if v.advance_fc_amount < 0 then raise exception 'Advance cannot be negative' using errcode='P0001'; end if;
    for a in select * from public.supplier_payment_allocations where payment_id=p_id order by payable_id loop
      select * into pb from public.supplier_payables where id=a.payable_id for update;
      if not found or pb.company_id <> v.company_id or pb.supplier_id <> v.supplier_id then
        raise exception 'Invalid payable in allocation' using errcode='P0001'; end if;
      if pb.currency_code <> 'TZS' or a.fc_amount is not null then
        raise exception 'A TZS payment can only settle TZS invoices' using errcode='P0001'; end if;
      if a.amount > pb.outstanding + 0.001 then raise exception 'Allocation exceeds outstanding balance' using errcode='P0001'; end if;
      alloc_total := alloc_total + a.amount;
    end loop;
    if round(fund_total,2) <> round(alloc_total + v.advance_fc_amount, 2) then
      raise exception 'Funding (%) must equal invoices settled plus advance (%)', fund_total, alloc_total + v.advance_fc_amount using errcode='P0001';
    end if;
    adv_tzs := v.advance_fc_amount;
    rel_total := alloc_total;
  else
    for a in select * from public.supplier_payment_allocations where payment_id=p_id loop
      if a.fc_amount is null then raise exception 'Enter the % amount settled on every invoice', v.currency_code using errcode='P0001'; end if;
      fc_alloc := fc_alloc + a.fc_amount;
      t := t || jsonb_build_object('id', a.id, 'factor', a.fc_amount);
    end loop;
    if v.advance_fc_amount > 0 then t := t || jsonb_build_object('id', p_id, 'factor', v.advance_fc_amount); end if;
    if fc_alloc + v.advance_fc_amount <= 0 then raise exception 'Nothing to settle' using errcode='P0001'; end if;
    -- The actual TZS paid is shared over invoices and advance by foreign amount.
    for a in select al.*, sh.amount as share from public.supplier_payment_allocations al
             join public.allocate_amount(fund_total, 'value', t) sh on sh.target_id = al.id
             where al.payment_id=p_id order by al.payable_id loop
      select * into pb from public.supplier_payables where id=a.payable_id for update;
      if not found or pb.company_id <> v.company_id or pb.supplier_id <> v.supplier_id then
        raise exception 'Invalid payable in allocation' using errcode='P0001'; end if;
      if pb.currency_code <> v.currency_code then
        raise exception 'A % payment can only settle % invoices', v.currency_code, v.currency_code using errcode='P0001'; end if;
      if pb.status not in ('open','partial') then raise exception 'Invoice is not open' using errcode='P0001'; end if;
      if a.fc_amount > pb.fc_outstanding then
        raise exception 'Settlement % % exceeds the open balance % %', v.currency_code, a.fc_amount, v.currency_code, pb.fc_outstanding using errcode='P0001'; end if;
      last_rev := public._last_revaluation(pb.id, null);
      if last_rev is not null and v.document_date < last_rev then
        raise exception 'Payment date is before the last revaluation (%) of this invoice', to_char(last_rev,'DD/MM/YYYY') using errcode='P0001'; end if;
      released := public._carry_share(pb.outstanding, a.fc_amount, pb.fc_outstanding);
      paid_share := a.share;
      update public.supplier_payment_allocations set amount = released, tzs_paid = paid_share,
        fx_difference = paid_share - released where id = a.id;
      update public.supplier_payables set fc_outstanding = fc_outstanding - a.fc_amount, outstanding = outstanding - released
        where id = pb.id returning * into pb;
      perform public._payable_event(pb, 'settlement', 'supplier_payment', p_id, v.document_date, -a.fc_amount, -released);
      rel_total := rel_total + released; fx_total := fx_total + (paid_share - released);
    end loop;
    if v.advance_fc_amount > 0 then
      select amount into adv_tzs from public.allocate_amount(fund_total, 'value', t) where target_id = p_id;
      if adv_tzs <= 0 then raise exception 'The advance needs a TZS amount' using errcode='P0001'; end if;
    end if;
  end if;

  for f in select pa, sum(amt) amt from (
             select payment_account_id pa, amount amt from public.supplier_payment_funding where payment_id=p_id
             union all select v.bank_charges_account_id, v.bank_charges where v.bank_charges > 0) x group by pa loop
    perform public.assert_sufficient_funds(f.pa, f.amt, v.document_date);
  end loop;

  docnum := public.next_document_number(v.company_id, v.branch_id, 'supplier_payment');
  if rel_total > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(v.company_id,'2110'),'debit',rel_total,'credit',0,'memo','Accounts payable'); end if;
  if adv_tzs > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(v.company_id,'import.supplier_advances'),'debit',adv_tzs,'credit',0,'memo','Supplier advance'); end if;
  if fx_total > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(v.company_id,'fx.realised_loss'),'debit',fx_total,'credit',0,'memo','Realised FX loss');
  elsif fx_total < 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(v.company_id,'fx.realised_gain'),'debit',0,'credit',-fx_total,'memo','Realised FX gain'); end if;
  for f in select public.resolve_payment_ledger(v.company_id, payment_account_id) as acc, sum(amount) as amt
           from public.supplier_payment_funding where payment_id=p_id group by 1 loop
    jlines := jlines || jsonb_build_object('account_id', f.acc,'debit',0,'credit',f.amt,'memo','Payment');
  end loop;
  if v.bank_charges > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(v.company_id,'6200'),'debit',v.bank_charges,'credit',0,'memo','Bank charges')
                     || jsonb_build_object('account_id', public.resolve_payment_ledger(v.company_id, v.bank_charges_account_id),'debit',0,'credit',v.bank_charges,'memo','Bank charges');
  end if;
  perform public.create_journal(v.company_id, v.branch_id, v.document_date, 'supplier_payment', v.id, docnum,
    'Supplier payment '||docnum || case when is_fc then ' ('||v.currency_code||' '||(fc_alloc + v.advance_fc_amount)||')' else '' end, p_user, jlines);

  if v.advance_fc_amount > 0 then
    insert into public.supplier_advances(company_id, branch_id, supplier_id, payment_id, currency_code, advance_date,
        fc_amount, tzs_amount, fc_remaining, tzs_remaining)
      values (v.company_id, v.branch_id, v.supplier_id, p_id, v.currency_code, v.document_date,
        v.advance_fc_amount, adv_tzs, v.advance_fc_amount, adv_tzs);
  end if;

  update public.supplier_payments set document_status='posted', document_number=docnum, amount=fund_total,
    fc_total = case when is_fc then fc_alloc + v.advance_fc_amount else 0 end, fx_difference = fx_total,
    posted_by=p_user, posted_at=now() where id=p_id;

  for a in select distinct pb2.purchase_id, pb2.expense_id from public.supplier_payment_allocations al
           join public.supplier_payables pb2 on pb2.id=al.payable_id where al.payment_id=p_id loop
    if a.purchase_id is not null then perform public.recalc_purchase(a.purchase_id);
    elsif a.expense_id is not null then perform public.recalc_expense(a.expense_id); end if;
  end loop;

  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (v.company_id, 'supplier_payment', p_id, 'draft', 'posted', p_user);
  return p_id;
end; $$;

create or replace function public.void_supplier_payment(p_id uuid, p_user uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v public.supplier_payments; a record; pb public.supplier_payables; adv public.supplier_advances;
  jl record; jlines jsonb := '[]'::jsonb; j uuid; ev timestamptz;
begin
  select * into v from public.supplier_payments where id=p_id for update;
  if not found then raise exception 'Payment not found' using errcode='P0001'; end if;
  if v.document_status <> 'posted' then raise exception 'Only posted payments can be voided' using errcode='P0001'; end if;
  if coalesce(p_reason,'')='' then raise exception 'A reason is required' using errcode='P0001'; end if;
  perform public.assert_period_open(v.company_id, v.document_date);
  perform public.assert_period_open(v.company_id, current_date);

  select * into adv from public.supplier_advances where payment_id=p_id for update;
  if adv.id is not null and (adv.fc_remaining < adv.fc_amount or adv.status <> 'open') then
    raise exception 'The advance from this payment has been applied to a purchase; void that purchase first' using errcode='P0001';
  end if;

  for a in select * from public.supplier_payment_allocations where payment_id=p_id order by payable_id loop
    select * into pb from public.supplier_payables where id=a.payable_id for update;
    if pb.currency_code <> 'TZS' then
      select max(created_at) into ev from public.supplier_payable_events
        where payable_id=pb.id and source_id=p_id and event_type='settlement';
      perform public._assert_no_later_payable_events(pb.id, ev, 'payment');
      update public.supplier_payables set fc_outstanding = fc_outstanding + a.fc_amount, outstanding = outstanding + a.amount
        where id=pb.id returning * into pb;
      perform public._payable_event(pb, 'settlement_void', 'supplier_payment', p_id, current_date, a.fc_amount, a.amount);
    end if;
  end loop;

  select id into j from public.journal_entries where source_type='supplier_payment' and source_id=p_id order by created_at limit 1;
  for jl in select account_id, sum(debit) d, sum(credit) c from public.journal_lines where journal_id=j group by account_id loop
    jlines := jlines || jsonb_build_object('account_id', jl.account_id, 'debit', jl.c, 'credit', jl.d);
  end loop;
  perform public.create_journal(v.company_id, v.branch_id, current_date, 'supplier_payment_void', v.id, v.document_number, 'Void payment '||v.document_number, p_user, jlines);

  if adv.id is not null then
    update public.supplier_advances set status='voided', fc_remaining=0, tzs_remaining=0 where id=adv.id;
  end if;
  update public.supplier_payments set document_status='voided', voided_by=p_user, voided_at=now(), void_reason=p_reason where id=p_id;

  for a in select distinct pb2.purchase_id, pb2.expense_id from public.supplier_payment_allocations al
           join public.supplier_payables pb2 on pb2.id=al.payable_id where al.payment_id=p_id loop
    if a.purchase_id is not null then perform public.recalc_purchase(a.purchase_id);
    elsif a.expense_id is not null then perform public.recalc_expense(a.expense_id); end if;
  end loop;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (v.company_id, 'supplier_payment', p_id, 'posted', 'voided', p_reason, p_user);
  return p_id;
end; $$;

-- ===========================================================================
-- 5. Purchase returns. Policy for foreign purchases:
--   * goods, VAT and price variance are valued at the ORIGINAL invoice rate
--     (the TZS line amounts of the purchase, pro rata) - the same basis as the
--     purchase; stock leaves at current average with the difference to 5300,
--     exactly like TZS returns;
--   * reduce_payable releases the payable's TZS carrying share for the
--     foreign amount returned; any difference to the original-rate value is a
--     reversal of unrealised FX (4410 / 6410), never inventory cost;
--   * supplier_credit creates a foreign credit carried at the original-rate
--     TZS; refunds in foreign currency are not supported (use a credit).
-- ===========================================================================
create or replace function public.post_purchase_return(p_id uuid, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r public.purchase_returns; pur public.purchases; ln record; docnum text; prior numeric(18,4); prior_fc numeric(18,2);
  v_net numeric(18,2):=0; v_tax numeric(18,2):=0; v_total numeric(18,2):=0;
  v_recvat numeric(18,2):=0; v_cc numeric(18,2):=0; cost numeric(18,2);
  refund numeric(18,2); remaining numeric(18,2); v_payred numeric(18,2):=0;
  v_credit numeric(18,2):=0; settlement_gross numeric(18,2); ppv numeric(18,2);
  jlines jsonb := '[]'::jsonb; s record; is_fc boolean; fc_tot numeric(18,2) := 0; fc_line numeric(18,2);
  pb public.supplier_payables; unreal numeric(18,2) := 0; last_rev date;
begin
  select * into r from public.purchase_returns where id=p_id for update;
  if not found then raise exception 'Return not found' using errcode='P0001'; end if;
  if public._is_replay(p_idem, 'post_purchase_return', p_id) then return p_id; end if;
  if r.document_status <> 'draft' then raise exception 'Return already %', r.document_status using errcode='P0001'; end if;
  select * into pur from public.purchases where id=r.purchase_id;
  is_fc := pur.currency_code <> 'TZS';
  if is_fc then
    perform public._require_key(p_idem);
    perform public.assert_feature(r.company_id, 'fx_settlement');
    perform public.assert_actor(p_user, r.company_id, 'purchases.create_return', r.branch_id);
    if r.settlement_method not in ('reduce_payable','supplier_credit') then
      raise exception 'Foreign-currency returns reduce the payable or create a supplier credit' using errcode='P0001';
    end if;
    if exists (select 1 from public.purchase_return_settlements where return_id=p_id) then
      raise exception 'Foreign-currency returns cannot be refunded in cash; use a supplier credit' using errcode='P0001';
    end if;
  end if;
  if not public.claim_idempotency(p_idem, 'post_purchase_return', p_id) then return p_id; end if;
  if coalesce(r.reason,'')='' then raise exception 'A reason is required' using errcode='P0001'; end if;
  perform public.assert_period_open(r.company_id, r.document_date);

  docnum := public.next_document_number(r.company_id, r.branch_id, 'purchase_return');

  for ln in select rl.*, pl.quantity as bought_qty, pl.fc_gross_amount as pl_fc_gross from public.purchase_return_lines rl
            join public.purchase_lines pl on pl.id=rl.purchase_line_id
            where rl.return_id=p_id order by rl.product_id, rl.line_no loop
    select coalesce(sum(prl.quantity),0), coalesce(sum(prl.fc_line_total),0) into prior, prior_fc
      from public.purchase_return_lines prl join public.purchase_returns pr on pr.id=prl.return_id
      where prl.purchase_line_id=ln.purchase_line_id and pr.document_status='posted';
    if ln.quantity + prior > ln.bought_qty + 0.0001 then
      raise exception 'Return exceeds purchased quantity for a line' using errcode='P0001';
    end if;
    v_net := v_net + ln.net_amount; v_tax := v_tax + ln.tax_amount; v_total := v_total + ln.line_total;
    if ln.is_recoverable then v_recvat := v_recvat + ln.tax_amount; end if;
    if is_fc then
      fc_line := case when ln.quantity + prior >= ln.bought_qty then ln.pl_fc_gross - prior_fc
                      else round(ln.pl_fc_gross * ln.quantity / ln.bought_qty, 2) end;
      update public.purchase_return_lines set fc_line_total = fc_line where id=ln.id;
      fc_tot := fc_tot + fc_line;
    end if;
    if ln.track_inventory then
      cost := public.record_stock_movement(r.company_id, r.branch_id, ln.product_id,
        'purchase_return','purchase_return', r.id, docnum, 0, ln.quantity, 0, p_user);
      v_cc := v_cc + cost;
      update public.purchase_return_lines set inventory_cost = cost where id=ln.id;
    end if;
  end loop;

  settlement_gross := round(v_total, 2);
  select coalesce(sum(amount),0) into refund from public.purchase_return_settlements where return_id=p_id;
  if refund > settlement_gross + 0.001 then raise exception 'Refund exceeds the return value' using errcode='P0001'; end if;
  remaining := round(settlement_gross - refund, 2);
  if not is_fc then
    if r.settlement_method = 'supplier_credit' then v_credit := remaining; else v_payred := remaining; end if;
  elsif r.settlement_method = 'reduce_payable' then
    select * into pb from public.supplier_payables where purchase_id = r.purchase_id for update;
    if pb.id is null or pb.status not in ('open','partial') or pb.fc_outstanding < fc_tot then
      raise exception 'Return of % % exceeds the open balance; use a supplier credit', pur.currency_code, fc_tot using errcode='P0001';
    end if;
    last_rev := public._last_revaluation(pb.id, null);
    if last_rev is not null and r.document_date < last_rev then
      raise exception 'Return date is before the last revaluation (%) of this invoice', to_char(last_rev,'DD/MM/YYYY') using errcode='P0001';
    end if;
    v_payred := public._carry_share(pb.outstanding, fc_tot, pb.fc_outstanding);
    unreal := v_payred - settlement_gross;
    update public.supplier_payables set fc_outstanding = fc_outstanding - fc_tot, outstanding = outstanding - v_payred
      where id = pb.id returning * into pb;
    perform public._payable_event(pb, 'return', 'purchase_return', p_id, r.document_date, -fc_tot, -v_payred);
  else
    v_credit := settlement_gross;
  end if;
  ppv := round(settlement_gross - v_recvat - v_cc, 2);

  if v_payred > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(r.company_id,'2110'),'debit',v_payred,'credit',0,'memo','Reduce payable'); end if;
  if v_credit > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(r.company_id,'1170'),'debit',v_credit,'credit',0,'memo','Supplier credit'); end if;
  for s in select public.resolve_payment_ledger(r.company_id, payment_account_id) as acc, sum(amount) as amt
           from public.purchase_return_settlements where return_id=p_id group by 1 loop
    jlines := jlines || jsonb_build_object('account_id', s.acc,'debit',s.amt,'credit',0,'memo','Refund received');
  end loop;
  if v_recvat > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(r.company_id,'1160'),'debit',0,'credit',v_recvat,'memo','Input VAT reversal'); end if;
  if v_cc > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(r.company_id,'1150'),'debit',0,'credit',v_cc,'memo','Inventory'); end if;
  if ppv > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(r.company_id,'5300'),'debit',0,'credit',ppv,'memo','Purchase price variance');
  elsif ppv < 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(r.company_id,'5300'),'debit',-ppv,'credit',0,'memo','Purchase price variance'); end if;
  if unreal > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(r.company_id,'fx.unrealised_gain'),'debit',0,'credit',unreal,'memo','Unrealised FX reversed');
  elsif unreal < 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(r.company_id,'fx.unrealised_loss'),'debit',-unreal,'credit',0,'memo','Unrealised FX reversed'); end if;
  perform public.create_journal(r.company_id, r.branch_id, r.document_date, 'purchase_return', r.id, docnum, 'Purchase return '||docnum, p_user, jlines);

  update public.purchase_returns set document_status='posted', document_number=docnum,
    net_total=v_net, tax_total=v_tax, total=v_total, inventory_cost_removed=v_cc,
    refund_amount=refund, payable_reduction=v_payred, credit_amount=v_credit,
    price_variance=ppv, currency_code=pur.currency_code, fc_total=fc_tot, fx_unrealised_reversal=unreal,
    posted_by=p_user, posted_at=now() where id=p_id;

  if v_credit > 0 then
    insert into public.supplier_credits(company_id, supplier_id, source_return_id, amount, remaining, status,
        currency_code, fc_amount, fc_remaining, credit_date)
      values (r.company_id, r.supplier_id, r.id, v_credit, v_credit, 'open', pur.currency_code,
        case when is_fc then fc_tot else v_credit end, case when is_fc then fc_tot else v_credit end, r.document_date);
  end if;

  perform public.recalc_purchase(r.purchase_id);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (r.company_id, 'purchase_return', p_id, 'draft', 'posted', p_user);
  return p_id;
end; $$;

create or replace function public.void_purchase_return(p_id uuid, p_user uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.purchase_returns; ln record; jl record; jlines jsonb := '[]'::jsonb; j uuid;
  pb public.supplier_payables; ev timestamptz;
begin
  select * into r from public.purchase_returns where id=p_id for update;
  if not found then raise exception 'Return not found' using errcode='P0001'; end if;
  if r.document_status <> 'posted' then raise exception 'Only posted returns can be voided' using errcode='P0001'; end if;
  if coalesce(p_reason,'')='' then raise exception 'A reason is required' using errcode='P0001'; end if;
  perform public.assert_period_open(r.company_id, r.document_date);
  perform public.assert_period_open(r.company_id, current_date);
  if exists (select 1 from public.supplier_credits where source_return_id=p_id and (status='used' or fc_remaining < fc_amount)) then
    raise exception 'A supplier credit from this return has been used; reverse it first' using errcode='P0001';
  end if;

  if r.currency_code <> 'TZS' and r.payable_reduction > 0 then
    select * into pb from public.supplier_payables where purchase_id=r.purchase_id for update;
    select max(created_at) into ev from public.supplier_payable_events where payable_id=pb.id and source_id=p_id and event_type='return';
    perform public._assert_no_later_payable_events(pb.id, ev, 'return');
    update public.supplier_payables set fc_outstanding = fc_outstanding + r.fc_total, outstanding = outstanding + r.payable_reduction
      where id=pb.id returning * into pb;
    perform public._payable_event(pb, 'return_void', 'purchase_return', p_id, current_date, r.fc_total, r.payable_reduction);
  end if;

  -- Restore stock at exactly the cost that was removed.
  for ln in select * from public.purchase_return_lines where return_id=p_id order by product_id, line_no loop
    if ln.track_inventory and ln.quantity>0 then
      perform public.record_stock_movement_value(r.company_id, r.branch_id, ln.product_id,
        'purchase','purchase_return_void', r.id, r.document_number, ln.quantity, ln.inventory_cost, p_user);
    end if;
  end loop;

  select id into j from public.journal_entries where source_type='purchase_return' and source_id=p_id order by created_at limit 1;
  for jl in select account_id, sum(debit) d, sum(credit) c from public.journal_lines where journal_id=j group by account_id loop
    jlines := jlines || jsonb_build_object('account_id', jl.account_id, 'debit', jl.c, 'credit', jl.d);
  end loop;
  perform public.create_journal(r.company_id, r.branch_id, current_date, 'purchase_return_void', r.id, r.document_number, 'Void return '||r.document_number, p_user, jlines);

  update public.supplier_credits set status='voided', remaining=0, fc_remaining=0 where source_return_id=p_id;
  update public.purchase_returns set document_status='voided', voided_by=p_user, voided_at=now(), void_reason=p_reason where id=p_id;
  perform public.recalc_purchase(r.purchase_id);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (r.company_id, 'purchase_return', p_id, 'posted', 'voided', p_reason, p_user);
  return p_id;
end; $$;

-- ===========================================================================
-- 6. Apply a supplier credit to an open purchase invoice of the same
-- supplier and currency. Both are monetary: the credit releases its carrying
-- share, the invoice its carrying share; the difference is realised FX.
-- ===========================================================================
create or replace function public.apply_supplier_credit(
  p_credit uuid, p_payable uuid, p_fc_amount numeric, p_date date, p_user uuid, p_idem text
) returns uuid language plpgsql security definer set search_path = public as $$
declare c public.supplier_credits; pb public.supplier_payables; is_fc boolean; credit_rel numeric(18,2);
  payable_rel numeric(18,2); fx numeric(18,2); docnum text; app_id uuid; jlines jsonb := '[]'::jsonb; last_rev date;
begin
  perform public._require_key(p_idem);
  select * into c from public.supplier_credits where id=p_credit for update;
  if not found then raise exception 'Supplier credit not found' using errcode='P0001'; end if;
  select * into pb from public.supplier_payables where id=p_payable for update;
  if not found then raise exception 'Invoice not found' using errcode='P0001'; end if;
  if not public.claim_operation(p_idem, 'apply_supplier_credit:' || p_credit, p_payable) then
    select id into app_id from public.supplier_credit_applications where credit_id=p_credit and payable_id=p_payable
      order by created_at desc limit 1;
    return app_id;
  end if;
  if pb.company_id <> c.company_id then raise exception 'Cross-company credit application' using errcode='23514'; end if;
  perform public.assert_actor(p_user, c.company_id, 'purchases.record_payment', pb.branch_id);
  is_fc := c.currency_code <> 'TZS';
  if is_fc then perform public.assert_feature(c.company_id, 'fx_settlement'); end if;
  if pb.supplier_id <> c.supplier_id or pb.currency_code <> c.currency_code or pb.source_type <> 'purchase' then
    raise exception 'The credit must match the invoice''s supplier and currency' using errcode='P0001';
  end if;
  if c.status <> 'open' or pb.status not in ('open','partial') then raise exception 'Credit or invoice is not open' using errcode='P0001'; end if;
  if p_fc_amount is null or p_fc_amount <= 0 or p_fc_amount <> round(p_fc_amount, 2) then
    raise exception 'Enter a positive amount with at most 2 decimals' using errcode='P0001'; end if;
  if p_fc_amount > c.fc_remaining then raise exception 'Amount exceeds the credit balance' using errcode='P0001'; end if;
  if p_fc_amount > (case when is_fc then pb.fc_outstanding else pb.outstanding end) then
    raise exception 'Amount exceeds the invoice balance' using errcode='P0001'; end if;
  perform public.assert_period_open(c.company_id, p_date);
  if p_date < c.credit_date then raise exception 'Application date is before the credit date' using errcode='P0001'; end if;
  last_rev := greatest(public._last_revaluation(pb.id, null), public._last_revaluation(null, c.id));
  if last_rev is not null and p_date < last_rev then
    raise exception 'Application date is before the last revaluation (%)', to_char(last_rev,'DD/MM/YYYY') using errcode='P0001';
  end if;

  credit_rel := public._carry_share(c.remaining, p_fc_amount, c.fc_remaining);
  payable_rel := case when is_fc then public._carry_share(pb.outstanding, p_fc_amount, pb.fc_outstanding) else p_fc_amount end;
  fx := credit_rel - payable_rel;
  docnum := public.next_document_number(c.company_id, pb.branch_id, 'supplier_credit_application');
  app_id := gen_random_uuid();

  jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(c.company_id,'2110'),'debit',payable_rel,'credit',0,'memo','Credit applied to invoice')
                   || jsonb_build_object('account_id', public.account_id_by_code(c.company_id,'1170'),'debit',0,'credit',credit_rel,'memo','Supplier credit used');
  if fx > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(c.company_id,'fx.realised_loss'),'debit',fx,'credit',0,'memo','Realised FX loss');
  elsif fx < 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(c.company_id,'fx.realised_gain'),'debit',0,'credit',-fx,'memo','Realised FX gain'); end if;
  perform public.create_journal(c.company_id, pb.branch_id, p_date, 'supplier_credit_application', app_id, docnum,
    'Supplier credit applied '||docnum, p_user, jlines);

  insert into public.supplier_credit_applications(id, company_id, credit_id, payable_id, application_date, fc_amount,
      credit_tzs_released, payable_tzs_released, fx_difference, document_number, created_by)
    values (app_id, c.company_id, p_credit, p_payable, p_date, p_fc_amount, credit_rel, payable_rel, fx, docnum, p_user);
  update public.supplier_credits set fc_remaining = fc_remaining - p_fc_amount, remaining = remaining - credit_rel,
    status = case when fc_remaining - p_fc_amount = 0 then 'used' else 'open' end where id = p_credit;
  if is_fc then
    update public.supplier_payables set fc_outstanding = fc_outstanding - p_fc_amount, outstanding = outstanding - payable_rel
      where id = pb.id returning * into pb;
    perform public._payable_event(pb, 'credit_application', 'supplier_credit_application', app_id, p_date, -p_fc_amount, -payable_rel);
  end if;
  perform public.recalc_purchase(pb.purchase_id);
  return app_id;
end; $$;

-- ===========================================================================
-- 7. Period-end revaluation of foreign purchase payables and supplier
-- credits at authorised closing rates. Updates the TZS carrying amount (no
-- automatic reversal): later settlements measure realised FX from the
-- revalued carrying amount, so unrealised and realised FX never overlap.
-- p_rates: [{"currency":"USD","rate":2650,"source":"manual","reference":"BOT 30/09"}]
-- ===========================================================================
create or replace function public.post_fx_revaluation(p_company uuid, p_date date, p_rates jsonb, p_user uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  rv_id uuid; rr jsonb; cur text; rate numeric; src text; pb public.supplier_payables; cr public.supplier_credits;
  new_c numeric(18,2); diff numeric(18,2); pay_up numeric(18,2) := 0; pay_down numeric(18,2) := 0;
  cred_up numeric(18,2) := 0; cred_down numeric(18,2) := 0; docnum text; jlines jsonb := '[]'::jsonb; missing text;
  op text := 'post_fx_revaluation:' || p_company || ':' || p_date;
begin
  perform public._require_key(p_idem);
  perform public.assert_feature(p_company, 'fx_settlement');
  perform public.assert_actor(p_user, p_company, 'fx.revalue', null);
  if not public.claim_operation(p_idem, op, null) then
    select id into rv_id from public.fx_revaluations where company_id = p_company and revaluation_date = p_date and status = 'posted';
    return rv_id;
  end if;
  perform public.assert_period_open(p_company, p_date);
  perform pg_advisory_xact_lock(hashtext('fx_revaluation:' || p_company));
  if exists (select 1 from public.fx_revaluations where company_id=p_company and revaluation_date=p_date and status='posted') then
    raise exception 'A revaluation already exists for %', to_char(p_date,'DD/MM/YYYY') using errcode='P0001';
  end if;
  if jsonb_typeof(p_rates) <> 'array' then raise exception 'Closing rates are required' using errcode='P0001'; end if;
  for rr in select * from jsonb_array_elements(p_rates) loop
    cur := rr->>'currency'; rate := (rr->>'rate')::numeric; src := coalesce(rr->>'source','manual');
    if cur is null or cur = 'TZS' or not exists (select 1 from public.currencies where code = cur) then
      raise exception 'Invalid revaluation currency %', coalesce(cur,'(none)') using errcode='P0001'; end if;
    if rate is null or rate <= 0 or rate <> round(rate, 6) then raise exception 'Closing rate for % must be positive (max 6 decimals)', cur using errcode='P0001'; end if;
    if src = 'rate_table' and rate <> public.exchange_rate_on(p_company, cur, p_date) then
      raise exception 'Closing rate for % does not match the exchange-rate table', cur using errcode='P0001'; end if;
  end loop;

  -- Every open foreign balance must get a rate.
  select string_agg(distinct x.currency_code, ', ') into missing from (
    select p.currency_code from public.supplier_payables p join public.purchases pu on pu.id = p.purchase_id
      where p.company_id=p_company and p.currency_code<>'TZS' and p.status in ('open','partial') and p.fc_outstanding > 0 and pu.document_date <= p_date
    union select c.currency_code from public.supplier_credits c
      where c.company_id=p_company and c.currency_code<>'TZS' and c.status='open' and c.fc_remaining > 0 and c.credit_date <= p_date
  ) x where not exists (select 1 from jsonb_array_elements(p_rates) e where e->>'currency' = x.currency_code);
  if missing is not null then raise exception 'Closing rate missing for %', missing using errcode='P0001'; end if;
  if exists (select 1 from public.supplier_payable_events ev join public.supplier_payables p on p.id = ev.payable_id
             where p.company_id=p_company and p.currency_code<>'TZS' and ev.event_date > p_date and ev.event_type <> 'invoice_void') then
    raise exception 'Foreign transactions dated after % exist; revalue in date order', to_char(p_date,'DD/MM/YYYY') using errcode='P0001';
  end if;

  docnum := public.next_document_number(p_company, null, 'fx_revaluation');
  insert into public.fx_revaluations(company_id, document_number, revaluation_date, created_by)
    values (p_company, docnum, p_date, p_user) returning id into rv_id;
  insert into public.fx_revaluation_rates(company_id, revaluation_id, currency_code, closing_rate, rate_source, rate_reference)
    select p_company, rv_id, e->>'currency', (e->>'rate')::numeric, coalesce(e->>'source','manual'), e->>'reference'
    from jsonb_array_elements(p_rates) e;

  for pb in select p.* from public.supplier_payables p join public.purchases pu on pu.id = p.purchase_id
            where p.company_id=p_company and p.currency_code<>'TZS' and p.status in ('open','partial')
              and p.fc_outstanding > 0 and pu.document_date <= p_date order by p.id for update of p loop
    select (e->>'rate')::numeric into rate from jsonb_array_elements(p_rates) e where e->>'currency' = pb.currency_code;
    new_c := round(pb.fc_outstanding * rate, 2); diff := new_c - pb.outstanding;
    if diff = 0 then continue; end if;
    insert into public.fx_revaluation_lines(company_id, revaluation_id, payable_id, currency_code, fc_balance, carrying_before, carrying_after, difference)
      values (p_company, rv_id, pb.id, pb.currency_code, pb.fc_outstanding, pb.outstanding, new_c, diff);
    update public.supplier_payables set outstanding = new_c where id = pb.id returning * into pb;
    perform public._payable_event(pb, 'revaluation', 'fx_revaluation', rv_id, p_date, 0, diff);
    perform public.recalc_purchase(pb.purchase_id);
    if diff > 0 then pay_up := pay_up + diff; else pay_down := pay_down - diff; end if;
  end loop;

  for cr in select * from public.supplier_credits c
            where c.company_id=p_company and c.currency_code<>'TZS' and c.status='open' and c.fc_remaining > 0
              and c.credit_date <= p_date order by c.id for update loop
    select (e->>'rate')::numeric into rate from jsonb_array_elements(p_rates) e where e->>'currency' = cr.currency_code;
    new_c := round(cr.fc_remaining * rate, 2); diff := new_c - cr.remaining;
    if diff = 0 then continue; end if;
    insert into public.fx_revaluation_lines(company_id, revaluation_id, credit_id, currency_code, fc_balance, carrying_before, carrying_after, difference)
      values (p_company, rv_id, cr.id, cr.currency_code, cr.fc_remaining, cr.remaining, new_c, diff);
    update public.supplier_credits set remaining = new_c where id = cr.id;
    if diff > 0 then cred_up := cred_up + diff; else cred_down := cred_down - diff; end if;
  end loop;

  if pay_up > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(p_company,'2110'),'debit',0,'credit',pay_up,'memo','Payables revalued up'); end if;
  if pay_down > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(p_company,'2110'),'debit',pay_down,'credit',0,'memo','Payables revalued down'); end if;
  if cred_up > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(p_company,'1170'),'debit',cred_up,'credit',0,'memo','Supplier credits revalued up'); end if;
  if cred_down > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(p_company,'1170'),'debit',0,'credit',cred_down,'memo','Supplier credits revalued down'); end if;
  if pay_up + cred_down > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(p_company,'fx.unrealised_loss'),'debit',pay_up + cred_down,'credit',0,'memo','Unrealised FX loss'); end if;
  if pay_down + cred_up > 0 then jlines := jlines || jsonb_build_object('account_id', public.account_for(p_company,'fx.unrealised_gain'),'debit',0,'credit',pay_down + cred_up,'memo','Unrealised FX gain'); end if;
  if jsonb_array_length(jlines) > 0 then
    perform public.create_journal(p_company, null, p_date, 'fx_revaluation', rv_id, docnum, 'FX revaluation '||docnum, p_user, jlines);
  end if;
  update public.fx_revaluations set total_loss = pay_up + cred_down, total_gain = pay_down + cred_up where id = rv_id;
  return rv_id;
end; $$;

create or replace function public.void_fx_revaluation(p_id uuid, p_user uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare rv public.fx_revaluations; l record; pb public.supplier_payables; jl record; jlines jsonb := '[]'::jsonb; j uuid;
begin
  select * into rv from public.fx_revaluations where id=p_id for update;
  if not found then raise exception 'Revaluation not found' using errcode='P0001'; end if;
  if rv.status <> 'posted' then raise exception 'Revaluation already %', rv.status using errcode='P0001'; end if;
  if coalesce(p_reason,'')='' then raise exception 'A reason is required' using errcode='P0001'; end if;
  perform public.assert_actor(p_user, rv.company_id, 'fx.revalue', null);
  perform public.assert_period_open(rv.company_id, rv.revaluation_date);
  for l in select * from public.fx_revaluation_lines where revaluation_id=p_id order by payable_id nulls last, credit_id loop
    if l.payable_id is not null then
      if exists (select 1 from public.supplier_payable_events where payable_id=l.payable_id and created_at > rv.created_at and source_id <> p_id) then
        raise exception 'Later transactions exist on revalued invoices; reverse them first' using errcode='P0001';
      end if;
      update public.supplier_payables set outstanding = outstanding - l.difference where id = l.payable_id returning * into pb;
      perform public._payable_event(pb, 'revaluation_void', 'fx_revaluation', p_id, rv.revaluation_date, 0, -l.difference);
      perform public.recalc_purchase(pb.purchase_id);
    else
      if exists (select 1 from public.supplier_credit_applications where credit_id=l.credit_id and created_at > rv.created_at) then
        raise exception 'A revalued supplier credit was applied afterwards; reverse that first' using errcode='P0001';
      end if;
      update public.supplier_credits set remaining = remaining - l.difference where id = l.credit_id;
    end if;
  end loop;
  select id into j from public.journal_entries where source_type='fx_revaluation' and source_id=p_id limit 1;
  if j is not null then
    for jl in select account_id, sum(debit) d, sum(credit) c from public.journal_lines where journal_id=j group by account_id loop
      jlines := jlines || jsonb_build_object('account_id', jl.account_id, 'debit', jl.c, 'credit', jl.d);
    end loop;
    perform public.create_journal(rv.company_id, null, rv.revaluation_date, 'fx_revaluation_void', p_id, rv.document_number,
      'Void FX revaluation '||rv.document_number, p_user, jlines);
  end if;
  update public.fx_revaluations set status='voided', voided_by=p_user, voided_at=now(), void_reason=p_reason where id=p_id;
  return p_id;
end; $$;

-- ===========================================================================
-- 8. Company defaults v3, RLS, grants.
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = '_ensure_company_defaults_0025') then
    alter function public.ensure_company_defaults(uuid) rename to _ensure_company_defaults_0025;
  end if;
end $$;
create or replace function public.ensure_company_defaults(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._ensure_company_defaults_0025(p_company);
  perform public._ensure_doc_sequence(p_company, 'fx_revaluation', 'FXR');
  perform public._ensure_doc_sequence(p_company, 'supplier_credit_application', 'SCA');
end; $$;

do $$
declare t text;
begin
  foreach t in array array['supplier_advances','purchase_advance_applications','supplier_credit_applications',
    'supplier_payable_events','fx_revaluations','fx_revaluation_rates','fx_revaluation_lines'] loop
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

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             '_is_replay','_require_key','_carry_share','_last_revaluation','_payable_event','_assert_no_later_payable_events',
             'record_stock_movement_value','post_purchase','recalc_purchase','void_purchase','post_supplier_payment',
             'void_supplier_payment','post_purchase_return','void_purchase_return','apply_supplier_credit',
             'post_fx_revaluation','void_fx_revaluation','ensure_company_defaults','_ensure_company_defaults_0025',
             'purchases_freeze_posted','purchase_children_freeze_posted') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

do $$
declare c record;
begin
  for c in select id from public.companies loop
    perform public.ensure_company_defaults(c.id);
  end loop;
end $$;
