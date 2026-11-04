"use client";

import * as React from "react";
import { toast } from "sonner";
import { Download, Trash2, Upload } from "lucide-react";
import { listAttachmentsAction, attachmentDownloadAction, deleteAttachmentAction } from "@/lib/attachments/actions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { uploadAttachmentFile } from "@/lib/attachments/client-upload";
import { CATEGORY_LABEL, type AttachmentCategory, type OwnerType } from "@/lib/attachments/policy";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Row { id: string; category: string; download_name: string; size_bytes: number; version: number; supersedes_id: string | null; uploaded_at: string }

const LABEL: Record<string, string> = CATEGORY_LABEL;
const MAX_BYTES = 20 * 1024 * 1024;
/** Categories that normally hold several files (photos, payment proofs): never replace each other. */
const MULTI: AttachmentCategory[] = ["photo", "loading_photo", "offloading_photo", "proof_of_payment"];

/** Lists, uploads and downloads attachments of one record (private bucket, short-lived links). */
export function AttachmentsPanel({ ownerType, ownerId, categories }: { ownerType: OwnerType; ownerId: string; categories: AttachmentCategory[] }) {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [category, setCategory] = React.useState<AttachmentCategory>(categories[0]);
  const [files, setFiles] = React.useState<File[]>([]);
  const [canDelete, setCanDelete] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Row | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    const res = await listAttachmentsAction(ownerType, ownerId);
    if (res.ok) { setRows(res.data as Row[]); setCanDelete(res.canDelete); } else { setRows([]); setError(res.error); }
  }, [ownerType, ownerId]);
  React.useEffect(() => {
    let live = true;
    listAttachmentsAction(ownerType, ownerId).then((res) => {
      if (!live) return;
      if (res.ok) { setRows(res.data as Row[]); setCanDelete(res.canDelete); } else { setRows([]); setError(res.error); }
    });
    return () => { live = false; };
  }, [ownerType, ownerId]);

  const superseded = new Set((rows ?? []).map((r) => r.supersedes_id).filter(Boolean));
  async function upload() {
    if (files.length === 0) return;
    setError(null);
    const tooBig = files.filter((f) => f.size > MAX_BYTES);
    if (tooBig.length) { setError(`Too large (over 20 MB): ${tooBig.map((f) => f.name).join(", ")}.`); return; }
    setPending(true);
    // Several files (or photos) are added side by side; one document replaces the current one as a new version.
    const addAll = files.length > 1 || MULTI.includes(category);
    const latest = addAll ? undefined : (rows ?? []).filter((r) => r.category === category && !superseded.has(r.id)).sort((a, b) => b.version - a.version)[0];
    const failed: string[] = [];
    for (const f of files) {
      const res = await uploadAttachmentFile({ ownerType, ownerId, category, file: f, supersedesId: latest?.id ?? null });
      if (!res.ok) failed.push(`${f.name}: ${res.error}`);
    }
    setPending(false);
    const done = files.length - failed.length;
    if (done > 0) toast.success(latest ? `Uploaded version ${latest.version + 1}.` : done === 1 ? "Uploaded." : `Uploaded ${done} files.`);
    if (failed.length) setError(failed.join(" "));
    setFiles([]); if (inputRef.current) inputRef.current.value = "";
    void load();
  }
  async function download(id: string) {
    const res = await attachmentDownloadAction(id);
    if (res.ok) window.location.assign(res.data.url); else setError(res.error);
  }

  return (
    <div className="space-y-3 text-sm">
      {rows === null ? <p className="text-muted-foreground">Loading…</p> : rows.length === 0 ? <p className="text-muted-foreground">No attachments.</p> : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.id} className={`flex items-center justify-between gap-2 ${superseded.has(r.id) ? "opacity-60" : ""}`}>
              <span>{LABEL[r.category] ?? r.category} · {r.download_name} · v{r.version}{superseded.has(r.id) ? " (superseded)" : ""}
                <span className="text-xs text-muted-foreground"> · {formatDateTime(r.uploaded_at)} · {(r.size_bytes / 1024).toFixed(0)} KB</span></span>
              <span className="flex shrink-0 gap-1">
                <Button size="sm" variant="outline" onClick={() => download(r.id)} aria-label={`Download ${r.download_name}`}><Download className="h-4 w-4" /> Download</Button>
                {canDelete && (
                  <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setToDelete(r)} aria-label={`Delete ${r.download_name}`}>
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={category} onValueChange={(v) => setCategory(v as AttachmentCategory)}>
          <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>{categories.map((c) => <SelectItem key={c} value={c}>{LABEL[c]}</SelectItem>)}</SelectContent>
        </Select>
        <Input ref={inputRef} className="h-9 max-w-xs" type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        <Button size="sm" disabled={files.length === 0 || pending} onClick={upload}>
          <Upload className="h-4 w-4" /> {pending ? "Uploading..." : files.length > 1 ? `Upload ${files.length} files` : "Upload"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">PDF, JPEG, PNG or WebP, up to 20 MB each. You can select several files at once; they are added side by side. A single document uploaded again in the same category becomes a new version; earlier versions stay available.</p>
      {error && <p className="text-destructive">{error}</p>}

      <ConfirmDialog
        open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete this attachment?"
        description={toDelete ? `${LABEL[toDelete.category] ?? toDelete.category} · ${toDelete.download_name} will be permanently deleted, together with the stored file. This cannot be undone; the audit log keeps who deleted it and why.` : ""}
        confirmLabel="Delete" destructive requireReason
        onConfirm={async (reason) => {
          if (!toDelete) return;
          const res = await deleteAttachmentAction(toDelete.id, reason);
          if (!res.ok) return res.error;
          toast.success("Attachment deleted.");
          setToDelete(null);
          void load();
        }}
      />
    </div>
  );
}
