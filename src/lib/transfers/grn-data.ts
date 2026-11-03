import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { CurrentUser } from "@/lib/auth/session";

const NONE = "none";

/** Head Office users (Owner, or anyone assigned to the head-office branch) issue GRNs. */
export async function isHeadOfficeUser(user: CurrentUser, companyId: string): Promise<boolean> {
  if (user.isOwner) return true;
  if (user.branchIds.length === 0) return false;
  const admin = createAdminClient();
  const { count } = await admin.from("branches").select("id", { count: "exact", head: true })
    .eq("company_id", companyId).eq("is_head_office", true).in("id", user.branchIds);
  return (count ?? 0) > 0;
}

export interface GrnGroup { key: string; supplierId: string | null; supplierName: string; lineIds: string[]; number: string | null }

/** The transfer's lines grouped by supplier (one GRN each), with any GRN number already issued. */
export async function transferGrnGroups(transferId: string): Promise<GrnGroup[]> {
  const admin = createAdminClient();
  const [{ data: map }, { data: issued }] = await Promise.all([
    admin.rpc("transfer_line_suppliers", { p_transfer: transferId }),
    admin.from("transfer_grns").select("supplier_id, document_number").eq("transfer_id", transferId),
  ]);
  const rows = (map ?? []) as { transfer_line_id: string; supplier_id: string | null }[];
  const ids = [...new Set(rows.map((r) => r.supplier_id).filter(Boolean))] as string[];
  const { data: sups } = ids.length
    ? await admin.from("suppliers").select("id, code, name").in("id", ids)
    : { data: [] as { id: string; code: string; name: string }[] };
  const groups = new Map<string, GrnGroup>();
  for (const r of rows) {
    const key = r.supplier_id ?? NONE;
    if (!groups.has(key)) {
      const s = (sups ?? []).find((x) => x.id === r.supplier_id);
      groups.set(key, {
        key, supplierId: r.supplier_id, supplierName: s ? `${s.code} - ${s.name}` : "Supplier not recorded", lineIds: [],
        number: ((issued ?? []) as { supplier_id: string | null; document_number: string }[]).find((i) => (i.supplier_id ?? NONE) === key)?.document_number ?? null,
      });
    }
    groups.get(key)!.lineIds.push(r.transfer_line_id);
  }
  return [...groups.values()].sort((a, b) => (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) || a.supplierName.localeCompare(b.supplierName));
}
