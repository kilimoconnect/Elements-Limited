/**
 * Test-only Owner bootstrap for the PGlite database. Mirrors
 * scripts/bootstrap-owner.ts but inserts the auth user directly, because the
 * Supabase Auth admin API does not exist in PGlite.
 */
import { createDbClient } from "../db";

async function main() {
  if (!process.env.LETIQ_PGLITE_DIR) throw new Error("test-owner only runs against LETIQ_PGLITE_DIR");
  const db = createDbClient();
  await db.connect();
  try {
    await db.query("begin");
    const email = "owner@test.local";
    const u = await db.query<{ id: string }>(
      `insert into auth.users(email, email_confirmed_at) values ($1, now()) returning id`, [email]);
    const ownerId = u.rows[0].id;
    const co = await db.query<{ id: string }>("select id from companies where code = 'LETIQ'", []);
    const companyId = co.rows[0].id;
    const br = await db.query<{ id: string }>("select id from branches where company_id = $1 and code = 'HQ'", [companyId]);
    const branchId = br.rows[0].id;
    const role = await db.query<{ id: string }>("select id from roles where code = 'OWNER'", []);
    await db.query(
      `insert into user_profiles (id, email, full_name, role_id, default_company_id, default_branch_id,
         is_active, is_primary_owner, created_by, updated_by)
       values ($1,$2,'Test Owner',$3,$4,$5,true,true,$1,$1)`,
      [ownerId, email, role.rows[0].id, companyId, branchId]);
    await db.query(`insert into user_company_access (user_id, company_id, created_by) values ($1,$2,$1)`, [ownerId, companyId]);
    await db.query(`insert into user_branch_access (user_id, branch_id, is_default, created_by) values ($1,$2,true,$1)`, [ownerId, branchId]);
    await db.query("commit");
    console.log("Test owner created.");
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
