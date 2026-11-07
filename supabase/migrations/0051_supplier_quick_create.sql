-- =========================================================================
-- Elements ERP - Migration 0051: create a supplier from the purchase and
-- landed-cost screens, without creating the same supplier twice.
--
-- Same rule as customers (0046): within the company a supplier is a
-- duplicate when it has the same name (ignoring case and spaces), phone
-- (last 9 digits), TIN (digits) or email. Unique indexes enforce this for
-- every path, Admin included.
-- =========================================================================

create unique index if not exists suppliers_unique_name on public.suppliers(company_id, public._customer_key_name(name));
create unique index if not exists suppliers_unique_phone on public.suppliers(company_id, public._customer_key_phone(phone))
  where public._customer_key_phone(phone) is not null and length(public._customer_key_phone(phone)) >= 7;
create unique index if not exists suppliers_unique_tin on public.suppliers(company_id, public._customer_key_tin(tin))
  where public._customer_key_tin(tin) is not null;
create unique index if not exists suppliers_unique_email on public.suppliers(company_id, public._customer_key_email(email))
  where public._customer_key_email(email) is not null;

create or replace function public.create_supplier_quick(p_company uuid, p_branch uuid, p_user uuid, p_name text, p_phone text,
  p_email text, p_tin text, p_vat text, p_address text, p_contact text, p_terms integer)
returns uuid language plpgsql security definer set search_path = public as $$
declare dup record; n int; code text; sid uuid; ph text := public._customer_key_phone(p_phone);
begin
  if not (public._user_can(p_user, 'purchases.create') or public._user_can(p_user, 'cost_invoices.post')) then
    raise exception 'You are not allowed to create suppliers' using errcode = '42501';
  end if;
  perform public.assert_actor(p_user, p_company, 'purchases.view', p_branch);
  if public._customer_key_name(p_name) is null then raise exception 'Enter the supplier name' using errcode = '23514'; end if;
  if coalesce(p_terms, 0) < 0 then raise exception 'Payment terms cannot be negative' using errcode = '23514'; end if;
  perform pg_advisory_xact_lock(hashtext('supplier_create:' || p_company::text));

  select s.code, s.name, case
      when public._customer_key_name(s.name) = public._customer_key_name(p_name) then 'name'
      when ph is not null and public._customer_key_phone(s.phone) = ph then 'phone ' || s.phone
      when public._customer_key_tin(s.tin) = public._customer_key_tin(p_tin) then 'TIN ' || s.tin
      else 'email ' || s.email end as why
    into dup
    from public.suppliers s
   where s.company_id = p_company and (
         public._customer_key_name(s.name) = public._customer_key_name(p_name)
      or (ph is not null and length(ph) >= 7 and public._customer_key_phone(s.phone) = ph)
      or (public._customer_key_tin(p_tin) is not null and public._customer_key_tin(s.tin) = public._customer_key_tin(p_tin))
      or (public._customer_key_email(p_email) is not null and public._customer_key_email(s.email) = public._customer_key_email(p_email)))
   limit 1;
  if dup.code is not null then
    raise exception 'This supplier already exists: % — % (same %). Select it from the list.', dup.code, dup.name, dup.why using errcode = '23505';
  end if;

  select coalesce(max((regexp_match(s.code, '^SUP-(\d+)$'))[1]::int), 0) + 1 into n from public.suppliers s where s.company_id = p_company;
  code := 'SUP-' || lpad(n::text, 4, '0');
  insert into public.suppliers(company_id, code, name, contact_person, phone, email, tin, vat_number, address, payment_terms_days, created_by, updated_by)
    values (p_company, code, regexp_replace(btrim(p_name), '\s+', ' ', 'g'), nullif(btrim(coalesce(p_contact, '')), ''),
      nullif(btrim(coalesce(p_phone, '')), ''), nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_tin, '')), ''),
      nullif(btrim(coalesce(p_vat, '')), ''), nullif(btrim(coalesce(p_address, '')), ''), coalesce(p_terms, 0), p_user, p_user)
    returning id into sid;
  return sid;
end; $$;

revoke all on function public.create_supplier_quick(uuid, uuid, uuid, text, text, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.create_supplier_quick(uuid, uuid, uuid, text, text, text, text, text, text, text, integer) to service_role;
