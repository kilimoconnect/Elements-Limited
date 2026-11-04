-- =========================================================================
-- Elements ERP - Migration 0043: the Owner can delete attachments
--
-- Deleting removes the attachment record for good (the app then removes the
-- file from storage); the audit log keeps who deleted what, when and why.
-- Records stay protected otherwise: they can never be edited, and they can
-- only be removed through delete_attachment, which only the Owner may use.
-- A version that a newer upload replaced cannot be removed on its own; the
-- newest version is deleted first.
-- =========================================================================

create or replace function public.document_attachments_guard()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' and current_setting('elements.attachment_delete', true) = 'on' then
    return old;
  end if;
  raise exception 'document_attachments rows cannot be changed or deleted' using errcode = '0A000';
end; $$;

drop trigger if exists trg_document_attachments_immutable on public.document_attachments;
create trigger trg_document_attachments_immutable before update or delete on public.document_attachments
  for each row execute function public.document_attachments_guard();

-- Owner-only permanent delete with a reason; returns the storage path so the
-- caller can remove the file.
create or replace function public.delete_attachment(p_user uuid, p_attachment uuid, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare a public.document_attachments;
begin
  if not public._user_is_owner(p_user) then
    raise exception 'Only the Owner can delete attachments' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '23514';
  end if;
  select * into a from public.document_attachments where id = p_attachment for update;
  if not found then raise exception 'Attachment not found' using errcode = 'P0001'; end if;
  if exists (select 1 from public.document_attachments where supersedes_id = p_attachment) then
    raise exception 'A newer version of this file exists; delete the newer version first' using errcode = 'P0001';
  end if;
  perform set_config('elements.attachment_delete', 'on', true);
  delete from public.document_attachments where id = p_attachment;
  perform set_config('elements.attachment_delete', 'off', true);
  return a.storage_path;
end; $$;

revoke all on function public.delete_attachment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.delete_attachment(uuid, uuid, text) to service_role;
revoke all on function public.document_attachments_guard() from public, anon, authenticated;
