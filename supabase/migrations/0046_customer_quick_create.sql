-- =========================================================================
-- Elements ERP - Migration 0046: Sales Officers create customers from the
-- Sales Request form, without creating the same customer twice.
--
-- A customer is a duplicate when, within the company, it has the same name
-- (ignoring case and spaces), the same phone (last 9 digits), the same TIN
-- (digits) or the same email. Unique indexes enforce this for every path
-- (Admin screens included), and create_customer_quick explains which
-- existing customer matched.
-- =========================================================================

create or replace function public._customer_key_name(p text) returns text language sql immutable as $$
  select nullif(lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')), '');
$$;
create or replace function public._customer_key_phone(p text) returns text language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 9), '');
$$;
create or replace function public._customer_key_tin(p text) returns text language sql immutable as $$
  select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '');
$$;
create or replace function public._customer_key_email(p text) returns text language sql immutable as $$
  select nullif(lower(btrim(coalesce(p, ''))), '');
$$;

create unique index if not exists customers_unique_name on public.customers(company_id, public._customer_key_name(name));
create unique index if not exists customers_unique_phone on public.customers(company_id, public._customer_key_phone(phone))
  where public._customer_key_phone(phone) is not null and length(public._customer_key_phone(phone)) >= 7;
create unique index if not exists customers_unique_tin on public.customers(company_id, public._customer_key_tin(tin))
  where public._customer_key_tin(tin) is not null;
create unique index if not exists customers_unique_email on public.customers(company_id, public._customer_key_email(email))
  where public._customer_key_email(email) is not null;

create or replace function public.create_customer_quick(p_company uuid, p_branch uuid, p_user uuid, p_name text, p_phone text,
  p_email text, p_tin text, p_vat text, p_address text, p_type text)
returns uuid language plpgsql security definer set search_path = public as $$
declare dup record; n int; code text; cid uuid; ph text := public._customer_key_phone(p_phone);
begin
  perform public.assert_actor(p_user, p_company, 'sales.create', p_branch);
  if public._customer_key_name(p_name) is null then raise exception 'Enter the customer name' using errcode = '23514'; end if;
  if ph is null or length(ph) < 7 then raise exception 'Enter the customer phone number' using errcode = '23514'; end if;
  -- One creation at a time per company, so two officers cannot add the same customer together.
  perform pg_advisory_xact_lock(hashtext('customer_create:' || p_company::text));

  select c.code, c.name, case
      when public._customer_key_name(c.name) = public._customer_key_name(p_name) then 'name'
      when public._customer_key_phone(c.phone) = ph then 'phone ' || c.phone
      when public._customer_key_tin(c.tin) = public._customer_key_tin(p_tin) then 'TIN ' || c.tin
      else 'email ' || c.email end as why
    into dup
    from public.customers c
   where c.company_id = p_company and (
         public._customer_key_name(c.name) = public._customer_key_name(p_name)
      or public._customer_key_phone(c.phone) = ph
      or (public._customer_key_tin(p_tin) is not null and public._customer_key_tin(c.tin) = public._customer_key_tin(p_tin))
      or (public._customer_key_email(p_email) is not null and public._customer_key_email(c.email) = public._customer_key_email(p_email)))
   limit 1;
  if dup.code is not null then
    raise exception 'This customer already exists: % — % (same %). Select it from the list.', dup.code, dup.name, dup.why using errcode = '23505';
  end if;

  select coalesce(max((regexp_match(c.code, '^CUST-(\d+)$'))[1]::int), 0) + 1 into n from public.customers c where c.company_id = p_company;
  code := 'CUST-' || lpad(n::text, 4, '0');
  insert into public.customers(company_id, code, name, customer_type, phone, email, tin, vat_number, address, created_by, updated_by)
    values (p_company, code, regexp_replace(btrim(p_name), '\s+', ' ', 'g'), nullif(btrim(coalesce(p_type, '')), ''), btrim(p_phone),
      nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_tin, '')), ''), nullif(btrim(coalesce(p_vat, '')), ''),
      nullif(btrim(coalesce(p_address, '')), ''), p_user, p_user)
    returning id into cid;
  return cid;
end; $$;

revoke all on function public.create_customer_quick(uuid, uuid, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_customer_quick(uuid, uuid, uuid, text, text, text, text, text, text, text) to service_role;
