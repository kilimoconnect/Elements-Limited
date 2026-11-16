-- =========================================================================
-- Elements ERP - Migration 0065: transfer type on transfer orders.
-- An order is a Branch transfer (default) or an Import (goods of an import
-- moved to a branch). Existing transfers are Branch transfers.
-- =========================================================================

alter table public.stock_transfers add column if not exists transfer_type text not null default 'branch';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_transfers_transfer_type_check') then
    alter table public.stock_transfers add constraint stock_transfers_transfer_type_check check (transfer_type in ('branch', 'import'));
  end if;
end $$;
