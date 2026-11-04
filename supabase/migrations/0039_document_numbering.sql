-- =========================================================================
-- Elements ERP - Migration 0039: Document numbering PREFIX-YY-NNNNNN
--
-- Every document number becomes prefix, two-digit year and a six-digit
-- running number, e.g. STR-26-000001, GRN-26-000001, INV-26-000001: up to
-- 999,999 per document type per year. The counter starts again at 000001
-- each new year (Africa/Dar_es_Salaam). reset_frequency is now honoured:
-- yearly (default) YY, monthly YYMM, daily YYMMDD, never no period part.
--
-- Import receipts move from "GRN" to "IGR" so they no longer clash with the
-- Goods Received Notes Head Office issues on transfers.
--
-- Numbers already issued keep their old form (e.g. STR00001); new ones use
-- the new form, which can never collide with an old number.
-- =========================================================================

alter table public.document_sequences add column if not exists period_key text;

-- All sequences: six digits, yearly; the period is set on the next number.
update public.document_sequences set number_length = 6, reset_frequency = 'yearly', period_key = null, updated_at = now();
update public.document_sequences set prefix = 'IGR', updated_at = now() where document_type = 'import_receipt' and prefix = 'GRN';

create or replace function public.next_document_number(
  p_company uuid, p_branch uuid, p_doc_type text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  seq public.document_sequences;
  today date := (now() at time zone 'Africa/Dar_es_Salaam')::date;
  key text;
  n bigint;
begin
  select * into seq from public.document_sequences
    where company_id = p_company
      and document_type = p_doc_type
      and (branch_id = p_branch or branch_id is null)
      and is_active
    order by branch_id nulls last
    limit 1
    for update;
  if not found then
    raise exception 'No active document sequence for % in this company', p_doc_type
      using errcode = 'P0001';
  end if;
  key := case seq.reset_frequency
           when 'yearly'  then to_char(today, 'YY')
           when 'monthly' then to_char(today, 'YYMM')
           when 'daily'   then to_char(today, 'YYMMDD')
           else '' end;
  -- A new period starts the count again.
  n := case when coalesce(seq.period_key, '') = key then seq.current_number + 1 else 1 end;
  update public.document_sequences set current_number = n, period_key = key, updated_at = now()
    where id = seq.id;
  return seq.prefix || '-' || case when key = '' then '' else key || '-' end || lpad(n::text, greatest(seq.number_length, 1), '0');
end; $$;

-- New companies get the same format (and IGR for import receipts).
create or replace function public._ensure_doc_sequence(p_company uuid, p_type text, p_prefix text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.document_sequences
                  where company_id = p_company and document_type = p_type and branch_id is null) then
    insert into public.document_sequences(company_id, document_type, prefix, current_number, number_length, reset_frequency)
      values (p_company, p_type, case when p_type = 'import_receipt' then 'IGR' else p_prefix end, 0, 6, 'yearly');
  end if;
end; $$;

revoke all on function public.next_document_number(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.next_document_number(uuid, uuid, text) to service_role;
revoke all on function public._ensure_doc_sequence(uuid, text, text) from public, anon, authenticated;
grant execute on function public._ensure_doc_sequence(uuid, text, text) to service_role;
