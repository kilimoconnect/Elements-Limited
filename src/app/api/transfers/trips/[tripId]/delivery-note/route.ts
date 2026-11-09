import { assertActiveUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { renderDeliveryNote, type DeliveryNoteSnapshot } from "@/lib/transfers/delivery-note";
import { toAmendments } from "@/lib/pdf/brand";
import { canUseLicenceNumber } from "@/lib/transfers/licence";

/**
 * GET a trip's delivery note as a PDF download, the same way GRNs download:
 * the current version is issued (or reused when nothing changed) and the file
 * is returned directly. Users of the sending or receiving branch only; posts
 * nothing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await ctx.params;
  let user;
  try { user = await assertActiveUser(); } catch { return new Response("Not signed in.", { status: 401 }); }
  const notFound = new Response("Not found.", { status: 404 });
  if (!/^[0-9a-f-]{36}$/i.test(tripId) || !userHasPermission(user, "inventory.transfer_view")) return notFound;

  const admin = createAdminClient();
  const { data: trip } = await admin.from("stock_transfer_dispatches").select("id, company_id, transfer_id").eq("id", tripId).maybeSingle();
  if (!trip || (!user.isOwner && !user.companyIds.includes(trip.company_id))) return notFound;

  // Checks that the user belongs to the sending or receiving branch.
  const { data, error } = await admin.rpc("issue_delivery_note", { p_dispatch: tripId, p_user: user.id });
  if (error) return new Response(error.message.replace(/^ERROR:\s*/i, ""), { status: 403 });
  const row = (data as { version_id: string; version_no: number; is_new: boolean }[])[0];
  const { data: v } = await admin.from("document_versions").select("id, version, snapshot, content_sha256, created_at").eq("id", row.version_id).single();
  if (!v) return notFound;

  if (row.is_new) {
    await writeAuditLog({ userId: user.id, companyId: trip.company_id, action: "transfer.delivery_note_issue", resourceType: "document_version", resourceId: v.id });
  }
  await writeAuditLog({ userId: user.id, companyId: trip.company_id, action: "transfer.delivery_note_download", resourceType: "document_version", resourceId: v.id });


  // Truck / driver changes made before this version was issued.
  const { data: changeRows } = await admin.from("stock_transfer_dispatch_changes").select("old_values, new_values, reason, changed_at")
    .eq("dispatch_id", tripId).lte("changed_at", v.created_at).order("changed_at");
  const amendments = toAmendments((changeRows ?? []) as never, canUseLicenceNumber(user));

  const snap = v.snapshot as DeliveryNoteSnapshot;
  const pdf = renderDeliveryNote(snap, { version: v.version, sha256: v.content_sha256, issuedAt: v.created_at }, amendments);
  const name = `${snap.delivery_note_number || snap.reference}.pdf`.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Blob([pdf as BlobPart], { type: "application/pdf" }), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
