"use server";

import { getActiveContext } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { CATEGORIES, OWNER_TYPES, type AttachmentCategory, type OwnerType } from "./policy";
import { attachmentDownloadUrl, completeUpload, deleteAttachment, listAttachments, prepareUpload, uploadAttachment } from "./service";
import { getCurrentUser } from "@/lib/auth/session";

async function enabled(): Promise<boolean> {
  const ctx = await getActiveContext();
  return isFeatureEnabled(ctx.companyId, "attachments");
}

export async function uploadAttachmentAction(form: FormData) {
  if (!(await enabled())) return { ok: false as const, error: "Attachments are not enabled." };
  const ownerType = String(form.get("ownerType")) as OwnerType;
  const category = String(form.get("category")) as AttachmentCategory;
  const file = form.get("file");
  if (!OWNER_TYPES.includes(ownerType) || !CATEGORIES.includes(category) || !(file instanceof File)) {
    return { ok: false as const, error: "Invalid upload." };
  }
  return uploadAttachment({
    ownerType, ownerId: String(form.get("ownerId")), category, file,
    supersedesId: (form.get("supersedesId") as string | null) || null,
  });
}

export async function listAttachmentsAction(ownerType: OwnerType, ownerId: string) {
  if (!(await enabled())) return { ok: false as const, error: "Attachments are not enabled." };
  const [res, user] = await Promise.all([listAttachments(ownerType, ownerId), getCurrentUser()]);
  // Only the Owner sees the Delete button (the server checks again on delete).
  return { ...res, canDelete: !!user?.isOwner };
}

export async function deleteAttachmentAction(attachmentId: string, reason: string) {
  if (!(await enabled())) return { ok: false as const, error: "Attachments are not enabled." };
  return deleteAttachment(attachmentId, reason);
}

export async function attachmentDownloadAction(attachmentId: string) {
  if (!(await enabled())) return { ok: false as const, error: "Attachments are not enabled." };
  return attachmentDownloadUrl(attachmentId);
}

export async function prepareUploadAction(input: { ownerType: OwnerType; ownerId: string; category: AttachmentCategory; contentType: string; size: number }) {
  if (!(await enabled())) return { ok: false as const, error: "Attachments are not enabled." };
  return prepareUpload(input);
}

export async function completeUploadAction(input: { ownerType: OwnerType; ownerId: string; category: AttachmentCategory; path: string; originalName: string; supersedesId?: string | null }) {
  if (!(await enabled())) return { ok: false as const, error: "Attachments are not enabled." };
  return completeUpload(input);
}
