/**
 * Import upgrade - Stage 3 (foreign-currency purchases with TZS books).
 * One transaction, ROLLED BACK. PGlite test database only (npm run test:db).
 * Includes the acceptance fixture: USD 100,000 @ 2,600, settle USD 40,000 for
 * TZS 105,200,000, revalue at 2,650, settle the rest from the revalued carrying.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-import3 runs only against the PGlite test database (npm run test:db).");
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
async function failMsg(db: Client, sql: string, p: unknown[] = []): Promise<string | null> {
  await db.query("savepoint sp");
  try { await db.query(sql, p); await db.query("release savepoint sp"); return null; }
  catch (e) { await db.query("rollback to savepoint sp"); return (e as Error).message; }
}
const fails = async (db: Client, sql: string, p: unknown[] = [], expect?: string) => {
  const m = await failMsg(db, sql, p);
  return m !== null && (!expect || m.toLowerCase().includes(expect.toLowerCase()));
};
let k = 0;
const key = () => `stage3-key-${++k}-${Math.random().toString(36).slice(2)}`;
const n = (x: unknown) => Number(x);

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const Y = new Date().getFullYear();
    const d = (md: string) => `${Y}-${md}`;
    const co = await one(db, "select id from companies where code='ELEMENTS'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    const nmb = await one(db, "select id from payment_accounts where company_id=$1 and code='NMB'", [co]);
    await db.query("update payment_accounts set allow_negative=true, overdraft_limit=10000000000 where id=$1", [nmb]);
    const usdSup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'GLOBAL','Global Fertiliser FZE') returning id", [co]);
    const tzsSup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'LOCAL','Local Agro Ltd') returning id", [co]);
    const urea = await one(db, "insert into products(company_id, sku, name, base_unit_id) values ($1,'UREA50','Urea 50kg',$2) returning id", [co, bag]);
    const dap = await one(db, "insert into products(company_id, sku, name, base_unit_id) values ($1,'DAP50','DAP 50kg',$2) returning id", [co, bag]);
    const gl = async (code: string) => n(await one(db,
      `select coalesce(sum(l.debit - l.credit),0) from journal_lines l join journal_entries j on j.id=l.journal_id
       where j.company_id=$1 and l.account_id=(select id from chart_of_accounts where company_id=$1 and code=$2)`, [co, code]));
    const jl = async (sourceType: string, sourceId: string) => (await db.query<{ code: string; d: string; c: string }>(
      `select c.code, sum(l.debit)::text d, sum(l.credit)::text c from journal_entries j join journal_lines l on l.journal_id=j.id
       join chart_of_accounts c on c.id=l.account_id where j.source_type=$1 and j.source_id=$2 group by c.code order by c.code`,
      [sourceType, sourceId])).rows.map((r) => `${r.code}:${n(r.d)}/${n(r.c)}`).join(" ");

    const purchase = async (sup: string, date: string, cur: string, rate: number, lines: [string, number, number][],
      adv: [string, number][] = [], source: string | null = "manual") => {
      const id = await one(db, `insert into purchases(company_id, branch_id, supplier_id, document_date, currency_code, exchange_rate, rate_source, rate_reference)
                               values ($1,$2,$3,$4,$5,$6,$7,'test') returning id`, [co, hq, sup, date, cur, rate, cur === "TZS" ? null : source]);
      for (const [prod, qty, cost] of lines) {
        await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, is_recoverable) values ($1,$2,$3,$4,true)", [id, prod, qty, cost]);
      }
      for (const [advId, fc] of adv) {
        await db.query("insert into purchase_advance_applications(company_id, purchase_id, advance_id, fc_amount) values ($1,$2,$3,$4)", [co, id, advId, fc]);
      }
      return id;
    };
    const payment = async (sup: string, date: string, cur: string, tzs: number, allocs: [string, number][],
      advance = 0, charges = 0) => {
      const id = await one(db, `insert into supplier_payments(company_id, branch_id, supplier_id, document_date, currency_code, advance_fc_amount, bank_charges, bank_charges_account_id)
                               values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [co, hq, sup, date, cur, advance, charges, charges ? nmb : null]);
      await db.query("insert into supplier_payment_funding(payment_id, payment_account_id, amount) values ($1,$2,$3)", [id, nmb, tzs]);
      for (const [payable, amt] of allocs) {
        if (cur === "TZS") await db.query("insert into supplier_payment_allocations(payment_id, payable_id, amount) values ($1,$2,$3)", [id, payable, amt]);
        else await db.query("insert into supplier_payment_allocations(payment_id, payable_id, amount, fc_amount) values ($1,$2,0,$3)", [id, payable, amt]);
      }
      return id;
    };
    const payableOf = (pur: string) => one(db, "select id from supplier_payables where purchase_id=$1", [pur]);
    const pbState = async (pur: string) => (await db.query<{ fc: string; tzs: string; st: string }>(
      "select fc_outstanding::text fc, outstanding::text tzs, status st from supplier_payables where purchase_id=$1", [pur])).rows[0];

    // ---------------------------------------------------------- gates
    const p0 = await purchase(usdSup, d("01-04"), "USD", 2600, [[urea, 1, 10]]);
    check("foreign purchase blocked while fx_settlement is off", await fails(db, "select post_purchase($1,$2,$3)", [p0, owner, key()], "not enabled"));
    await db.query("update feature_flags set is_enabled=true where company_id=$1 and flag_key='fx_settlement'", [co]);
    const keeper = await one(db, "insert into auth.users(email) values ('k3@test.local') returning id");
    await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active)
                    values ($1,'k3@test.local','K',(select id from roles where code='STOREKEEPER'),$2,true)`, [keeper, co]);
    await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [keeper, co]);
    await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [keeper, hq]);
    check("user without fx.enter_rate cannot post a foreign purchase", await fails(db, "select post_purchase($1,$2,$3)", [p0, keeper, key()], "fx.enter_rate"));
    check("foreign purchase needs an idempotency key", await fails(db, "select post_purchase($1,$2,null)", [p0, owner], "idempotency key"));
    const pNoSrc = await purchase(usdSup, d("01-04"), "USD", 2600, [[urea, 1, 10]], [], null);
    check("foreign purchase needs a rate source", await fails(db, "select post_purchase($1,$2,$3)", [pNoSrc, owner, key()], "source"));
    await db.query("insert into exchange_rates(company_id, currency_code, rate_date, rate) values ($1,'USD',$2,2601)", [co, d("01-01")]);
    const pTable = await purchase(usdSup, d("01-04"), "USD", 2600, [[urea, 1, 10]], [], "rate_table");
    check("rate-table source must match the table rate", await fails(db, "select post_purchase($1,$2,$3)", [pTable, owner, key()], "does not match"));
    check("zero rate rejected", await fails(db, "update purchases set exchange_rate=0 where id=$1", [p0]));
    check("TZS purchase with rate other than 1 rejected", await fails(db,
      "insert into purchases(company_id, branch_id, supplier_id, exchange_rate) values ($1,$2,$3,2)", [co, hq, tzsSup]));
    check("instant payment on a foreign purchase rejected", await fails(db,
      "insert into purchase_payments(purchase_id, payment_account_id, amount) values ($1,$2,100)", [p0, nmb], "supplier payment"));
    await db.query("delete from purchases where id = any($1)", [[p0, pNoSrc, pTable]]);

    // ---------------------------------------------------------- acceptance fixture
    const invBefore = await gl("1150");
    const p1 = await purchase(usdSup, d("01-05"), "USD", 2600, [[urea, 100, 1000]]);
    const k1 = key();
    await db.query("select post_purchase($1,$2,$3)", [p1, owner, k1]);
    check("USD 100,000 @ 2,600 -> TZS 260,000,000 invoice",
      n(await one(db, "select grand_total from purchases where id=$1", [p1])) === 260000000
      && n(await one(db, "select fc_grand_total from purchases where id=$1", [p1])) === 100000);
    let s = await pbState(p1);
    check("payable: USD 100,000 outstanding, TZS 260,000,000 carrying", n(s.fc) === 100000 && n(s.tzs) === 260000000, JSON.stringify(s));
    check("purchase journal Dr 1150 / Cr 2110 260,000,000", (await jl("purchase", p1)) === "1150:260000000/0 2110:0/260000000", await jl("purchase", p1));
    check("stock received at exactly TZS 260,000,000",
      n(await one(db, "select stock_value from stock_balances where product_id=$1 and branch_id=$2", [urea, hq])) === 260000000);
    await db.query("select post_purchase($1,$2,$3)", [p1, owner, k1]);
    check("retried purchase posting does nothing", Number(await one(db, "select count(*) from journal_entries where source_type='purchase' and source_id=$1", [p1])) === 1
      && n(await one(db, "select quantity from stock_balances where product_id=$1 and branch_id=$2", [urea, hq])) === 100);
    check("posted rate cannot change", await fails(db, "update purchases set exchange_rate=2700 where id=$1", [p1], "cannot change"));
    check("posted lines cannot change", await fails(db, "update purchase_lines set unit_cost=1 where purchase_id=$1", [p1], "cannot change"));

    const pay1 = await payment(usdSup, d("01-10"), "USD", 105200000, [[await payableOf(p1), 40000]]);
    const kp1 = key();
    await db.query("select post_supplier_payment($1,$2,$3)", [pay1, owner, kp1]);
    check("settle USD 40,000 for TZS 105,200,000: releases TZS 104,000,000",
      n(await one(db, "select amount from supplier_payment_allocations where payment_id=$1", [pay1])) === 104000000);
    check("records TZS 1,200,000 realised FX loss", n(await one(db, "select fx_difference from supplier_payments where id=$1", [pay1])) === 1200000
      && (await jl("supplier_payment", pay1)) === "1121:0/105200000 2110:104000000/0 6400:1200000/0", await jl("supplier_payment", pay1));
    s = await pbState(p1);
    check("remaining USD 60,000 carries TZS 156,000,000", n(s.fc) === 60000 && n(s.tzs) === 156000000, JSON.stringify(s));
    await db.query("select post_supplier_payment($1,$2,$3)", [pay1, owner, kp1]);
    check("retried payment does nothing", Number(await one(db, "select count(*) from journal_entries where source_type='supplier_payment' and source_id=$1", [pay1])) === 1
      && n((await pbState(p1)).fc) === 60000);

    // ---------------------------------------------------------- advances (USD)
    const adv = await payment(usdSup, d("01-12"), "USD", 25500000, [], 10000);
    await db.query("select post_supplier_payment($1,$2,$3)", [adv, owner, key()]);
    const advId = await one(db, "select id from supplier_advances where payment_id=$1", [adv]);
    check("USD 10,000 advance carried at TZS 25,500,000 (Dr 1175)", (await jl("supplier_payment", adv)) === "1121:0/25500000 1175:25500000/0", await jl("supplier_payment", adv));
    const p2 = await purchase(usdSup, d("01-15"), "USD", 2600, [[urea, 30, 1000]], [[advId, 10000]]);
    await db.query("select post_purchase($1,$2,$3)", [p2, owner, key()]);
    check("advance applied at historical TZS: Dr 1150 77.5M, Cr 1175 25.5M, Cr 2110 52M, no FX",
      (await jl("purchase", p2)) === "1150:77500000/0 1175:0/25500000 2110:0/52000000", await jl("purchase", p2));
    s = await pbState(p2);
    check("payable after advance: USD 20,000 / TZS 52,000,000", n(s.fc) === 20000 && n(s.tzs) === 52000000, JSON.stringify(s));
    check("advance fully applied", (await one(db, "select status || ':' || fc_remaining || ':' || tzs_remaining from supplier_advances where id=$1", [advId])) === "applied:0.00:0.00");
    check("payment with an applied advance cannot be voided", await fails(db, "select void_supplier_payment($1,$2,'x')", [adv, owner], "applied"));
    check("advance cannot exceed the invoice", await (async () => {
      const a2 = await payment(usdSup, d("01-12"), "USD", 2600, [], 1);
      await db.query("select post_supplier_payment($1,$2,$3)", [a2, owner, key()]);
      const pX = await purchase(usdSup, d("01-15"), "USD", 2600, [[urea, 1, 0.5]], [[await one(db, "select id from supplier_advances where payment_id=$1", [a2]), 1]]);
      const r = await fails(db, "select post_purchase($1,$2,$3)", [pX, owner, key()], "exceed");
      await db.query("delete from purchases where id=$1", [pX]);
      return r;
    })());

    // ---------------------------------------------------------- returns before revaluation
    const p3 = await purchase(usdSup, d("01-16"), "USD", 2600, [[dap, 100, 100]]);
    await db.query("select post_purchase($1,$2,$3)", [p3, owner, key()]);
    const p3line = await one(db, "select id from purchase_lines where purchase_id=$1", [p3]);
    const ret = async (date: string, qty: number, method: string) => {
      const id = await one(db, `insert into purchase_returns(company_id, branch_id, purchase_id, supplier_id, document_date, reason, settlement_method)
                               values ($1,$2,$3,$4,$5,'damaged',$6) returning id`, [co, hq, p3, usdSup, date, method]);
      await db.query(`insert into purchase_return_lines(return_id, purchase_line_id, product_id, quantity, unit_price, net_amount, tax_amount, line_total, track_inventory)
                      values ($1,$2,$3,$4,100,$5,0,$5,true)`, [id, p3line, dap, qty, qty * 260000]);
      return id;
    };
    const r1 = await ret(d("01-20"), 20, "reduce_payable");
    check("foreign return cannot be refunded in cash", await (async () => {
      const rx = await ret(d("01-20"), 1, "refund");
      const r = await fails(db, "select post_purchase_return($1,$2,$3)", [rx, owner, key()], "supplier credit");
      await db.query("delete from purchase_returns where id=$1", [rx]);
      return r;
    })());
    await db.query("select post_purchase_return($1,$2,$3)", [r1, owner, key()]);
    s = await pbState(p3);
    check("return USD 2,000 at original rate: payable USD 8,000 / TZS 20,800,000", n(s.fc) === 8000 && n(s.tzs) === 20800000, JSON.stringify(s));
    check("return journal: Dr 2110 5.2M, Cr 1150 5.2M, no FX", (await jl("purchase_return", r1)) === "1150:0/5200000 2110:5200000/0", await jl("purchase_return", r1));

    // ---------------------------------------------------------- revaluation at 2,650
    check("revaluation needs a rate for every open currency", await fails(db,
      "select post_fx_revaluation($1,$2,'[]'::jsonb,$3,$4)", [co, d("01-31"), owner, key()], "missing for USD"));
    check("storekeeper cannot revalue", await fails(db,
      "select post_fx_revaluation($1,$2,$3::jsonb,$4,$5)", [co, d("01-31"), JSON.stringify([{ currency: "USD", rate: 2650 }]), keeper, key()], "fx.revalue"));
    const kr = key();
    const rv1 = await one(db, "select post_fx_revaluation($1,$2,$3::jsonb,$4,$5)",
      [co, d("01-31"), JSON.stringify([{ currency: "USD", rate: 2650, source: "manual", reference: "BOT closing" }]), owner, kr]);
    s = await pbState(p1);
    check("at 2,650 the USD 60,000 carries TZS 159,000,000", n(s.tzs) === 159000000, JSON.stringify(s));
    check("further TZS 3,000,000 unrealised loss on that invoice",
      n(await one(db, "select difference from fx_revaluation_lines where revaluation_id=$1 and payable_id=$2", [rv1, await payableOf(p1)])) === 3000000);
    check("revaluation journal balanced: Dr 6410 / Cr 2110 (3M + 1M + 0.4M)",
      (await jl("fx_revaluation", rv1)) === "2110:0/4400000 6410:4400000/0", await jl("fx_revaluation", rv1));
    check("retried revaluation returns the same document", (await one(db, "select post_fx_revaluation($1,$2,$3::jsonb,$4,$5)",
      [co, d("01-31"), JSON.stringify([{ currency: "USD", rate: 2650 }]), owner, kr])) === rv1);
    check("second revaluation for the same date rejected", await fails(db, "select post_fx_revaluation($1,$2,$3::jsonb,$4,$5)",
      [co, d("01-31"), JSON.stringify([{ currency: "USD", rate: 2650 }]), owner, key()], "already exists"));
    check("inventory unchanged by FX (stock value still 260M + 77.5M + 26M - 5.2M)",
      n(await one(db, "select sum(stock_value) from stock_balances where company_id=$1", [co])) === 260000000 + 77500000 + 26000000 - 5200000
      && (await gl("1150")) - invBefore === 260000000 + 77500000 + 26000000 - 5200000);
    const early = await payment(usdSup, d("01-25"), "USD", 2600, [[await payableOf(p2), 1]]);
    check("payment dated before the revaluation rejected", await fails(db, "select post_supplier_payment($1,$2,$3)", [early, owner, key()], "before the last revaluation"));
    await db.query("delete from supplier_payments where id=$1", [early]);
    check("earlier payment cannot be voided after a later revaluation", await fails(db, "select void_supplier_payment($1,$2,'x')", [pay1, owner], "later transactions"));

    // ---------------------------------------------------------- later settlement uses revalued carrying
    const pay2 = await payment(usdSup, d("02-05"), "USD", 162000000, [[await payableOf(p1), 60000]], 0, 25000);
    await db.query("select post_supplier_payment($1,$2,$3)", [pay2, owner, key()]);
    check("final settlement releases the revalued TZS 159,000,000",
      n(await one(db, "select amount from supplier_payment_allocations where payment_id=$1", [pay2])) === 159000000);
    check("realised loss only beyond the revalued carrying (3,000,000); bank charges separate in 6200",
      (await jl("supplier_payment", pay2)) === "1121:0/162025000 2110:159000000/0 6200:25000/0 6400:3000000/0", await jl("supplier_payment", pay2));
    s = await pbState(p1);
    check("invoice settled: USD 0 / TZS 0", n(s.fc) === 0 && n(s.tzs) === 0 && s.st === "settled", JSON.stringify(s));
    check("purchase shows paid", (await one(db, "select payment_status from purchases where id=$1", [p1])) === "paid");
    {
      const pb1 = await payableOf(p1);
      const realised = n(await one(db, "select coalesce(sum(a.fx_difference),0) from supplier_payment_allocations a join supplier_payments p on p.id=a.payment_id where a.payable_id=$1 and p.document_status='posted'", [pb1]));
      const unrealised = n(await one(db, "select coalesce(sum(l.difference),0) from fx_revaluation_lines l join fx_revaluations r on r.id=l.revaluation_id where l.payable_id=$1 and r.status='posted'", [pb1]));
      const paid = n(await one(db, "select coalesce(sum(a.tzs_paid),0) from supplier_payment_allocations a join supplier_payments p on p.id=a.payment_id where a.payable_id=$1 and p.document_status='posted'", [pb1]));
      check("no double counting: realised (4.2M) + unrealised (3M) = TZS paid (267.2M) - original carrying (260M)",
        realised === 4200000 && unrealised === 3000000 && realised + unrealised === paid - 260000000, `${realised} ${unrealised} ${paid}`);
    }

    // ---------------------------------------------------------- second revaluation, returns and credits after it
    await db.query("select post_fx_revaluation($1,$2,$3::jsonb,$4,$5)", [co, d("02-28"), JSON.stringify([{ currency: "USD", rate: 2700 }]), owner, key()]);
    s = await pbState(p3);
    check("P3 USD 8,000 revalued to TZS 21,600,000", n(s.tzs) === 21600000, JSON.stringify(s));
    const r2 = await ret(d("03-05"), 10, "reduce_payable");
    await db.query("select post_purchase_return($1,$2,$3)", [r2, owner, key()]);
    check("return after revaluation: releases carrying 2.7M, stock at 2.6M, 0.1M reverses unrealised (4410)",
      (await jl("purchase_return", r2)) === "1150:0/2600000 2110:2700000/0 4410:0/100000", await jl("purchase_return", r2));
    const r3 = await ret(d("03-06"), 10, "supplier_credit");
    await db.query("select post_purchase_return($1,$2,$3)", [r3, owner, key()]);
    const credit = await one(db, "select id from supplier_credits where source_return_id=$1", [r3]);
    check("supplier credit USD 1,000 carried at original TZS 2,600,000",
      (await one(db, "select currency_code || ':' || fc_amount || ':' || amount from supplier_credits where id=$1", [credit])) === "USD:1000.00:2600000.00");
    const tzsPur = await purchase(tzsSup, d("03-06"), "TZS", 1, [[urea, 1, 50000]]);
    await db.query("select post_purchase($1,$2,$3)", [tzsPur, owner, key()]);
    check("USD credit cannot be applied to a TZS invoice", await fails(db, "select apply_supplier_credit($1,$2,100,$3,$4,$5)",
      [credit, await payableOf(tzsPur), d("03-07"), owner, key()], "supplier and currency"));
    check("credit application cannot exceed the credit", await fails(db, "select apply_supplier_credit($1,$2,1000.01,$3,$4,$5)",
      [credit, await payableOf(p2), d("03-07"), owner, key()], "exceeds the credit"));
    const ka = key();
    const app = await one(db, "select apply_supplier_credit($1,$2,1000,$3,$4,$5)", [credit, await payableOf(p2), d("03-07"), owner, ka]);
    check("credit applied: Dr 2110 2.7M (invoice carrying), Cr 1170 2.6M, realised gain 0.1M",
      (await jl("supplier_credit_application", app)) === "1170:0/2600000 2110:2700000/0 4400:0/100000", await jl("supplier_credit_application", app));
    check("retried credit application returns the same application",
      (await one(db, "select apply_supplier_credit($1,$2,1000,$3,$4,$5)", [credit, await payableOf(p2), d("03-07"), owner, ka])) === app
      && Number(await one(db, "select count(*) from supplier_credit_applications where credit_id=$1", [credit])) === 1);
    s = await pbState(p2);
    check("P2 balance after credit: USD 19,000 / TZS 51,300,000", n(s.fc) === 19000 && n(s.tzs) === 51300000, JSON.stringify(s));

    // ---------------------------------------------------------- TZS advance and partial payment (no FX)
    const tadv = await payment(tzsSup, d("03-08"), "TZS", 1000000, [], 1000000);
    await db.query("select post_supplier_payment($1,$2,$3)", [tadv, owner, key()]);
    const tAdvId = await one(db, "select id from supplier_advances where payment_id=$1", [tadv]);
    const p4 = await purchase(tzsSup, d("03-09"), "TZS", 1, [[urea, 10, 300000]], [[tAdvId, 1000000]]);
    await db.query("select post_purchase($1,$2,$3)", [p4, owner, key()]);
    check("TZS advance applied: Dr 1150 3M, Cr 1175 1M, Cr 2110 2M", (await jl("purchase", p4)) === "1150:3000000/0 1175:0/1000000 2110:0/2000000", await jl("purchase", p4));
    const tpay = await payment(tzsSup, d("03-10"), "TZS", 500000, [[await payableOf(p4), 500000]]);
    await db.query("select post_supplier_payment($1,$2,$3)", [tpay, owner, key()]);
    check("TZS partial payment leaves 1,500,000", n(await one(db, "select outstanding from purchases where id=$1", [p4])) === 1500000
      && (await one(db, "select payment_status from purchases where id=$1", [p4])) === "partially_paid");
    check("TZS payment cannot settle a USD invoice", await (async () => {
      const x = await payment(usdSup, d("03-10"), "TZS", 100, [[await payableOf(p2), 100]]);
      const r = await fails(db, "select post_supplier_payment($1,$2,$3)", [x, owner, key()], "only settle TZS");
      await db.query("delete from supplier_payments where id=$1", [x]);
      return r;
    })());
    check("USD payment cannot settle a TZS invoice", await (async () => {
      const x = await payment(tzsSup, d("03-10"), "USD", 100, [[await payableOf(p4), 1]]);
      const r = await fails(db, "select post_supplier_payment($1,$2,$3)", [x, owner, key()], "only settle USD");
      await db.query("delete from supplier_payments where id=$1", [x]);
      return r;
    })());

    // ---------------------------------------------------------- foreign currency confined to purchasing
    for (const t of ["sales", "customer_receipts", "sales_returns", "expenses", "other_income_transactions", "cash_transfers", "stock_transfers", "rebag_orders", "stock_adjustments"]) {
      check(`${t} has no currency (always TZS)`, Number(await one(db,
        "select count(*) from information_schema.columns where table_schema='public' and table_name=$1 and column_name in ('currency_code','exchange_rate')", [t])) === 0);
    }
    check("foreign cost invoice (import charge) rejected", await fails(db,
      "insert into cost_invoices(company_id, branch_id, supplier_id, currency_code, exchange_rate) values ($1,$2,$3,'USD',2600)", [co, hq, usdSup], "cost_invoices_tzs_only"));
    const expCat = await one(db, "insert into expense_categories(company_id, code, name) values ($1,'EXC-T','Test') returning id", [co]);
    const exp = await one(db, `insert into expenses(company_id, branch_id, expense_category_id, supplier_id, net_total, grand_total)
                               values ($1,$2,$3,$4,10,10) returning id`, [co, hq, expCat, tzsSup]);
    check("foreign payable from an expense rejected", await fails(db,
      "insert into supplier_payables(company_id, branch_id, supplier_id, source_type, expense_id, currency_code, fc_original, fc_outstanding) values ($1,$2,$3,'expense',$4,'USD',10,10)",
      [co, hq, tzsSup, exp], "fc_purchase_only"));

    // ---------------------------------------------------------- voids / reversals
    await db.query("select void_supplier_payment($1,$2,'test reversal')", [pay2, owner]);
    s = await pbState(p1);
    check("voiding the final settlement restores USD 60,000 at the revalued TZS 159,000,000", n(s.fc) === 60000 && n(s.tzs) === 159000000 && s.st === "partial", JSON.stringify(s));
    check("void journal mirrors the payment (incl. FX and bank charges)",
      (await jl("supplier_payment_void", pay2)) === "1121:162025000/0 2110:0/159000000 6200:0/25000 6400:0/3000000", await jl("supplier_payment_void", pay2));
    await db.query("select void_purchase_return($1,$2,'test reversal')", [r2, owner]);
    s = await pbState(p3);
    check("voiding a return restores the foreign balance and carrying", n(s.fc) === 8000 && n(s.tzs) === 21600000, JSON.stringify(s));
    check("revaluation with later dependent transactions cannot be voided", await fails(db,
      "select void_fx_revaluation((select id from fx_revaluations where company_id=$1 and revaluation_date=$2),$3,'x')", [co, d("02-28"), owner], "later transactions"));
    const adv5 = await payment(usdSup, d("03-11"), "USD", 13000000, [], 5000);
    await db.query("select post_supplier_payment($1,$2,$3)", [adv5, owner, key()]);
    const adv5Id = await one(db, "select id from supplier_advances where payment_id=$1", [adv5]);
    const p5 = await purchase(usdSup, d("03-12"), "USD", 2650, [[urea, 10, 1000]], [[adv5Id, 5000]]);
    await db.query("select post_purchase($1,$2,$3)", [p5, owner, key()]);
    const stockBefore = n(await one(db, "select stock_value from stock_balances where product_id=$1 and branch_id=$2", [urea, hq]));
    await db.query("select void_purchase($1,$2,'entered twice')", [p5, owner]);
    check("voiding a foreign purchase restores its advance", (await one(db, "select status || ':' || fc_remaining || ':' || tzs_remaining from supplier_advances where id=$1", [adv5Id])) === "open:5000.00:13000000.00");
    check("voided purchase's payable is voided", (await one(db, "select status from supplier_payables where purchase_id=$1", [p5])) === "voided");
    check("purchase void keeps stock subledger = GL (D1 fixed for purchases)",
      (await gl("1150")) === n(await one(db, "select coalesce(sum(stock_value),0) from stock_balances where company_id=$1", [co]))
      && n(await one(db, "select stock_value from stock_balances where product_id=$1 and branch_id=$2", [urea, hq])) < stockBefore);

    // ---------------------------------------------------------- reconciliation and balance
    const unbalanced = Number(await one(db, `select count(*) from (select j.id from journal_entries j join journal_lines l on l.journal_id=j.id
      where j.company_id=$1 group by j.id having sum(l.debit) <> sum(l.credit)) x`, [co]));
    check("every journal balances", unbalanced === 0);
    check("A/P control 2110 = sum of supplier carrying balances",
      (await gl("2110")) === -n(await one(db, "select coalesce(sum(outstanding),0) from supplier_payables where company_id=$1 and status <> 'voided'", [co])),
      `${await gl("2110")}`);
    check("advances 1175 = sum of unapplied advance TZS",
      (await gl("1175")) === n(await one(db, "select coalesce(sum(tzs_remaining),0) from supplier_advances where company_id=$1", [co])));
    check("supplier credits 1170 = sum of credit carrying",
      (await gl("1170")) === n(await one(db, "select coalesce(sum(remaining),0) from supplier_credits where company_id=$1 and status <> 'voided'", [co])));
    check("inventory 1150 = stock subledger",
      (await gl("1150")) === n(await one(db, "select coalesce(sum(stock_value),0) from stock_balances where company_id=$1", [co])));
    check("payable event log rebuilds each foreign balance", Number(await one(db, `select count(*) from supplier_payables p
      left join lateral (select coalesce(sum(fc_delta),0) fc, coalesce(sum(tzs_delta),0) tzs from supplier_payable_events e where e.payable_id=p.id) ev on true
      where p.currency_code<>'TZS' and (p.fc_outstanding <> ev.fc or p.outstanding <> ev.tzs)`)) === 0
      && Number(await one(db, "select count(*) from supplier_payable_events")) > 0);

    console.log(`\n${passed} import Stage 3 checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nImport Stage 3 test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main();
