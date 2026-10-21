"use server";

import { revalidatePath } from "next/cache";
import { assertOwner } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getResource, autoCodePrefix, type FieldDef } from "@/lib/admin/resources";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Highest existing numeric suffix for `${prefix}-NNNN` codes in a company. */
async function nextCodeSuffix(
  admin: SupabaseClient, table: string, companyId: string, codeField: string, prefix: string,
): Promise<number> {
  const { data } = await admin.from(table).select(codeField).eq("company_id", companyId).ilike(codeField, `${prefix}-%`);
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const row of ((data ?? []) as unknown as Record<string, string>[])) {
    const m = re.exec(row[codeField] ?? "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}
const padCode = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, "0")}`;

export interface SaveResult {
  ok: boolean;
  id?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

async function resolveCompanyId(defaultCompanyId: string | null): Promise<string> {
  if (defaultCompanyId) return defaultCompanyId;
  const admin = createAdminClient();
  const { data } = await admin.from("companies").select("id").order("created_at").limit(1);
  const id = data?.[0]?.id;
  if (!id) throw new Error("No company is configured. Run the seed script.");
  return id;
}

function coerceField(
  field: FieldDef,
  raw: FormDataEntryValue | string | number | boolean | null | undefined,
): { value: unknown } | { error: string } {
  const req = field.required === true;

  switch (field.type) {
    case "text":
    case "textarea": {
      const s = (raw ?? "").toString().trim();
      if (!s) {
        if (req) return { error: `${field.label} is required.` };
        return { value: field.nullable ? null : "" };
      }
      return { value: s };
    }
    case "number":
    case "money":
    case "quantity": {
      const s = (raw ?? "").toString().trim();
      if (!s) {
        if (req) return { error: `${field.label} is required.` };
        return { value: field.nullable ? null : field.defaultValue ?? 0 };
      }
      const n = Number(s);
      if (!Number.isFinite(n)) return { error: `${field.label} must be a number.` };
      if (field.min !== undefined && n < field.min)
        return { error: `${field.label} cannot be less than ${field.min}.` };
      if (field.max !== undefined && n > field.max)
        return { error: `${field.label} cannot be greater than ${field.max}.` };
      return { value: n };
    }
    case "switch": {
      const v = raw === true || raw === "true" || raw === "on" || raw === "1";
      return { value: v };
    }
    case "select": {
      const s = (raw ?? "").toString().trim();
      if (!s) {
        if (req) return { error: `${field.label} is required.` };
        return { value: null };
      }
      return { value: s };
    }
    case "date": {
      const s = (raw ?? "").toString().trim();
      if (!s) {
        if (req) return { error: `${field.label} is required.` };
        return { value: null };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
        return { error: `${field.label} must be a valid date.` };
      return { value: s };
    }
    default:
      return { value: raw ?? null };
  }
}

function mapDbError(
  err: { code?: string; message?: string } | null,
  codeLabel: string,
): string {
  if (!err) return "Could not save the record.";
  switch (err.code) {
    case "23505":
      return `A record with this ${codeLabel} already exists.`;
    case "23P01":
      return "This overlaps the effective dates of an existing record.";
    case "23503":
      return "A related record was not found or belongs to another company.";
    case "23514":
      return err.message?.replace(/^.*violates.*constraint.*$/i, "") || err.message || "A value failed a validation rule.";
    default:
      return err.message || "Could not save the record.";
  }
}

export async function saveResource(
  resourceKey: string,
  id: string | null,
  values: Record<string, unknown>,
): Promise<SaveResult> {
  let user;
  try {
    user = await assertOwner();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Not authorized." };
  }

  const config = getResource(resourceKey);
  if (!config) return { ok: false, error: "Unknown resource." };

  const companyId = await resolveCompanyId(user.defaultCompanyId);
  const admin = createAdminClient();
  const prefix = autoCodePrefix(resourceKey);
  const codeField = config.codeField;

  // Read the existing record up-front (needed for edit checks + keeping the code).
  let oldValues: Record<string, unknown> | null = null;
  if (id) {
    const { data } = await admin.from(config.table).select("*").eq("id", id).maybeSingle();
    oldValues = data ?? null;
    if (!oldValues) return { ok: false, error: "Record not found." };
    if ((oldValues as { company_id?: string }).company_id !== companyId) {
      return { ok: false, error: "You cannot edit a record from another company." };
    }
  }

  // Auto-generate the code/SKU: keep it fixed on edit; generate on create when
  // the user left it blank.
  let autoGenerated = false;
  if (prefix) {
    if (id) {
      values[codeField] = (oldValues as Record<string, unknown>)[codeField];
    } else if (!String(values[codeField] ?? "").trim()) {
      values[codeField] = padCode(prefix, (await nextCodeSuffix(admin, config.table, companyId, codeField, prefix)) + 1);
      autoGenerated = true;
    }
  }

  const payload: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};

  for (const field of config.fields) {
    const res = coerceField(field, values[field.name] as string);
    if ("error" in res) fieldErrors[field.name] = res.error;
    else payload[field.name] = res.value;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
  }

  // Resource-specific rules.
  if (resourceKey === "chart-of-accounts" && id && payload.parent_id === id) {
    return { ok: false, error: "An account cannot be its own parent." };
  }
  if (resourceKey === "accounting-periods") {
    const status = payload.status as string;
    if (status === "closed" || status === "locked") {
      payload.closed_by = user.id;
      payload.closed_at = new Date().toISOString();
    } else {
      payload.closed_by = null;
      payload.closed_at = null;
    }
  }

  payload.company_id = companyId;
  payload.updated_by = user.id;

  let savedId = id;
  if (id) {
    const { error } = await admin.from(config.table).update(payload).eq("id", id);
    if (error) return { ok: false, error: mapDbError(error, config.codeField) };
  } else {
    payload.created_by = user.id;
    // Insert, retrying with the next code if an auto-generated code collided
    // with a concurrent create.
    let attempts = 0;
    for (;;) {
      const { data, error } = await admin.from(config.table).insert(payload).select("id").single();
      if (!error) { savedId = data.id; break; }
      if (error.code === "23505" && autoGenerated && prefix && attempts < 5) {
        attempts += 1;
        payload[codeField] = padCode(prefix, (await nextCodeSuffix(admin, config.table, companyId, codeField, prefix)) + 1 + attempts);
        continue;
      }
      return { ok: false, error: mapDbError(error, config.codeField) };
    }
  }

  await writeAuditLog({
    userId: user.id,
    companyId,
    action: id ? "master.update" : "master.create",
    resourceType: config.auditType,
    resourceId: savedId,
    oldValues,
    newValues: payload,
  });

  revalidatePath(`/admin/${resourceKey}`);
  return { ok: true, id: savedId ?? undefined };
}

export async function setResourceActive(
  resourceKey: string,
  id: string,
  isActive: boolean,
  reason: string,
): Promise<SaveResult> {
  let user;
  try {
    user = await assertOwner();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Not authorized." };
  }

  const config = getResource(resourceKey);
  if (!config) return { ok: false, error: "Unknown resource." };

  const companyId = await resolveCompanyId(user.defaultCompanyId);
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from(config.table)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Record not found." };
  if ((existing as { company_id?: string }).company_id !== companyId) {
    return { ok: false, error: "You cannot modify a record from another company." };
  }
  if (!isActive && (existing as { is_protected?: boolean }).is_protected) {
    return { ok: false, error: "This is a protected record and cannot be deactivated." };
  }

  const { error } = await admin
    .from(config.table)
    .update({ is_active: isActive, updated_by: user.id })
    .eq("id", id);
  if (error) return { ok: false, error: mapDbError(error, config.codeField) };

  await writeAuditLog({
    userId: user.id,
    companyId,
    action: isActive ? "master.activate" : "master.deactivate",
    resourceType: config.auditType,
    resourceId: id,
    oldValues: { is_active: (existing as { is_active?: boolean }).is_active },
    newValues: { is_active: isActive },
    reason: reason || null,
  });

  revalidatePath(`/admin/${resourceKey}`);
  return { ok: true, id };
}
