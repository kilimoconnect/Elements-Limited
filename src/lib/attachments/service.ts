import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertActiveUser } from "@/lib/auth/guards";
import { writeAuditLog } from "@/lib/audit";
import {
  ATTACHMENT_BUCKET, CATEGORIES, FINANCIAL_CATEGORIES, OWNER_TYPES, SIGNED_URL_TTL_SECONDS,
  safeDownloadName, storagePath, validateAttachment,
  type AttachmentCategory, type OwnerType,
} from "./policy";

export interface AttachmentRow {
  id: string;
  category: AttachmentCategory;
  download_name: string;
  content_type: string;
  size_bytes: number;
  version: number;
  supersedes_id: string | null;
  uploaded_by: string;
  uploaded_at: string;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Parent-record check performed by the database (company, permission, branch). */
async function canAccessOwner(userId: string, ownerType: OwnerType, ownerId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("can_access_document_owner", {
    p_user: userId, p_owner_type: ownerType, p_owner_id: ownerId,
  });
  return !error && data === true;
}

async function ownerCompany(ownerType: OwnerType, ownerId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin.rpc("_document_owner", { p_owner_type: ownerType, p_owner_id: ownerId });
  const row = Array.isArray(data) ? data[0] : data;
  return (row as { company_id?: string } | null)?.company_id ?? null;
}

/**
 * Uploads a file to the private bucket and registers its metadata. The object
 * key is random; an existing object is never overwritten (upsert: false); a
 * replacement is a new version that supersedes the previous one.
 */
export async function uploadAttachment(input: {
  ownerType: OwnerType; ownerId: string; category: AttachmentCategory; file: File; supersedesId?: string | null;
}): Promise<Result<{ id: string }>> {
  const user = await assertActiveUser();
  if (!OWNER_TYPES.includes(input.ownerType) || !CATEGORIES.includes(input.category)) {
    return { ok: false, error: "Invalid attachment target." };
  }
  if (!(await canAccessOwner(user.id, input.ownerType, input.ownerId))) {
    return { ok: false, error: "You cannot attach files to this document." };
  }
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const v = validateAttachment(input.file.type, bytes.byteLength, bytes.subarray(0, 16));
  if (!v.ok) return { ok: false, error: v.error };

  const companyId = await ownerCompany(input.ownerType, input.ownerId);
  if (!companyId) return { ok: false, error: "Document not found." };
  const path = storagePath(companyId, input.ownerType, input.ownerId, randomUUID(), v.ext);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const admin = createAdminClient();

  const up = await admin.storage.from(ATTACHMENT_BUCKET).upload(path, bytes, {
    contentType: v.contentType, upsert: false, cacheControl: "private, max-age=0",
  });
  if (up.error) return { ok: false, error: "Upload failed." };

  const { data, error } = await admin.rpc("register_attachment", {
    p_user: user.id, p_owner_type: input.ownerType, p_owner_id: input.ownerId, p_category: input.category,
    p_storage_path: path, p_original_filename: input.file.name || "document",
    p_download_name: safeDownloadName(input.file.name, v.ext), p_content_type: v.contentType,
    p_size: bytes.byteLength, p_sha256: sha256, p_supersedes: input.supersedesId ?? null,
  });
  if (error) {
    // Not registered, so nothing references the object: remove it.
    await admin.storage.from(ATTACHMENT_BUCKET).remove([path]);
    return { ok: false, error: error.message.replace(/^ERROR:\s*/i, "") };
  }
  await writeAuditLog({
    userId: user.id, companyId, action: "attachment.upload", resourceType: input.ownerType,
    resourceId: input.ownerId, newValues: { attachment_id: data, category: input.category, sha256 },
  });
  return { ok: true, data: { id: data as string } };
}

/** Lists the attachments of a record the user can see (financial ones only with permission). */
export async function listAttachments(ownerType: OwnerType, ownerId: string): Promise<Result<AttachmentRow[]>> {
  const user = await assertActiveUser();
  if (!(await canAccessOwner(user.id, ownerType, ownerId))) return { ok: false, error: "Not authorised." };
  const admin = createAdminClient();
  const { data } = await admin.from("document_attachments")
    .select("id, category, download_name, content_type, size_bytes, version, supersedes_id, uploaded_by, uploaded_at")
    .eq("owner_type", ownerType).eq("owner_id", ownerId).order("uploaded_at");
  const financialOk = user.isOwner || user.permissions.has("documents.view_financial");
  const rows = ((data ?? []) as AttachmentRow[]).filter((r) => financialOk || !FINANCIAL_CATEGORIES.includes(r.category));
  return { ok: true, data: rows };
}

/**
 * Short-lived signed link, served as a download (Content-Disposition:
 * attachment with the sanitised name) so files are never rendered inline.
 */
export async function attachmentDownloadUrl(attachmentId: string): Promise<Result<{ url: string }>> {
  const user = await assertActiveUser();
  const admin = createAdminClient();
  const { data: row } = await admin.from("document_attachments")
    .select("owner_type, owner_id, category, storage_path, download_name, company_id")
    .eq("id", attachmentId).maybeSingle();
  if (!row) return { ok: false, error: "Not found." };
  if (!(await canAccessOwner(user.id, row.owner_type as OwnerType, row.owner_id))) return { ok: false, error: "Not authorised." };
  if (FINANCIAL_CATEGORIES.includes(row.category as AttachmentCategory)
      && !(user.isOwner || user.permissions.has("documents.view_financial"))) {
    return { ok: false, error: "Not authorised." };
  }
  const { data, error } = await admin.storage.from(ATTACHMENT_BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS, { download: row.download_name });
  if (error || !data) return { ok: false, error: "Could not create a download link." };
  await writeAuditLog({
    userId: user.id, companyId: row.company_id, action: "attachment.download", resourceType: row.owner_type,
    resourceId: row.owner_id, newValues: { attachment_id: attachmentId },
  });
  return { ok: true, data: { url: data.signedUrl } };
}
