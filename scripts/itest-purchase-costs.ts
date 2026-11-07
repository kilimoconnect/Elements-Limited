/**
 * Purchase landed costs "Bags" and "Other" (migration 0050) reach the goods
 * wherever they are: still in stock, sold (cost of sales), transferred to
 * another branch. One transaction, ROLLED BACK. PGlite only.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-purchase-costs runs only against the PGlite test database (npm run test:db).");
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
const n = (v: unknown) => Number(v ?? 0);
let seq = 0;
const key = () => `pc-${Date.now()}-${++seq}`;

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const co = await one(db, "select id from companies where code='ELEMENTS'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    const cash = await one(db, "select id from payment_accounts where company_id=$1 and code='CASH'", [co]);
    const walkin = await one(db, "select id from customers where company_id=$1 and code='WALK-IN'", [co]);
    await db.query("update feature_flags set is_enabled=true where company_id=$1", [co]);
    const mwz = await one(db, "insert into branches(company_id, code, name) values ($1,'MWZPC','Mwanza PC') returning id", [co]);
    const sup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'PCSUP','Fertiliser Co') returning id", [co]);

    // ------------------------------------------------------------ categories
    const cat = (code: string) => db.query("select inventory_treatment, applies_to_import, is_active from cost_categories where company_id=$1 and code=$2", [co, code]).then((r) => r.rows[0]);
    const bags = await cat("BAGS"), other = await cat("PUR_OTHER");
    check("Bags and Other purchase costs exist, are capitalised and offered on purchases",
      bags?.inventory_treatment === "capitalize" && bags.applies_to_import && bags.is_active
      && other?.inventory_treatment === "capitalize" && other.applies_to_import && other.is_active);

    // ------------------------------------------------------------ 100 bags bought at 10,000
    const prod = await one(db, "insert into products(company_id, sku, name, base_unit_id, net_weight_kg) values ($1,'PC-UREA','Urea 50kg',$2,50) returning id", [co, bag]);
    const pur = await one(db, "insert into purchases(company_id, branch_id, supplier_id, document_date, supplier_invoice_number) values ($1,$2,$3,current_date,'PC-INV-1') returning id", [co, hq, sup]);
    await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, is_recoverable) values ($1,$2,100,10000,true)", [pur, prod]);
    await db.query("select post_purchase($1,$2,$3)", [pur, owner, key()]);

    // 30 sold at HQ, 20 transferred to Mwanza and received, 50 stay at HQ.
    const sale = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total) values ($1,$2,current_date,$3,$4,600000) returning id", [co, hq, walkin, owner]);
    await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, net_amount, tax_amount, line_total, track_inventory, line_no) values ($1,$2,30,20000,600000,0,600000,true,1)", [sale, prod]);
    await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,600000)", [sale, cash]);
    await db.query("select post_sale($1,$2,null)", [sale, owner]);
    const tr = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3) returning id", [co, hq, mwz]);
    const tl = await one(db, "insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,20) returning id", [tr, prod]);
    await db.query("select dispatch_stock_transfer($1,$2,$3)", [tr, owner, key()]);
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [tr, owner, JSON.stringify([{ line_id: tl, qty: 20 }]), key()]);

    const value = async (br: string) => n(await one(db, "select stock_value from stock_balances where product_id=$1 and branch_id=$2", [prod, br]));
    const hq0 = await value(hq), mwz0 = await value(mwz);
    check("before the costs: HQ 50 bags = 500,000, Mwanza 20 bags = 200,000", hq0 === 500000 && mwz0 === 200000, `${hq0} ${mwz0}`);

    const cost = async (code: string, amount: number) => {
      const src = await one(db, `insert into cost_sources(company_id, owner_type, purchase_id, cost_category_id, estimated_amount, description, allocation_basis)
        values ($1,'purchase',$2,(select id from cost_categories where company_id=$1 and code=$3),$4,$3,'quantity') returning id`, [co, pur, code, amount]);
      await db.query("select accrue_purchase_cost($1,$2,current_date,$3,$4)", [src, amount, owner, key()]);
      return src;
    };
    const to = async (src: string, t: string) => n(await one(db, "select coalesce(sum(amount),0) from cost_delta_lines where src_id=$1 and target=$2", [src, t]));

    // Bags 100,000 on 100 bags = 1,000 per bag.
    const sBags = await cost("BAGS", 100000);
    check("Bags 100,000: 50,000 to HQ stock, 20,000 to Mwanza stock, 30,000 to cost of sales for the 30 sold",
      await value(hq) === hq0 + 50000 && await value(mwz) === mwz0 + 20000 && (await to(sBags, "cogs")) === 30000,
      `${await value(hq)} ${await value(mwz)} ${await to(sBags, "cogs")}`);
    const sOther = await cost("PUR_OTHER", 50000);
    check("Other 50,000 spreads the same way: 25,000 HQ, 10,000 Mwanza, 15,000 cost of sales",
      await value(hq) === hq0 + 75000 && await value(mwz) === mwz0 + 30000 && (await to(sOther, "cogs")) === 15000);
    // ------------------------------------------------------------ posted with its supplier in one step (no accrual)
    const haul = await one(db, "insert into suppliers(company_id, code, name) values ($1,'PCHAUL','Bags Supplier Ltd') returning id", [co]);
    const sDirect = await one(db, `insert into cost_sources(company_id, owner_type, purchase_id, cost_category_id, estimated_amount, description, allocation_basis, supplier_id)
      values ($1,'purchase',$2,(select id from cost_categories where company_id=$1 and code='BAGS'),40000,'Bags','quantity',$3) returning id`, [co, pur, haul]);
    const ci = await one(db, `insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number, document_kind)
      values ($1,$2,$3,current_date,'BAGS-77','invoice') returning id`, [co, hq, haul]);
    await db.query(`insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount)
      values ($1,$2,(select id from cost_categories where company_id=$1 and code='BAGS'),$3,40000)`, [co, ci, sDirect]);
    const hq1 = await value(hq), mwz1 = await value(mwz);
    await db.query("select post_cost_invoice($1,$2,$3)", [ci, owner, key()]);
    const jl = (await db.query<{ code: string; d: string; c: string }>(`select a.code, sum(l.debit)::text d, sum(l.credit)::text c from journal_entries j
      join journal_lines l on l.journal_id = j.id join chart_of_accounts a on a.id = l.account_id
      where j.source_type = 'cost_invoice' and j.source_id = $1 group by a.code order by a.code`, [ci])).rows.map((r) => `${r.code}:${n(r.d)}/${n(r.c)}`).join(" ");
    check("posted with a supplier: Dr inventory 28,000 + cost of sales 12,000 / Cr Accounts Payable 40,000 (balance sheet)",
      jl === "1150:28000/0 2110:0/40000 5100:12000/0", jl);
    check("the goods pick it up wherever they are: HQ +20,000, Mwanza +8,000",
      await value(hq) === hq1 + 20000 && await value(mwz) === mwz1 + 8000);
    check("the supplier is owed 40,000",
      n(await one(db, "select coalesce(sum(outstanding),0) from supplier_payables where supplier_id=$1", [haul])) === 40000);

    check("every shilling of both costs is accounted for",
      n(await one(db, "select coalesce(sum(amount),0) from cost_delta_lines where src_id = any($1::uuid[])", [[sBags, sOther]])) === 150000);
    check("the ledger still balances", n(await one(db, `select count(*) from (select j.id from journal_entries j join journal_lines l on l.journal_id=j.id
      where j.company_id=$1 group by j.id having sum(l.debit) <> sum(l.credit)) x`, [co])) === 0);

    console.log(`\nPurchase landed costs: ${passed} checks passed.`);
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
