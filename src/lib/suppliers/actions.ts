"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertBranchAccess } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";

export interface QuickSupplierInput {
  branchId: string; name: string; phone?: string; email?: string; tin?: string; vat?: string; address?: string; contact?: string; terms?: number;
}

/** Adds a supplier missing from the list; the database refuses duplicates (name, phone, TIN, email). */
export async function createSupplierQuick(input: QuickSupplierInput): Promise<RpcResult & { supplier?: { id: string; code: string; name: string } }> {
  try {
    const user = await assertActiveUser();
    if (!userHasPermission(user, "purchases.create") && !userHasPermission(user, "cost_invoices.post")) return { ok: false, error: "You are not allowed to create suppliers." };
    const ctx = await getActiveContext();
    assertBranchAccess(user, input.branchId);
    const res = await callPostingRpc("create_supplier_quick", {
      p_company: ctx.companyId, p_branch: input.branchId, p_user: user.id, p_name: input.name, p_phone: input.phone ?? null,
      p_email: input.email ?? null, p_tin: input.tin ?? null, p_vat: input.vat ?? null, p_address: input.address ?? null,
      p_contact: input.contact ?? null, p_terms: input.terms ?? 0,
    });
    if (!res.ok || !res.id) {
      if (/suppliers_unique_/.test(res.error ?? "")) return { ok: false, error: "This supplier already exists. Select it from the list." };
      return res;
    }
    const admin = createAdminClient();
    const { data: s } = await admin.from("suppliers").select("id, code, name").eq("id", res.id).single();
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: "supplier.create", resourceType: "supplier", resourceId: res.id });
    revalidatePath("/purchases/new");
    return { ok: true, id: res.id, supplier: s ?? undefined };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}
