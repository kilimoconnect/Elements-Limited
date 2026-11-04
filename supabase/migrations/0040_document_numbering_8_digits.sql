-- =========================================================================
-- Elements ERP - Migration 0040: eight-digit document numbers
--
-- PREFIX-YY-NNNNNNNN, e.g. STR-26-00000001: up to 99,999,999 per document
-- type per year. The running count continues; only the padding changes, so
-- a new number can never repeat one already issued.
-- =========================================================================

update public.document_sequences set number_length = 8, updated_at = now();

create or replace function public._ensure_doc_sequence(p_company uuid, p_type text, p_prefix text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.document_sequences
                  where company_id = p_company and document_type = p_type and branch_id is null) then
    insert into public.document_sequences(company_id, document_type, prefix, current_number, number_length, reset_frequency)
      values (p_company, p_type, case when p_type = 'import_receipt' then 'IGR' else p_prefix end, 0, 8, 'yearly');
  end if;
end; $$;

revoke all on function public._ensure_doc_sequence(uuid, text, text) from public, anon, authenticated;
grant execute on function public._ensure_doc_sequence(uuid, text, text) to service_role;
