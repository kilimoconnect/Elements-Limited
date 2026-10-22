import { assertActiveUser } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { renderDeliveryNote, type DeliveryNoteSnapshot } from "@/lib/transfers/delivery-note";

/**
 * GET a delivery-note version as PDF. Rendered from the stored snapshot, so a
 * version always prints the same; only users of the sending or receiving
 * branch (with transfer view rights) can open it. Posts nothing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await ctx.params;
  let user;
  try { user = await assertActiveUser(); } catch { return new Response("Not signed in.", { status: 401 }); }
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return new Response("Not found.", { status: 404 });
  const admin = createAdminClient();
  const { data: v } = await admin.from("document_versions")
    .select("id, company_id, owner_type, owner_id, kind, version, snapshot, content_sha256, created_at").eq("id", versionId).maybeSingle();
  if (!v || v.owner_type !== "stock_transfer_dispatch" || v.kind !== "delivery_note") return new Response("Not found.", { status: 404 });
  const { data: allowed } = await admin.rpc("can_access_document_owner", { p_user: user.id, p_owner_type: v.owner_type, p_owner_id: v.owner_id });
  if (allowed !== true) return new Response("Not found.", { status: 404 });
  const snap = v.snapshot as DeliveryNoteSnapshot;
  const pdf = renderDeliveryNote(snap, { version: v.version, sha256: v.content_sha256, issuedAt: v.created_at });
  await writeAuditLog({ userId: user.id, companyId: v.company_id, action: "transfer.delivery_note_download", resourceType: "document_version", resourceId: v.id });
  const name = `${snap.reference}-v${v.version}.pdf`.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Blob([pdf as BlobPart], { type: "application/pdf" }), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
