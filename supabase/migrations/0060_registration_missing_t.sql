-- =========================================================================
-- Elements ERP - Migration 0060: a Tanzanian plate typed without its T
-- (3 digits + 3 letters, e.g. "426 EQN") is saved with it: T426EQN.
-- Other formats (other countries) are unchanged. Saved records corrected.
-- =========================================================================

create or replace function public.normalise_registration(p text)
returns text language sql immutable as $$
  -- Letters and digits only (any country: UAA123A, KBZ123A, RAB123A, ABC1234, AAA123MC...).
  -- Tanzanian plates (T + 3 digits + 3 letters): a doubled T counts once, a missing T is added.
  select nullif(regexp_replace(regexp_replace(
           regexp_replace(upper(normalize(coalesce(p, ''), NFKC)), '[^A-Z0-9]', '', 'g'),
           '^T+([0-9]{3}[A-Z]{3})$', 'T\1'),
           '^([0-9]{3}[A-Z]{3})$', 'T\1'), '');
$$;

update public.stock_transfers set vehicle_registration = vehicle_registration, trailer_registration = trailer_registration
 where vehicle_registration is distinct from public.normalise_registration(vehicle_registration)
    or trailer_registration is distinct from public.normalise_registration(trailer_registration);
update public.stock_transfer_dispatches set vehicle_registration = vehicle_registration, trailer_registration = trailer_registration
 where vehicle_registration is distinct from public.normalise_registration(vehicle_registration)
    or trailer_registration is distinct from public.normalise_registration(trailer_registration);
update public.sales_shipments set vehicle_registration = vehicle_registration, trailer_registration = trailer_registration
 where vehicle_registration is distinct from public.normalise_registration(vehicle_registration)
    or trailer_registration is distinct from public.normalise_registration(trailer_registration);
