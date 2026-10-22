/**
 * Stage 1 defects D1 and D8 (migration 0034). One transaction, ROLLED BACK.
 * PGlite only.
 *
 * D1: voiding an opening / stock increase after the average moved keeps
 *     GL 1150 equal to the stock subledger; voiding a decrease restores the
 *     exact value it removed.
 * D8: the database works in Africa/Dar_es_Salaam (dates, defaults, casts).
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-valuation runs only against the PGlite test database (npm run test:db).");
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
let k = 0;
const key = () => `val-key-${++k}-${Math.random().toString(36).slice(2)}`;
const n = (x: unknown) => Number(x);

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    // ------------------------------------------------------------ D8
    const tz = String(await one(db, "select current_setting('TimeZone')"));
    const dbTz = String(await one(db, "select coalesce((select array_to_string(setconfig, ',') from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase where d.datname = current_database() and s.setrole = 0), '')"));
    check("D8: database default time zone is Africa/Dar_es_Salaam", dbTz.includes("TimeZone=Africa/Dar_es_Salaam") || dbTz.includes("timezone=Africa/Dar_es_Salaam"), dbTz);
    // PGlite has no full tz database and reports the same zone as Etc/GMT-3
    check("D8: sessions run at UTC+03:00", n(await one(db, "select extract(timezone from now())")) === 10800, tz);
    check("D8: 22:30 UTC is already the next day in Dar es Salaam",
      String(await one(db, "select ('2026-10-21 22:30:00+00'::timestamptz)::date::text")) === "2026-10-22");
    check("D8: current_date is the Dar es Salaam date",
      String(await one(db, "select (current_date = (now() at time zone 'Africa/Dar_es_Salaam')::date)::text")) === "true");

    const co = await one(db, "select id from companies where code='ELEMENTS'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const pcs = await one(db, "select id from units where company_id=$1 and code='PCS'", [co])
      ?? await one(db, "select id from units where company_id=$1 limit 1", [co]);
    const today = String(await one(db, "select current_date::text"));
    const variance = await one(db, "select account_for($1,'inventory.price_variance')", [co]);
    const gl = async (code: string) => n(await one(db, `select coalesce(sum(l.debit - l.credit),0) from journal_lines l
      join journal_entries j on j.id=l.journal_id join chart_of_accounts a on a.id=l.account_id where j.company_id=$1 and a.code=$2`, [co, code]));
    const glId = async (id: string) => n(await one(db, `select coalesce(sum(l.debit - l.credit),0) from journal_lines l
      join journal_entries j on j.id=l.journal_id where j.company_id=$1 and l.account_id=$2`, [co, id]));
    const stockTotal = async () => n(await one(db, "select coalesce(sum(stock_value),0) from stock_balances where company_id=$1", [co]));
    const stock = async (p: string) => (await db.query("select quantity q, stock_value v from stock_balances where company_id=$1 and branch_id=$2 and product_id=$3", [co, hq, p])).rows[0];
    const product = async (sku: string) => one(db,
      "insert into products(company_id, sku, name, base_unit_id) values ($1,$2,$2,$3) returning id", [co, sku, pcs]);
    const opening = async (prod: string, qty: number, cost: number) => {
      const id = await one(db, "insert into inventory_openings(company_id, branch_id, opening_date) values ($1,$2,$3) returning id", [co, hq, today]);
      await db.query("insert into inventory_opening_lines(opening_id, product_id, quantity, unit_cost, line_no) values ($1,$2,$3,$4,1)", [id, prod, qty, cost]);
      await db.query("select post_inventory_opening($1,$2,$3)", [id, owner, key()]);
      return id;
    };
    const adjustment = async (prod: string, direction: string, qty: number, cost: number) => {
      const id = await one(db, "insert into stock_adjustments(company_id, branch_id, adjustment_date, direction, reason) values ($1,$2,$3,$4,'test') returning id", [co, hq, today, direction]);
      await db.query("insert into stock_adjustment_lines(adjustment_id, product_id, quantity, unit_cost, line_no) values ($1,$2,$3,$4,1)", [id, prod, qty, cost]);
      await db.query("select post_stock_adjustment($1,$2,$3)", [id, owner, key()]);
      return id;
    };
    const aligned = async () => (await gl("1150")) === (await stockTotal());

    check("starting point: GL 1150 equals the stock subledger", await aligned(), `${await gl("1150")} vs ${await stockTotal()}`);

    // ------------------------------------------------------------ D1: opening void after the average moved
    const pA = await product("VAL-A");
    const o1 = await opening(pA, 10, 100);   // 1,000
    await opening(pA, 10, 200);              // 2,000 -> average 150
    const v0 = await glId(variance);
    await db.query("select void_inventory_opening($1,$2,'test')", [o1, owner]);
    const sA = await stock(pA);
    check("D1 opening: void removes 10 at the 150 average (stock 10 / 1,500)", n(sA.q) === 10 && n(sA.v) === 1500);
    check("D1 opening: GL 1150 still equals the stock subledger (was 500 apart before 0034)", await aligned(), `${await gl("1150")} vs ${await stockTotal()}`);
    check("D1 opening: equity reversed in full, 500 average difference to price variance",
      (await glId(variance)) - v0 === 500 && n(await one(db, `select sum(l.debit) from journal_lines l join journal_entries j on j.id=l.journal_id
        join chart_of_accounts a on a.id=l.account_id where j.source_type='inventory_opening_void' and j.source_id=$1 and a.code='3200'`, [o1])) === 1000);
    check("D1 opening: void journal balances and is dated today (Dar es Salaam)",
      n(await one(db, `select sum(l.debit - l.credit) from journal_lines l join journal_entries j on j.id=l.journal_id where j.source_type='inventory_opening_void' and j.source_id=$1`, [o1])) === 0
      && String(await one(db, "select entry_date::text from journal_entries where source_type='inventory_opening_void' and source_id=$1", [o1])) === today);

    // ------------------------------------------------------------ D1: increase void after the average moved
    const pB = await product("VAL-B");
    await opening(pB, 10, 200);              // 2,000
    const inc = await adjustment(pB, "increase", 10, 100); // +1,000 -> average 150
    const v1 = await glId(variance);
    await db.query("select void_stock_adjustment($1,$2,'test')", [inc, owner]);
    const sB = await stock(pB);
    check("D1 increase: void removes 10 at 150 (stock 10 / 1,500)", n(sB.q) === 10 && n(sB.v) === 1500);
    check("D1 increase: GL 1150 equals the stock subledger", await aligned(), `${await gl("1150")} vs ${await stockTotal()}`);
    check("D1 increase: gain 4300 reversed in full (1,000), 500 difference to price variance",
      (await glId(variance)) - v1 === 500 && n(await one(db, `select sum(l.debit) from journal_lines l join journal_entries j on j.id=l.journal_id
        join chart_of_accounts a on a.id=l.account_id where j.source_type='stock_adjustment_void' and j.source_id=$1 and a.code='4300'`, [inc])) === 1000);

    // ------------------------------------------------------------ D1: decrease void restores the value removed
    const pC = await product("VAL-C");
    await opening(pC, 10, 100);              // 1,000
    const dec = await adjustment(pC, "decrease", 4, 0); // removes 400; the line carries no unit cost
    await opening(pC, 10, 200);              // 6 @100 + 10 @200 = 2,600
    await db.query("select void_stock_adjustment($1,$2,'test')", [dec, owner]);
    const sC = await stock(pC);
    check("D1 decrease: void puts back 4 units at the 400 removed (stock 20 / 3,000), not at the line's zero cost", n(sC.q) === 20 && n(sC.v) === 3000);
    check("D1 decrease: GL 1150 equals the stock subledger", await aligned(), `${await gl("1150")} vs ${await stockTotal()}`);

    // ------------------------------------------------------------ controls
    check("D1: a void of a void is refused", await (async () => {
      await db.query("savepoint s");
      try { await db.query("select void_stock_adjustment($1,$2,'again')", [dec, owner]); await db.query("release savepoint s"); return false; }
      catch { await db.query("rollback to savepoint s"); return true; }
    })());
    const recon = (await db.query("select check_key, ok from cost_reconciliation_checks($1)", [co])).rows as { check_key: string; ok: boolean }[];
    check("Cost Reconciliation inventory_gl check is OK", recon.find((r) => r.check_key === "inventory_gl")?.ok === true, JSON.stringify(recon));
    check("trial balance balances", n(await one(db, "select coalesce(sum(l.debit - l.credit),0) from journal_lines l join journal_entries j on j.id=l.journal_id where j.company_id=$1", [co])) === 0);
    check("void helpers are not callable by app roles",
      String(await one(db, "select has_function_privilege('authenticated','public._void_inventory_lines(uuid,numeric,numeric)','execute')::text")) === "false"
      && String(await one(db, "select has_function_privilege('authenticated','public.void_stock_adjustment(uuid,uuid,text)','execute')::text")) === "false");
  } finally {
    await db.query("rollback");
    await db.end();
  }
  console.log(`\n${passed} valuation-fix (D1 / D8) checks passed. Rolling back.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
