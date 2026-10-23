/**
 * Sales order approval (migration 0036) on the final schema. One
 * transaction, ROLLED BACK. PGlite only.
 *
 * Checks: the new roles and their key grants, approval columns and states,
 * a sale owning proof-of-payment attachments, branch-scoped document access,
 * and that posting an approved order still works through post_sale.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-sales-approval runs only against the PGlite test database (npm run test:db).");
  process.exit(1);
}

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { console.error(`  FAIL ${name} ${detail}`); process.exitCode = 1; }
}
async function one<T = string>(db: Client, sql: string, p: unknown[] = []): Promise<T> {
  const { rows } = await db.query(sql, p);
  return (rows[0] ? Object.values(rows[0])[0] : null) as T;
}
async function fails(db: Client, sql: string, p: unknown[] = []): Promise<boolean> {
  await db.query("savepoint sp");
  try { await db.query(sql, p); await db.query("release savepoint sp"); return false; }
  catch { await db.query("rollback to savepoint sp"); return true; }
}
const can = async (db: Client, role: string, perm: string) =>
  Number(await one(db, `select count(*) from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
    where r.code = $1 and p.code = $2`, [role, perm])) === 1;

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const co = await one(db, "select id from companies where code='ELEMENTS'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const cash = await one(db, "select id from payment_accounts where company_id=$1 and code='CASH'", [co]);
    const pc = await one(db, "select id from units where company_id=$1 and code='PCS'", [co]);
    await db.query("update feature_flags set is_enabled=true where company_id=$1", [co]);
    const other = await one(db, "insert into branches(company_id, code, name) values ($1,'ARU','Arusha') returning id", [co]);

    // ------------------------------------------------------------ roles
    check("roles exist: CEO, Branch Manager, Sales Manager",
      await one(db, "select name from roles where code='DIRECTOR'") === "Branch Manager"
      && await one(db, "select name from roles where code='CEO'") === "CEO"
      && await one(db, "select name from roles where code='SALES_MANAGER'") === "Sales Manager");
    check("Branch Manager approves sales; Sales Manager and Cashier do not",
      await can(db, "DIRECTOR", "sales.approve") && !(await can(db, "SALES_MANAGER", "sales.approve")) && !(await can(db, "CASHIER", "sales.approve")));
    check("CEO has every permission except managing users and roles",
      Number(await one(db, "select count(*) from permissions")) - 2
        === Number(await one(db, "select count(*) from role_permissions rp join roles r on r.id = rp.role_id where r.code='CEO'"))
      && !(await can(db, "CEO", "users.manage")) && !(await can(db, "CEO", "roles.manage")) && await can(db, "CEO", "sales.approve"));
    check("Cashier and Sales Manager can upload documents (proof of payment)",
      await can(db, "CASHIER", "documents.upload") && await can(db, "SALES_MANAGER", "documents.upload"));

    // ------------------------------------------------------------ users
    const mkUser = async (email: string, role: string, branch: string) => {
      const id = await one(db, "insert into auth.users(email) values ($1) returning id", [email]);
      await db.query("insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active) values ($1,$2,$3,(select id from roles where code=$3),$4,true)", [id, email, role, co]);
      await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [id, co]);
      await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [id, branch]);
      return id;
    };
    const cashier = await mkUser("cashier@test.local", "CASHIER", hq);
    const cashierAru = await mkUser("cashier-aru@test.local", "CASHIER", other);

    // ------------------------------------------------------------ an order
    const cust = await one(db, "insert into customers(company_id, code, name) values ($1,'SA-C','Approval customer') returning id", [co]);
    const prod = await one(db, "insert into products(company_id, sku, name, base_unit_id, selling_price, track_inventory) values ($1,'SA-SVC','Service',$2,1000,false) returning id", [co, pc]);
    const sale = await one(db, `insert into sales(company_id, branch_id, document_date, customer_id, subtotal, net_total, grand_total, amount_paid, outstanding, payment_status, created_by)
      values ($1,$2,current_date,$3,1000,1000,1000,1000,0,'paid',$4) returning id`, [co, hq, cust, cashier]);
    await db.query(`insert into sale_lines(sale_id, product_id, description, quantity, unit_price, original_price, net_amount, line_total, track_inventory, line_no)
      values ($1,$2,'Service',1,1000,1000,1000,1000,false,1)`, [sale, prod]);
    await db.query("insert into sale_payments(sale_id, payment_account_id, amount, payment_date) values ($1,$2,1000,current_date)", [sale, cash]);

    check("a new order starts as not submitted", await one(db, "select approval_status from sales where id=$1", [sale]) === "not_submitted");
    check("an unknown approval status is refused", await fails(db, "update sales set approval_status='maybe' where id=$1", [sale]));

    // ------------------------------------------------------------ proof of payment
    const path = `${co}/sale/${sale}/proof.pdf`;
    const att = await one(db, "select register_attachment($1,'sale',$2,'proof_of_payment',$3,'proof.pdf','proof.pdf','application/pdf',1000,$4)",
      [cashier, sale, path, "a".repeat(64)]);
    check("the cashier attaches proof of payment to an order in their branch", typeof att === "string" && att.length === 36);
    check("a cashier of another branch cannot see the order's documents",
      await one<boolean>(db, "select can_access_document_owner($1,'sale',$2)", [cashierAru, sale]) === false);
    check("a cashier of another branch cannot attach to it",
      await fails(db, "select register_attachment($1,'sale',$2,'proof_of_payment',$3,'p2.pdf','p2.pdf','application/pdf',1000,$4)",
        [cashierAru, sale, `${co}/sale/${sale}/p2.pdf`, "b".repeat(64)]));
    check("an unknown attachment category is refused",
      await fails(db, "select register_attachment($1,'sale',$2,'selfie',$3,'p3.pdf','p3.pdf','application/pdf',1000,$4)",
        [cashier, sale, `${co}/sale/${sale}/p3.pdf`, "c".repeat(64)]));

    // ------------------------------------------------------------ approve -> post
    await db.query("update sales set approval_status='pending', submitted_by=$2, submitted_at=now() where id=$1", [sale, cashier]);
    const res = await one<{ ok?: boolean } | string>(db, "select post_sale($1,$2,gen_random_uuid()::text)", [sale, owner]);
    await db.query("update sales set approval_status='approved', approved_by=$2, approved_at=now() where id=$1", [sale, owner]);
    check("an approved order posts through post_sale and gets an invoice number",
      await one(db, "select document_status from sales where id=$1", [sale]) === "posted"
      && !!(await one(db, "select document_number from sales where id=$1", [sale])), JSON.stringify(res));
    check("the posted sale keeps its proof of payment",
      Number(await one(db, "select count(*) from document_attachments where owner_type='sale' and owner_id=$1 and category='proof_of_payment'", [sale])) === 1);

    console.log(`\nSales approval: ${passed} checks passed.`);
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
