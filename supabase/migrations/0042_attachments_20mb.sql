-- =========================================================================
-- Elements ERP - Migration 0042: attachments up to 20 MB
--
-- Files now upload straight from the browser to the private "documents"
-- bucket through a one-time signed upload link; the server then checks the
-- stored file (type, magic bytes, size, hash) before registering it. The
-- bucket and the metadata table both allow up to 20 MB per file.
-- =========================================================================

do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.document_attachments'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%size_bytes%' loop
    execute format('alter table public.document_attachments drop constraint %I', c.conname);
  end loop;
  alter table public.document_attachments add constraint document_attachments_size_20mb
    check (size_bytes > 0 and size_bytes <= 20971520);

  if to_regclass('storage.buckets') is not null then
    update storage.buckets set file_size_limit = 20971520 where id = 'documents';
  end if;
end $$;
