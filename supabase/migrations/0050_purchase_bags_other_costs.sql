-- =========================================================================
-- Elements ERP - Migration 0050: landed-cost categories "Bags" and "Other"
-- for purchases. Both are capitalised: like every capitalised cost they reach
-- the purchased goods wherever they are now (in stock, sold -> cost of sales,
-- transferred to another branch, in transit, rebagged). Editable in
-- Admin -> Cost Categories.
-- =========================================================================

create or replace function public._ensure_purchase_extra_categories(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.cost_categories(company_id, code, name, description, inventory_treatment, expense_account_id,
      include_in_commercial_cost, allocation_basis, applies_to_import, applies_to_transfer, applies_to_rebagging,
      is_goods_value, is_system)
  values
    (p_company, 'BAGS', 'Bags and packaging',
      'Empty bags, sacks or packaging bought for these goods; added to the cost of the goods.',
      'capitalize', null, true, 'quantity', true, false, true, false, true),
    (p_company, 'PUR_OTHER', 'Other purchase costs',
      'Any other cost of getting these goods (fees, tolls, permits, sampling); added to the cost of the goods.',
      'capitalize', null, true, 'value', true, false, false, false, true)
  on conflict (company_id, code) do nothing;
end; $$;
revoke all on function public._ensure_purchase_extra_categories(uuid) from public, anon, authenticated;

-- existing companies
select public._ensure_purchase_extra_categories(id) from public.companies;

-- companies created later
create or replace function public.companies_purchase_extra_categories()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._ensure_purchase_extra_categories(NEW.id);
  return NEW;
end; $$;
revoke all on function public.companies_purchase_extra_categories() from public, anon, authenticated;
drop trigger if exists trg_companies_purchase_extra_categories on public.companies;
create trigger trg_companies_purchase_extra_categories after insert on public.companies
  for each row execute function public.companies_purchase_extra_categories();
