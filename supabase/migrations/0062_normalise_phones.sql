-- =========================================================================
-- Elements ERP - Migration 0062: phone numbers are saved in one standard form.
--   "0687 322 677", "+255 687 322 677", "255687322677", "687322677"  ->  "0687322677"
--   "+254 712 345 678", "00254712345678", "254712345678"            ->  "+254712345678"
-- Tanzanian numbers: 0 + 9 digits. Other countries: + and the country code.
-- Several numbers in one field are each corrected, separated by " / ".
-- Applied on every insert / update (all screens and functions) and in the
-- trip change log; existing rows are corrected. Same rules as src/lib/phone.ts.
-- =========================================================================

create or replace function public._normalise_phone_one(p text)
returns text language plpgsql immutable as $$
declare
  t text := btrim(coalesce(p, ''));
  intl boolean := t ~ '^(\+|00)';
  d text := regexp_replace(t, '\D', '', 'g');
begin
  if d = '' then return ''; end if;
  if t like '00%' then d := substr(d, 3); end if;
  if d like '2550%' and length(d) = 13 then return '0' || substr(d, 5); end if;
  if d like '255%' and length(d) = 12 then return '0' || substr(d, 4); end if;
  if intl then return '+' || d; end if;
  if length(d) = 9 and left(d, 1) <> '0' then return '0' || d; end if;
  if length(d) >= 11 and left(d, 1) <> '0' then return '+' || d; end if;
  return d;
end; $$;

create or replace function public.normalise_phone(p text)
returns text language sql immutable as $$
  -- null stays null; text with no digits becomes ''.
  select case when p is null then null else coalesce((
    select string_agg(x, ' / ' order by n)
      from (select public._normalise_phone_one(part) x, n
              from regexp_split_to_table(btrim(normalize(p, NFKC)), '\s*([/,;&]|\mor\M|\mand\M)\s*', 'i') with ordinality as s(part, n)) q
     where x <> ''), '') end;
$$;

-- Trigger: the phone columns named in the trigger arguments are corrected.
create or replace function public._normalise_phone_columns()
returns trigger language plpgsql as $$
declare c text; patch jsonb := '{}'::jsonb; rec jsonb := to_jsonb(new);
begin
  foreach c in array tg_argv loop
    if rec ? c and rec->>c is not null then
      patch := patch || jsonb_build_object(c, public.normalise_phone(rec->>c));
    end if;
  end loop;
  if patch <> '{}'::jsonb then new := jsonb_populate_record(new, patch); end if;
  return new;
end; $$;

do $$
declare r record;
begin
  for r in select * from (values
    ('branches', array['phone']), ('companies', array['phone']), ('customers', array['phone']), ('suppliers', array['phone']),
    ('drivers', array['phone']), ('user_profiles', array['phone']), ('stock_transfer_agents', array['phone']),
    ('stock_transfers', array['driver_phone', 'agent_phone']), ('stock_transfer_dispatches', array['driver_phone']),
    ('sales_requests', array['contact_phone', 'consignee_phone']), ('sales_orders', array['contact_phone', 'consignee_phone']),
    ('sales_shipments', array['driver_phone', 'collector_phone', 'consignee_phone', 'recipient_phone'])) v(tbl, cols)
  loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    execute format('drop trigger if exists trg_normalise_phone on public.%I', r.tbl);
    execute format('create trigger trg_normalise_phone before insert or update of %s on public.%I
      for each row execute function public._normalise_phone_columns(%s)',
      (select string_agg(quote_ident(c), ', ') from unnest(r.cols) c), r.tbl,
      (select string_agg(quote_literal(c), ', ') from unnest(r.cols) c));
    -- Correct what is already saved.
    execute format('update public.%I set %s where %s', r.tbl,
      (select string_agg(format('%1$I = public.normalise_phone(%1$I)', c), ', ') from unnest(r.cols) c),
      (select string_agg(format('%1$I is distinct from public.normalise_phone(%1$I)', c), ' or ') from unnest(r.cols) c));
  end loop;
end $$;

-- Trip change log: the new phone is recorded as it will be stored.
create or replace function public._normalise_registration_change()
returns trigger language plpgsql as $$
declare k text;
begin
  foreach k in array array['vehicle_registration', 'trailer_registration'] loop
    if new.new_values ? k then
      new.new_values := jsonb_set(new.new_values, array[k], coalesce(to_jsonb(public.normalise_registration(new.new_values->>k)), 'null'::jsonb));
    end if;
  end loop;
  if new.new_values ? 'driver_phone' and new.new_values->>'driver_phone' is not null then
    new.new_values := jsonb_set(new.new_values, array['driver_phone'], to_jsonb(public.normalise_phone(new.new_values->>'driver_phone')));
  end if;
  return new;
end; $$;

revoke all on function public._normalise_phone_columns() from public, anon, authenticated;
revoke all on function public._normalise_registration_change() from public, anon, authenticated;
