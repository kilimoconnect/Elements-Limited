/**
 * Sales promotions (migration 0037) on the final schema. One transaction,
 * ROLLED BACK. PGlite only.
 *
 * Checks: permissions, promotion and reward constraints, a free (price 0)
 * line leaving stock with its cost in cost of sales and no revenue, and
 * read access scoped by company.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-promotions runs only against the PGlite test database (npm run test:db).");
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
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    const a1150 = await one(db, "select id from chart_of_accounts where company_id=$1 and code='1150'", [co]);
    const a3200 = await one(db, "select id from chart_of_accounts where company_id=$1 and code='3200'", [co]);

    // ------------------------------------------------------------ permissions
    check("only the Owner and CEO manage promotions",
      await can(db, "OWNER", "promotions.manage") && await can(db, "CEO", "promotions.manage")
      && !(await can(db, "DIRECTOR", "promotions.manage")) && !(await can(db, "SALES_MANAGER", "promotions.manage")));
    check("Branch Manager and Sales Manager can view promotions",
      await can(db, "DIRECTOR", "promotions.view") && await can(db, "SALES_MANAGER", "promotions.view"));

    // ------------------------------------------------------------ setup: product with stock at 1,000 per bag
    const prod = await one(db, "insert into products(company_id, sku, name, base_unit_id, selling_price) values ($1,'PR-50','Promo bag',$2,1500) returning id", [co, bag]);
    await db.query("select record_stock_movement_value($1,$2,$3,'opening','opening',gen_random_uuid(),'OPEN',$4,$5,$6)", [co, hq, prod, 200, 200000, owner]);
    await db.query("select create_journal($1,$2,current_date,'opening',gen_random_uuid(),'OPEN','opening',$3,$4::jsonb)", [co, hq, owner,
      JSON.stringify([{ account_id: a1150, debit: 200000, credit: 0 }, { account_id: a3200, debit: 0, credit: 200000 }])]);
    const cust = await one(db, "insert into customers(company_id, code, name) values ($1,'PR-C','Promo customer') returning id", [co]);

    // ------------------------------------------------------------ promotion constraints
    const promo = await one(db, `insert into sales_promotions(company_id, name, product_id, min_quantity, free_quantity, reward_timing, created_by)
      values ($1,'Buy 100 get 2',$2,100,2,'current_order',$3) returning id`, [co, prod, owner]);
    check("a promotion needs a positive minimum and free quantity",
      await fails(db, "insert into sales_promotions(company_id, name, product_id, min_quantity, free_quantity) values ($1,'x',$2,0,1)", [co, prod])
      && await fails(db, "insert into sales_promotions(company_id, name, product_id, min_quantity, free_quantity) values ($1,'x',$2,10,0)", [co, prod]));
    check("a promotion cannot end before it starts",
      await fails(db, "insert into sales_promotions(company_id, name, product_id, min_quantity, free_quantity, starts_on, ends_on) values ($1,'x',$2,10,1,'2026-05-01','2026-04-30')", [co, prod]));
    check("reward timing is same order or next order only",
      await fails(db, "insert into sales_promotions(company_id, name, product_id, min_quantity, free_quantity, reward_timing) values ($1,'x',$2,10,1,'someday')", [co, prod]));

    // ------------------------------------------------------------ a sale: 100 paid + 2 free
    const sale = await one(db, `insert into sales(company_id, branch_id, document_date, customer_id, subtotal, net_total, grand_total, amount_paid, outstanding, payment_status, created_by)
      values ($1,$2,current_date,$3,150000,150000,150000,150000,0,'paid',$4) returning id`, [co, hq, cust, owner]);
    await db.query(`insert into sale_lines(sale_id, product_id, description, quantity, unit_price, original_price, net_amount, line_total, line_no)
      values ($1,$2,'Promo bag',100,1500,1500,150000,150000,1)`, [sale, prod]);
    check("a free line must be at price 0 with no discount",
      await fails(db, `insert into sale_lines(sale_id, product_id, description, quantity, unit_price, original_price, line_no, is_free, promotion_id)
        values ($1,$2,'bad',2,10,1500,9,true,$3)`, [sale, prod, promo]));
    await db.query(`insert into sale_lines(sale_id, product_id, description, quantity, unit_price, original_price, line_no, is_free, promotion_id)
      values ($1,$2,'Promo bag - FREE (Buy 100 get 2)',2,0,1500,2,true,$3)`, [sale, prod, promo]);
    await db.query("insert into sale_payments(sale_id, payment_account_id, amount, payment_date) values ($1,$2,150000,current_date)", [sale, cash]);
    await db.query("select post_sale($1,$2,gen_random_uuid()::text)", [sale, owner]);

    check("the sale posts with the free line", await one(db, "select document_status from sales where id=$1", [sale]) === "posted");
    check("free goods leave stock: 200 - 100 - 2 = 98",
      Number(await one(db, "select quantity from stock_balances where branch_id=$1 and product_id=$2", [hq, prod])) === 98);
    check("revenue is only the paid goods (150,000)", Number(await one(db, "select net_total from sales where id=$1", [sale])) === 150000);
    check("cost of sales includes the free goods (102 × 1,000)", Number(await one(db, "select cogs_total from sales where id=$1", [sale])) === 102000);
    check("the free line keeps price 0 and carries its cost",
      Number(await one(db, "select line_total from sale_lines where sale_id=$1 and is_free", [sale])) === 0
      && Number(await one(db, "select cogs from sale_lines where sale_id=$1 and is_free", [sale])) === 2000);

    // ------------------------------------------------------------ next-order rewards
    const nextPromo = await one(db, `insert into sales_promotions(company_id, name, product_id, min_quantity, free_quantity, reward_timing)
      values ($1,'Next order 1 free',$2,100,1,'next_order') returning id`, [co, prod]);
    const reward = await one(db, `insert into promotion_rewards(company_id, promotion_id, customer_id, product_id, quantity, earned_sale_id)
      values ($1,$2,$3,$4,1,$5) returning id`, [co, nextPromo, cust, prod, sale]);
    check("a reward starts available", await one(db, "select status from promotion_rewards where id=$1", [reward]) === "available");
    check("the same sale cannot earn the same promotion twice",
      await fails(db, "insert into promotion_rewards(company_id, promotion_id, customer_id, product_id, quantity, earned_sale_id) values ($1,$2,$3,$4,1,$5)", [co, nextPromo, cust, prod, sale]));
    check("an unknown reward status is refused", await fails(db, "update promotion_rewards set status='lost' where id=$1", [reward]));

    // ------------------------------------------------------------ access
    check("app users can only read promotions and rewards, not write them",
      await one<boolean>(db, "select has_table_privilege('authenticated','public.sales_promotions','insert')") === false
      && await one<boolean>(db, "select has_table_privilege('authenticated','public.promotion_rewards','update')") === false
      && await one<boolean>(db, "select has_table_privilege('authenticated','public.sales_promotions','select')") === true);

    console.log(`\nSales promotions: ${passed} checks passed.`);
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
