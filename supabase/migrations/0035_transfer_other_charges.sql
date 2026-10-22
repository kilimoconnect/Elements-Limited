-- 0035_transfer_other_charges.sql
-- Additive. The New Transfer and receiving screens offer only charge types
-- that go into inventory cost. Loading / offloading (LOADING), branch
-- transport (TRANSPORT) and inland transport (INLAND) existed; this adds a
-- capitalised catch-all for any other fee on a transfer (road tolls, permits,
-- escort, weighbridge ...). Like every default category it can be edited in
-- Admin -> Cost Categories.

create or replace function public._ensure_transfer_other_category(p_company uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.cost_categories(company_id, code, name, description, inventory_treatment, expense_account_id,
      include_in_commercial_cost, allocation_basis, applies_to_import, applies_to_transfer, applies_to_rebagging,
      is_goods_value, is_system)
  values (p_company, 'TRF_OTHER', 'Other transfer charges',
      'Any other fee for moving goods between branches (tolls, permits, escort, weighbridge); added to the cost of the goods.',
      'capitalize', null, true, 'net_weight', false, true, false, false, true)
  on conflict (company_id, code) do nothing;
end; $$;
revoke all on function public._ensure_transfer_other_category(uuid) from public, anon, authenticated;

-- existing companies
select public._ensure_transfer_other_category(id) from public.companies;

-- companies created later
create or replace function public.companies_transfer_other_category()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._ensure_transfer_other_category(NEW.id);
  return NEW;
end; $$;
revoke all on function public.companies_transfer_other_category() from public, anon, authenticated;
drop trigger if exists trg_companies_transfer_other_category on public.companies;
create trigger trg_companies_transfer_other_category after insert on public.companies
  for each row execute function public.companies_transfer_other_category();
