/**
 * Production-safe seed for the import upgrade: registers permissions and
 * role grants from src/lib/auth/permissions.ts and runs
 * ensure_company_defaults for every company. It only ADDS — unlike
 * `npm run db:seed` it never renames the company, branches or accounts, so
 * edits made in Admin are kept. Idempotent; one transaction.
 *
 * Usage: npm run db:seed:upgrade (DATABASE_URL from .env.local)
 */
import { PERMISSION_DEFS, ROLE_DEFS } from "../src/lib/auth/permissions";
import { createDbClient } from "./db";

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    let newPerms = 0, newGrants = 0;
    const permId = new Map<string, string>();
    for (const p of PERMISSION_DEFS) {
      const ins = await db.query<{ id: string }>(
        `insert into permissions (resource, action, code, description) values ($1,$2,$3,$4)
         on conflict (code) do nothing returning id`,
        [p.resource, p.action, p.code, p.description],
      );
      if (ins.rowCount) newPerms++;
      const { rows } = await db.query<{ id: string }>("select id from permissions where code = $1", [p.code]);
      permId.set(p.code, rows[0].id);
    }

    for (const r of ROLE_DEFS) {
      // existing roles keep their name and description; missing system roles are created
      await db.query(
        `insert into roles (code, name, description, is_system, is_protected, is_active)
         values ($1,$2,$3,$4,$5,true) on conflict (code) do nothing`,
        [r.code, r.name, r.description, r.isSystem, r.isProtected],
      );
      const { rows } = await db.query<{ id: string }>("select id from roles where code = $1", [r.code]);
      const codes = r.permissions === "*" ? PERMISSION_DEFS.map((p) => p.code) : r.permissions;
      for (const code of codes) {
        const pid = permId.get(code);
        if (!pid) continue;
        const g = await db.query("insert into role_permissions (role_id, permission_id) values ($1,$2) on conflict do nothing", [rows[0].id, pid]);
        newGrants += g.rowCount ?? 0;
      }
    }

    const { rows: companies } = await db.query<{ id: string; code: string }>("select id, code from companies order by code");
    for (const c of companies) await db.query("select public.ensure_company_defaults($1)", [c.id]);

    await db.query("commit");
    console.log(`Upgrade seed complete: ${newPerms} new permission(s), ${newGrants} new role grant(s), defaults ensured for ${companies.length} company(ies).`);
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error("Upgrade seed failed:", (e as Error).message); process.exit(1); });
