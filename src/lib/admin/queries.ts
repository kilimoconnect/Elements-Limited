import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  OPTION_SOURCES,
  NO_ACTIVE_TOGGLE,
  type OptionSourceKey,
  type ResourceConfig,
} from "@/lib/admin/resources";

export type OptionItem = { value: string; label: string };
export type OptionMap = Partial<Record<OptionSourceKey, OptionItem[]>>;

export async function getPrimaryCompanyId(
  defaultCompanyId: string | null,
): Promise<string> {
  if (defaultCompanyId) return defaultCompanyId;
  const admin = createAdminClient();
  const { data } = await admin
    .from("companies")
    .select("id")
    .order("created_at")
    .limit(1);
  const id = data?.[0]?.id;
  if (!id) throw new Error("No company configured. Run the seed script.");
  return id;
}

/** Load the dynamic <select> option lists required by a resource's fields. */
export async function loadResourceOptions(
  config: ResourceConfig,
  companyId: string,
): Promise<OptionMap> {
  const keys = new Set<OptionSourceKey>();
  for (const f of config.fields) if (f.optionsKey) keys.add(f.optionsKey);
  for (const c of config.columns) if (c.refKey) keys.add(c.refKey);

  const admin = createAdminClient();
  const out: OptionMap = {};

  await Promise.all(
    Array.from(keys).map(async (key) => {
      const src = OPTION_SOURCES[key];
      const codeCol = src.codeColumn ?? "code";
      let query = admin
        .from(src.table)
        .select(`id, ${codeCol}, ${src.labelColumn}`)
        .eq("company_id", companyId)
        .eq("is_active", true);
      if (src.where) {
        for (const [col, val] of Object.entries(src.where)) {
          query = query.eq(col, val as never);
        }
      }
      const { data } = await query.order(codeCol);
      out[key] = ((data as Record<string, string>[] | null) ?? []).map((r) => ({
        value: r.id,
        label: `${r[codeCol]} — ${r[src.labelColumn]}`,
      }));
    }),
  );

  return out;
}

export interface ListParams {
  q?: string;
  status?: "active" | "inactive" | "all";
  page?: number;
  pageSize?: number;
}

export interface ListResult {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

export async function loadResourceRows(
  config: ResourceConfig,
  companyId: string,
  params: ListParams,
): Promise<ListResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? 10;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const admin = createAdminClient();
  let query = admin
    .from(config.table)
    .select("*", { count: "exact" })
    .eq("company_id", companyId);

  if (!NO_ACTIVE_TOGGLE.has(config.key)) {
    if (params.status === "active") query = query.eq("is_active", true);
    else if (params.status === "inactive") query = query.eq("is_active", false);
  }

  if (params.q && params.q.trim()) {
    const term = params.q.trim().replace(/[%,]/g, "");
    const or = config.searchColumns
      .map((c) => `${c}.ilike.%${term}%`)
      .join(",");
    query = query.or(or);
  }

  const orderCol = config.columns[0]?.key ?? "created_at";
  query = query.order(orderCol, { ascending: true }).range(from, to);

  const { data, count } = await query;
  return {
    rows: (data as Record<string, unknown>[] | null) ?? [],
    total: count ?? 0,
    page,
    pageSize,
  };
}
