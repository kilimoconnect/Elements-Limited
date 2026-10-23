-- =========================================================================
-- Elements ERP - Migration 0037: Sales promotions (free goods)
--
-- "Buy N of a product, get M of the same product free." Defined by the admin
-- per product with a minimum quantity bought in one order, the free quantity,
-- whether it repeats for every full multiple, and whether the free goods go
-- in the same order or are earned for the customer's next order.
--
-- Free goods are ordinary sale lines at price 0 (is_free), so they leave
-- stock and their cost lands in cost of sales when the sale posts. A
-- next-order reward is a promotion_rewards row: earned when the qualifying
-- sale posts, used (redeemed) when a later sale that carries it posts.
-- Walk-in customers never qualify (enforced in the server actions).
-- =========================================================================

create table if not exists public.sales_promotions (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete restrict,
  name                text not null check (length(trim(name)) between 1 and 120),
  product_id          uuid not null references public.products(id) on delete restrict,
  min_quantity        numeric(18,4) not null check (min_quantity > 0),
  free_quantity       numeric(18,4) not null check (free_quantity > 0),
  repeat_per_multiple boolean not null default true,
  reward_timing       text not null default 'current_order' check (reward_timing in ('current_order','next_order')),
  starts_on           date not null default current_date,
  ends_on             date,
  is_active           boolean not null default true,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);
create index if not exists sales_promotions_lookup_idx on public.sales_promotions(company_id, product_id) where is_active;

create table if not exists public.promotion_rewards (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  promotion_id     uuid not null references public.sales_promotions(id) on delete restrict,
  customer_id      uuid not null references public.customers(id) on delete restrict,
  product_id       uuid not null references public.products(id) on delete restrict,
  quantity         numeric(18,4) not null check (quantity > 0),
  earned_sale_id   uuid not null references public.sales(id) on delete restrict,
  status           text not null default 'available' check (status in ('available','redeemed','cancelled')),
  redeemed_sale_id uuid references public.sales(id) on delete set null,
  redeemed_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (promotion_id, earned_sale_id)
);
create index if not exists promotion_rewards_customer_idx on public.promotion_rewards(company_id, customer_id) where status = 'available';

alter table public.sale_lines
  add column if not exists is_free             boolean not null default false,
  add column if not exists promotion_id        uuid references public.sales_promotions(id) on delete set null,
  add column if not exists promotion_reward_id uuid references public.promotion_rewards(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sale_lines_free_is_zero') then
    alter table public.sale_lines add constraint sale_lines_free_is_zero
      check (not is_free or (unit_price = 0 and discount = 0));
  end if;
end $$;

drop trigger if exists trg_sales_promotions_updated on public.sales_promotions;
create trigger trg_sales_promotions_updated before update on public.sales_promotions
  for each row execute function public.set_updated_at();

-- Reads by company access; every write goes through service-role server actions.
do $$
declare t text;
begin
  foreach t in array array['sales_promotions','promotion_rewards'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_company_access(company_id))', t||'_select', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
