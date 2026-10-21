"use server";

import { getActiveContext } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { CATEGORIES, OWNER_TYPES, type AttachmentCategory, type OwnerType } from "./policy";
import { attachmentDownloadUrl, listAttachments, uploadAttachment } from "./service";

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
  return listAttachments(ownerType, ownerId);
}

export async function attachmentDownloadAction(attachmentId: string) {
  if (!(await enabled())) return { ok: false as const, error: "Attachments are not enabled." };
  return attachmentDownloadUrl(attachmentId);
}
