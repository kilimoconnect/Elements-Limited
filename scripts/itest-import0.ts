/**
 * Import upgrade - Stage 0 (foundation) checks. Runs inside one transaction
 * that is ROLLED BACK. Intended for the PGlite test database
 * (`npm run test:db`); refuses to run against a real DATABASE_URL.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-import0 runs only against the PGlite test database (npm run test:db).");
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
/** Runs sql in a savepoint; returns the error message, or null if it succeeded. */
async function failMsg(db: Client, sql: string, p: unknown[] = []): Promise<string | null> {
  await db.query("savepoint sp");
  try { await db.query(sql, p); await db.query("release savepoint sp"); return null; }
  catch (e) { await db.query("rollback to savepoint sp"); return (e as Error).message; }
}

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const co = await one(db, "select id from companies where code='ELEMENTS'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const branch = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const unit = (code: string) => one(db, "select id from units where company_id=$1 and code=$2", [co, code]);

    // --- Accounts -----------------------------------------------------------
    const accts = (await db.query(
      `select code, account_type, is_control, allow_posting from chart_of_accounts
       where company_id=$1 and code in ('1155','1157','2130','2140','4400','4410','6150','6400','6410')`, [co])).rows as
      { code: string; account_type: string; is_control: boolean; allow_posting: boolean }[];
    const byCode = new Map(accts.map((a) => [a.code, a]));
    check("all 9 new system accounts exist", accts.length === 9);
    check("goods-in-transit / accrual accounts are control accounts",
      ["1155", "1157", "2130", "2140"].every((c) => byCode.get(c)?.is_control === true));
    check("accrual accounts are liabilities", byCode.get("2130")?.account_type === "liability" && byCode.get("2140")?.account_type === "liability");
    check("FX gain is revenue, FX loss is expense", byCode.get("4400")?.account_type === "revenue" && byCode.get("6400")?.account_type === "expense");
    for (const c of ["3200", "1121", "5200", "6300"]) {
      check(`clean install has account ${c}`, !!(await one(db, "select id from chart_of_accounts where company_id=$1 and code=$2", [co, c])));
    }
    for (const t of ["inventory_opening", "supplier_payment", "financial_opening_balance"]) {
      check(`clean install has ${t} sequence`, !!(await one(db,
        "select id from document_sequences where company_id=$1 and document_type=$2", [co, t])));
    }
    check("NMB payment account uses its own ledger 1121",
      (await one(db, `select c.code from payment_accounts p join chart_of_accounts c on c.id=p.ledger_account_id
                      where p.company_id=$1 and p.code='NMB'`, [co])) === "1121");

    // Idempotency.
    const counts = async () => JSON.stringify((await db.query(
      `select (select count(*) from chart_of_accounts where company_id=$1) a,
              (select count(*) from cost_categories where company_id=$1) c,
              (select count(*) from document_sequences where company_id=$1) s,
              (select count(*) from units where company_id=$1) u`, [co])).rows[0]);
    const before = await counts();
    await db.query("select ensure_company_defaults($1)", [co]);
    await db.query("select ensure_company_defaults($1)", [co]);
    check("ensure_company_defaults is idempotent", before === await counts());

    // A code already used by a different kind of account is refused.
    const tmp = await one(db, `insert into companies(code, name) values ('TMPX','Temp Co') returning id`);
    await db.query(`insert into chart_of_accounts(company_id, code, name, account_type, normal_balance)
                    values ($1,'1155','Fuel','expense','debit')`, [tmp]);
    const clash = await failMsg(db, "select ensure_company_defaults($1)", [tmp]);
    check("conflicting account code is refused loudly", !!clash && clash.includes("1155"), clash ?? "no error");

    // --- Units ----------------------------------------------------------------
    check("KG has kg_factor 1", Number(await one(db, "select kg_factor from units where company_id=$1 and code='KG'", [co])) === 1);
    check("MT has kg_factor 1000", Number(await one(db, "select kg_factor from units where company_id=$1 and code='MT'", [co])) === 1000);
    check("BAG has no kg_factor", (await one(db, "select kg_factor from units where company_id=$1 and code='BAG'", [co])) === null);

    // --- Cost categories ------------------------------------------------------
    check("16 default cost categories (incl. TRF_OTHER, 0035)", Number(await one(db, "select count(*) from cost_categories where company_id=$1", [co])) === 16);
    check("storage rent is expensed to 6150",
      (await one(db, `select c.code from cost_categories k join chart_of_accounts c on c.id=k.expense_account_id
                      where k.company_id=$1 and k.code='STORAGE' and k.inventory_treatment='expense'`, [co])) === "6150");
    check("freight is capitalised", (await one(db, "select inventory_treatment from cost_categories where company_id=$1 and code='FREIGHT'", [co])) === "capitalize");
    check("no default category assumes a tax code",
      Number(await one(db, "select count(*) from cost_categories where company_id=$1 and default_tax_code_id is not null", [co])) === 0);
    check("expensed category without an account is rejected", !!(await failMsg(db,
      `insert into cost_categories(company_id, code, name, inventory_treatment, applies_to_import) values ($1,'X1','x','expense',true)`, [co])));
    check("expense account must be a posting expense account", !!(await failMsg(db,
      `insert into cost_categories(company_id, code, name, inventory_treatment, expense_account_id, applies_to_import)
       values ($1,'X2','x','expense',(select id from chart_of_accounts where company_id=$1 and code='6000'),true)`, [co])));
    check("category must apply to some workflow", !!(await failMsg(db,
      `insert into cost_categories(company_id, code, name, inventory_treatment) values ($1,'X3','x','capitalize')`, [co])));
    check("goods-value category cannot be expensed", !!(await failMsg(db,
      `insert into cost_categories(company_id, code, name, inventory_treatment, expense_account_id, applies_to_import, is_goods_value)
       values ($1,'X4','x','expense',(select id from chart_of_accounts where company_id=$1 and code='6100'),true,true)`, [co])));

    // --- Products: stock roles and kg -----------------------------------------
    const kg = await unit("KG"), bag = await unit("BAG"), pcs = await unit("PCS");
    check("bulk product needs a kg base unit", !!(await failMsg(db,
      `insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'B-BAD','x',$2,'bulk')`, [co, pcs])));
    const bulk = await one(db,
      `insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg) values ($1,'UREA-BULK','Urea bulk',$2,'bulk',7) returning id`, [co, kg]);
    check("bulk product net weight is forced to 1 kg", Number(await one(db, "select net_weight_kg from products where id=$1", [bulk])) === 1);
    check("packaged product needs net kg", !!(await failMsg(db,
      `insert into products(company_id, sku, name, base_unit_id, stock_role, bulk_product_id) values ($1,'P-BAD1','x',$2,'packaged',$3)`, [co, bag, bulk])));
    const std = await one(db, `insert into products(company_id, sku, name, base_unit_id) values ($1,'STD-1','Std',$2) returning id`, [co, pcs]);
    check("packaged product must come from a bulk product", !!(await failMsg(db,
      `insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,'P-BAD2','x',$2,'packaged',50,$3)`, [co, bag, std])));
    check("standard product cannot reference a bulk product", !!(await failMsg(db,
      `insert into products(company_id, sku, name, base_unit_id, bulk_product_id) values ($1,'S-BAD','x',$2,$3)`, [co, pcs, bulk])));
    const tmpKg = await one(db,
      `insert into units(company_id, code, name, kg_factor) values ($1,'KG','Kilogram',1) returning id`, [tmp]);
    const bulkOther = await one(db,
      `insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'TMP-BULK','Other co bulk',$2,'bulk') returning id`,
      [tmp, tmpKg]);
    check("cross-company bulk source rejected", !!bulkOther && !!(await failMsg(db,
      `insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,'P-X','x',$2,'packaged',50,$3)`, [co, bag, bulkOther])));
    const p50 = await one(db,
      `insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id)
       values ($1,'UREA-50','Urea 50 kg',$2,'packaged',50,$3) returning id`, [co, bag, bulk]);
    check("packaged 50 kg SKU created", !!p50);
    check("bulk product cannot stop tracking inventory", !!(await failMsg(db,
      "update products set track_inventory=false where id=$1", [bulk])));

    await db.query(`select record_stock_movement($1,$2,$3,'opening','test',gen_random_uuid(),'T',10,0,1000,$4)`, [co, branch, p50, owner]);
    check("net kg frozen once stock has moved", !!(await failMsg(db, "update products set net_weight_kg=25 where id=$1", [p50])));
    check("stock role frozen once stock has moved", !!(await failMsg(db, "update products set stock_role='standard', bulk_product_id=null where id=$1", [p50])));
    check("other product fields still editable", (await failMsg(db, "update products set name='Urea 50 kg bag' where id=$1", [p50])) === null);
    check("existing products default to standard",
      Number(await one(db, "select count(*) from products where company_id=$1 and stock_role is null", [co])) === 0);

    // --- Currency -------------------------------------------------------------
    check("company base currency must stay TZS", !!(await failMsg(db, "update companies set base_currency='USD' where id=$1", [co])));
    check("TZS cannot have an exchange rate", !!(await failMsg(db,
      `insert into exchange_rates(company_id, currency_code, rate_date, rate) values ($1,'TZS','2026-10-01',1)`, [co])));
    check("zero rate rejected", !!(await failMsg(db,
      `insert into exchange_rates(company_id, currency_code, rate_date, rate) values ($1,'USD','2026-10-01',0)`, [co])));
    const noRate = await failMsg(db, "select exchange_rate_on($1,'USD','2026-10-05')", [co]);
    check("missing rate raises (no silent default)", !!noRate && noRate.includes("05/10/2026"), noRate ?? "");
    await db.query(`insert into exchange_rates(company_id, currency_code, rate_date, rate) values ($1,'USD','2026-10-01',2512.345678)`, [co]);
    await db.query(`insert into exchange_rates(company_id, currency_code, rate_date, rate) values ($1,'USD','2026-10-10',2530)`, [co]);
    check("rate on a later date uses latest prior rate",
      (await one(db, "select exchange_rate_on($1,'USD','2026-10-05')::text", [co])) === "2512.345678");
    check("rate on the rate date", (await one(db, "select exchange_rate_on($1,'USD','2026-10-10')::text", [co])) === "2530.000000");
    check("TZS rate is 1", Number(await one(db, "select exchange_rate_on($1,'TZS','2026-10-05')", [co])) === 1);
    check("duplicate rate for same day rejected", !!(await failMsg(db,
      `insert into exchange_rates(company_id, currency_code, rate_date, rate) values ($1,'USD','2026-10-10',2600)`, [co])));

    // --- Privileges and RLS ---------------------------------------------------
    check("app users cannot call ensure_company_defaults",
      (await one<boolean>(db, "select has_function_privilege('authenticated','public.ensure_company_defaults(uuid)','execute')")) === false);
    check("app users cannot call exchange_rate_on directly",
      (await one<boolean>(db, "select has_function_privilege('authenticated','public.exchange_rate_on(uuid,text,date)','execute')")) === false);

    // A non-owner user with no company access sees nothing; the Owner sees rows.
    const outsider = await one(db, `insert into auth.users(email) values ('outsider@test.local') returning id`);
    const asUser = async (uid: string, sql: string) => {
      await db.query("savepoint rls");
      await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      await db.query("set local role authenticated");
      const r = await db.query(sql);
      await db.query("rollback to savepoint rls");
      return r.rows;
    };
    check("outsider sees no cost categories", (await asUser(outsider, "select id from cost_categories")).length === 0);
    check("outsider sees no exchange rates", (await asUser(outsider, "select id from exchange_rates")).length === 0);
    check("owner sees company cost categories", (await asUser(owner, `select id from cost_categories where company_id='${co}'`)).length === 16);
    await db.query("savepoint w");
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [outsider]);
    await db.query("set local role authenticated");
    let writeBlocked = false;
    try {
      await db.query(`insert into exchange_rates(company_id, currency_code, rate_date, rate) values ('${co}','EUR','2026-10-01',2900)`);
    } catch { writeBlocked = true; }
    await db.query("rollback to savepoint w");
    check("non-owner cannot write exchange rates", writeBlocked);

    console.log(`\n${passed} import Stage 0 checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nImport Stage 0 test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main();
