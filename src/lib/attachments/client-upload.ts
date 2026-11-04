"use client";

import { createClient } from "@/lib/supabase/client";
import { ATTACHMENT_BUCKET, type AttachmentCategory, type OwnerType } from "./policy";
import { completeUploadAction, prepareUploadAction } from "./actions";

/**
 * Uploads one file straight to storage through a one-time signed link, then
 * asks the server to check and register it. Works for files up to 20 MB
 * because the file itself never goes through the app server.
 */
export async function uploadAttachmentFile(input: {
  ownerType: OwnerType; ownerId: string; category: AttachmentCategory; file: File; supersedesId?: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const prep = await prepareUploadAction({
    ownerType: input.ownerType, ownerId: input.ownerId, category: input.category,
    contentType: input.file.type, size: input.file.size,
  });
  if (!prep.ok) return { ok: false, error: prep.error };
  const { error } = await createClient().storage.from(ATTACHMENT_BUCKET)
    .uploadToSignedUrl(prep.data.path, prep.data.token, input.file, { contentType: input.file.type, upsert: false });
  if (error) return { ok: false, error: "The upload failed. Check the connection and try again." };
  const done = await completeUploadAction({
    ownerType: input.ownerType, ownerId: input.ownerId, category: input.category,
    path: prep.data.path, originalName: input.file.name, supersedesId: input.supersedesId ?? null,
  });
  return done.ok ? { ok: true, id: done.data.id } : { ok: false, error: done.error };
}
