"use client";

import * as React from "react";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";
import { uploadAttachmentAction, listAttachmentsAction, attachmentDownloadAction } from "@/lib/attachments/actions";
import type { AttachmentCategory, OwnerType } from "@/lib/attachments/policy";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Row { id: string; category: string; download_name: string; size_bytes: number; version: number; supersedes_id: string | null; uploaded_at: string }

const LABEL: Record<string, string> = {
  bill_of_lading: "Bill of lading", packing_list: "Packing list", customs_entry: "Customs entry", supplier_invoice: "Supplier invoice",
  cost_invoice: "Cost invoice", delivery_note: "Delivery note", proof_of_delivery: "Proof of delivery", photo: "Photo / weighbridge", other: "Other",
};

/** Lists, uploads and downloads attachments of one record (private bucket, short-lived links). */
export function AttachmentsPanel({ ownerType, ownerId, categories }: { ownerType: OwnerType; ownerId: string; categories: AttachmentCategory[] }) {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [category, setCategory] = React.useState<AttachmentCategory>(categories[0]);
  const [file, setFile] = React.useState<File | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    const res = await listAttachmentsAction(ownerType, ownerId);
    if (res.ok) setRows(res.data as Row[]); else { setRows([]); setError(res.error); }
  }, [ownerType, ownerId]);
  React.useEffect(() => {
    let live = true;
    listAttachmentsAction(ownerType, ownerId).then((res) => {
      if (!live) return;
      if (res.ok) setRows(res.data as Row[]); else { setRows([]); setError(res.error); }
    });
    return () => { live = false; };
  }, [ownerType, ownerId]);

  const superseded = new Set((rows ?? []).map((r) => r.supersedes_id).filter(Boolean));
  async function upload() {
    if (!file) return;
    setError(null); setPending(true);
    const fd = new FormData();
    fd.set("ownerType", ownerType); fd.set("ownerId", ownerId); fd.set("category", category); fd.set("file", file);
    const latest = (rows ?? []).filter((r) => r.category === category && !superseded.has(r.id)).sort((a, b) => b.version - a.version)[0];
    if (latest) fd.set("supersedesId", latest.id);
    const res = await uploadAttachmentAction(fd);
    setPending(false);
    if (res.ok) { toast.success(latest ? `Uploaded version ${latest.version + 1}.` : "Uploaded."); setFile(null); if (inputRef.current) inputRef.current.value = ""; void load(); }
    else setError(res.error);
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
              <Button size="sm" variant="ghost" onClick={() => download(r.id)}><Download className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={category} onValueChange={(v) => setCategory(v as AttachmentCategory)}>
          <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>{categories.map((c) => <SelectItem key={c} value={c}>{LABEL[c]}</SelectItem>)}</SelectContent>
        </Select>
        <Input ref={inputRef} className="h-9 max-w-xs" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Button size="sm" disabled={!file || pending} onClick={upload}><Upload className="h-4 w-4" /> {pending ? "Uploading..." : "Upload"}</Button>
      </div>
      <p className="text-xs text-muted-foreground">PDF, JPEG, PNG or WebP up to 10 MB. A new upload in the same category becomes a new version; earlier versions stay available.</p>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
