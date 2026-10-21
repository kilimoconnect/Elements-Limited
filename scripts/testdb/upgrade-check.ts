/**
 * Upgrade-path check for the newest migrations (run by scripts/testdb/run.ts).
 *
 * Rebuilds a database the way the live Letiq database was created - migrations
 * up to 0023, the pre-0024 seed, then the manual backfill of the per-company
 * blocks from 0007/0013/0019 - commits real stock + journal activity, then
 * applies the remaining migrations and asserts that existing balances,
 * movements, journals, accounts and payment-account ledgers are unchanged and
 * that the new defaults were added exactly once.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "../db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) throw new Error("upgrade-check only runs against LETIQ_PGLITE_DIR");

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { console.error(`  FAIL ${name} ${detail}`); process.exitCode = 1; }
}

function child(script: string, extraEnv: Record<string, string>) {
  const r = spawnSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), script], {
    stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) throw new Error(`${script} failed`);
}

async function snapshot(db: Client) {
  const q = async (sql: string) => JSON.stringify((await db.query(sql)).rows);
  return {
    tb: await q(`select c.code, sum(l.debit)::text d, sum(l.credit)::text c from journal_lines l
                 join chart_of_accounts c on c.id = l.account_id group by c.code order by c.code`),
    stock: await q(`select product_id, branch_id, quantity::text, avg_unit_cost::text, stock_value::text, qty_in_transit::text
                    from stock_balances order by product_id, branch_id`),
    movements: await q(`select id, qty_in::text, qty_out::text, unit_cost::text, movement_value::text, balance_value::text
                        from stock_movements order by created_at, id`),
    journals: await q(`select id, journal_id, account_id, debit::text, credit::text from journal_lines order by id`),
    coa: await q(`select id, code, name, account_type, parent_id, normal_balance, allow_posting, is_control, cashflow_class
                  from chart_of_accounts order by code`),
    payment: await q(`select code, ledger_account_id from payment_accounts order by code`),
    products: await q(`select id, sku, base_unit_id, track_inventory from products order by sku`),
  };
}

async function main() {
  // 1) Database as it existed before 0024.
  child("scripts/migrate.ts", { LETIQ_MIGRATE_UNTIL: "0023" });
  child("scripts/seed.ts", { LETIQ_SEED_PRE_0024: "1" });

  let db = createDbClient();
  await db.connect();
  // Same manual backfill that was run on the live database after its seed.
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir).filter((x) => x < "0024").sort()) {
    const sql = readFileSync(join(dir, f), "utf8");
    for (const block of sql.match(/^do \$\$[\s\S]*?^end \$\$;/gm) ?? []) {
      if (block.includes("from public.companies")) await db.query(block);
    }
  }

  // 2) Committed activity: opening stock, a sale with COGS, journals.
  const user = (await db.query<{ id: string }>(`insert into auth.users(email) values ('upgrade@test.local') returning id`)).rows[0].id;
  const co = (await db.query<{ id: string }>(`select id from companies where code='LETIQ'`)).rows[0].id;
  const br = (await db.query<{ id: string }>(`select id from branches where company_id=$1 and code='HQ'`, [co])).rows[0].id;
  const unit = (await db.query<{ id: string }>(`select id from units where company_id=$1 and code='BAG'`, [co])).rows[0].id;
  const prod = (await db.query<{ id: string }>(
    `insert into products(company_id, sku, name, base_unit_id, purchase_price, selling_price)
     values ($1,'UPG-1','Upgrade test fertilizer 50kg',$2,1000,1500) returning id`, [co, unit])).rows[0].id;
  const acc = async (code: string) =>
    (await db.query<{ id: string }>(`select id from chart_of_accounts where company_id=$1 and code=$2`, [co, code])).rows[0].id;
  await db.query("begin");
  await db.query(`select record_stock_movement($1,$2,$3,'opening','inventory_opening',gen_random_uuid(),'OPB-T',100,0,1000.3333,$4)`, [co, br, prod, user]);
  await db.query(`select create_journal($1,$2,current_date,'inventory_opening',gen_random_uuid(),'OPB-T','Opening',$3,$4::jsonb)`,
    [co, br, user, JSON.stringify([
      { account_id: await acc("1150"), debit: 100033.33, credit: 0 },
      { account_id: await acc("3200"), debit: 0, credit: 100033.33 }])]);
  const cogs = (await db.query<{ v: string }>(
    `select record_stock_movement($1,$2,$3,'sale','sale',gen_random_uuid(),'INV-T',0,30,0,$4) v`, [co, br, prod, user])).rows[0].v;
  await db.query(`select create_journal($1,$2,current_date,'sale',gen_random_uuid(),'INV-T','Sale',$3,$4::jsonb)`,
    [co, br, user, JSON.stringify([
      { account_id: await acc("1140"), debit: 45000, credit: 0 },
      { account_id: await acc("4100"), debit: 0, credit: 45000 },
      { account_id: await acc("5100"), debit: Number(cogs), credit: 0 },
      { account_id: await acc("1150"), debit: 0, credit: Number(cogs) }])]);
  await db.query("commit");

  const before = await snapshot(db);
  const coaCountBefore = (await db.query<{ n: string }>(`select count(*) n from chart_of_accounts`)).rows[0].n;
  await db.end();

  // 3) Apply the remaining migrations (0024+).
  child("scripts/migrate.ts", {});

  db = createDbClient();
  await db.connect();
  const after = await snapshot(db);

  check("trial balance unchanged", before.tb === after.tb);
  check("stock balances unchanged", before.stock === after.stock);
  check("stock movements unchanged", before.movements === after.movements);
  check("journal lines unchanged", before.journals === after.journals);
  check("payment-account ledgers unchanged", before.payment === after.payment);
  check("existing products unchanged", before.products === after.products);
  const oldCoa = JSON.parse(before.coa) as { id: string }[];
  const newCoa = new Map((JSON.parse(after.coa) as { id: string }[]).map((r) => [r.id, JSON.stringify(r)]));
  check("existing accounts unchanged", oldCoa.every((r) => newCoa.get(r.id) === JSON.stringify(r)));

  const added = (await db.query<{ code: string }>(
    `select code from chart_of_accounts where company_id=$1 and code in ('1155','1157','2130','2140','4400','4410','6150','6400','6410') order by code`, [co])).rows.map((r) => r.code);
  check("9 new system accounts added", added.length === 9, added.join(","));
  const coaCountAfter = (await db.query<{ n: string }>(`select count(*) n from chart_of_accounts`)).rows[0].n;
  check("only the 9 new accounts were added", Number(coaCountAfter) - Number(coaCountBefore) === 9,
    `${coaCountBefore} -> ${coaCountAfter}`);
  const stdRole = (await db.query<{ r: string }>(`select stock_role r from products where id=$1`, [prod])).rows[0].r;
  check("existing product defaults to stock_role 'standard'", stdRole === "standard");
  const cats = (await db.query<{ n: string }>(`select count(*) n from cost_categories where company_id=$1`, [co])).rows[0].n;
  check("default cost categories created", Number(cats) === 15, cats);

  // Re-running the defaults changes nothing.
  const counts = async () => JSON.stringify((await db.query(
    `select (select count(*) from chart_of_accounts) a, (select count(*) from cost_categories) c,
            (select count(*) from document_sequences) s, (select count(*) from units) u`)).rows[0]);
  const c1 = await counts();
  await db.query(`select ensure_company_defaults($1)`, [co]);
  check("ensure_company_defaults is idempotent", c1 === (await counts()));
  const tb = await db.query<{ d: string; c: string }>(`select sum(debit)::text d, sum(credit)::text c from journal_lines`);
  check("ledger still balances", tb.rows[0].d === tb.rows[0].c, `${tb.rows[0].d} vs ${tb.rows[0].c}`);

  await db.end();
  console.log(`\n${passed} upgrade-path checks passed.`);
}

main().catch((e) => { console.error("Upgrade check error:\n", e); process.exit(1); });
