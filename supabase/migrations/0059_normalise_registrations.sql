-- =========================================================================
-- Elements ERP - Migration 0059: truck and trailer registrations are saved
-- in one standard form: capitals, letters and digits only.
--   "T. 760DWG", "T 760 DWG", "t-760-dwg", "T. T 760 DWG"  ->  "T760DWG"
-- Applied on every insert / update (all screens and functions), for stock
-- transfers, transfer trips and sales trucks, and in the trip change log.
-- Existing rows are corrected too (issued document versions keep what was
-- printed; the next delivery-note download shows the corrected registration).
-- =========================================================================

create or replace function public.normalise_registration(p text)
returns text language sql immutable as $$
  -- Letters and digits only (any country: UAA123A, KBZ123A, RAB123A, ABC1234, AAA123MC...).
  -- A doubled T on a Tanzanian plate (T + 3 digits + 3 letters, "T T 760 DWG") counts once.
  select nullif(regexp_replace(regexp_replace(upper(normalize(coalesce(p, ''), NFKC)), '[^A-Z0-9]', '', 'g'), '^T+([0-9]{3}[A-Z]{3})$', 'T\1'), '');
$$;

create or replace function public._normalise_registration_columns()
returns trigger language plpgsql as $$
begin
  new.vehicle_registration := public.normalise_registration(new.vehicle_registration);
  new.trailer_registration := public.normalise_registration(new.trailer_registration);
  return new;
end; $$;

do $$
declare t text;
begin
  foreach t in array array['stock_transfers', 'stock_transfer_dispatches', 'sales_shipments'] loop
    execute format('drop trigger if exists trg_normalise_registration on public.%I', t);
    execute format('create trigger trg_normalise_registration before insert or update of vehicle_registration, trailer_registration on public.%I
      for each row execute function public._normalise_registration_columns()', t);
  end loop;
end $$;

-- Change log: the new registration is recorded as it will be stored.
create or replace function public._normalise_registration_change()
returns trigger language plpgsql as $$
declare k text;
begin
  foreach k in array array['vehicle_registration', 'trailer_registration'] loop
    if new.new_values ? k then
      new.new_values := jsonb_set(new.new_values, array[k], coalesce(to_jsonb(public.normalise_registration(new.new_values->>k)), 'null'::jsonb));
    end if;
  end loop;
  return new;
end; $$;
drop trigger if exists trg_normalise_registration_change on public.stock_transfer_dispatch_changes;
create trigger trg_normalise_registration_change before insert on public.stock_transfer_dispatch_changes
  for each row execute function public._normalise_registration_change();

revoke all on function public._normalise_registration_columns() from public, anon, authenticated;
revoke all on function public._normalise_registration_change() from public, anon, authenticated;

-- Correct what is already saved.
update public.stock_transfers set vehicle_registration = vehicle_registration, trailer_registration = trailer_registration
 where vehicle_registration is distinct from public.normalise_registration(vehicle_registration)
    or trailer_registration is distinct from public.normalise_registration(trailer_registration);
update public.stock_transfer_dispatches set vehicle_registration = vehicle_registration, trailer_registration = trailer_registration
 where vehicle_registration is distinct from public.normalise_registration(vehicle_registration)
    or trailer_registration is distinct from public.normalise_registration(trailer_registration);
update public.sales_shipments set vehicle_registration = vehicle_registration, trailer_registration = trailer_registration
 where vehicle_registration is distinct from public.normalise_registration(vehicle_registration)
    or trailer_registration is distinct from public.normalise_registration(trailer_registration);
