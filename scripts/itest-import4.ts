/**
 * Import upgrade - Stage 4 (import shipments and landed cost).
 * One transaction, ROLLED BACK. PGlite test database only (npm run test:db).
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-import4 runs only against the PGlite test database (npm run test:db).");
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
const key = () => `stage4-key-${++k}-${Math.random().toString(36).slice(2)}`;
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
    const mwz = await one(db, "insert into branches(company_id, code, name) values ($1,'MWZ','Mwanza') returning id", [co]);
    const kg = await one(db, "select id from units where company_id=$1 and code='KG'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    const urea = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'UREA-B','Urea bulk',$2,'bulk') returning id", [co, kg]);
    const dap = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'DAP-B','DAP bulk',$2,'bulk') returning id", [co, kg]);
    const can = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'CAN-B','CAN bulk',$2,'bulk') returning id", [co, kg]);
    const urea50 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,'UREA-50','Urea 50kg',$2,'packaged',50,$3) returning id", [co, bag, urea]);
    const sup = (code: string) => one(db, "insert into suppliers(company_id, code, name) values ($1,$2,$2) returning id", [co, code]);
    const yara = await sup("YARA"), port = await sup("TPA"), clear = await sup("CLEARCO"), store = await sup("WAREHOUSE");
    const cat = (code: string) => one(db, "select id from cost_categories where company_id=$1 and code=$2", [co, code]);
    const gl = async (code: string) => n(await one(db, `select coalesce(sum(l.debit-l.credit),0) from journal_lines l join journal_entries j on j.id=l.journal_id
       where j.company_id=$1 and l.account_id=(select id from chart_of_accounts where company_id=$1 and code=$2)`, [co, code]));
    const jl = async (st: string, sid: string) => (await db.query<{ code: string; d: string; c: string }>(
      `select c.code, sum(l.debit)::text d, sum(l.credit)::text c from journal_entries j join journal_lines l on l.journal_id=j.id
       join chart_of_accounts c on c.id=l.account_id where j.source_type=$1 and j.source_id=$2 group by c.code order by c.code`, [st, sid]))
      .rows.map((r) => `${r.code}:${n(r.d)}/${n(r.c)}`).join(" ");
    const stock = async (prod: string, br = hq) => (await db.query<{ q: string; v: string; a: string }>(
      "select quantity::text q, stock_value::text v, avg_unit_cost::text a from stock_balances where product_id=$1 and branch_id=$2", [prod, br])).rows[0];
    const ledger = async (sh: string, keyName: string) => n(await one(db, "select coalesce(sum(amount),0) from import_shipment_ledger where shipment_id=$1 and account_key=$2", [sh, keyName]));

    const shipment = async (opts: { incoterm?: string; freight?: boolean; insurance?: boolean; cur?: string; event?: string; planning?: number }) =>
      one(db, `insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance,
                 currency_code, named_place, ownership_event, planning_rate) values ($1,$2,$3,$4,$5,$6,$7,'Dar es Salaam',$8,$9) returning id`,
        [co, hq, yara, opts.incoterm ?? "CIF", opts.freight ?? true, opts.insurance ?? true, opts.cur ?? "TZS", opts.event ?? "bill_of_lading", opts.planning ?? null]);
    const line = (sh: string, prod: string, kgs: number, value: number, no = 1) =>
      one(db, "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg, fc_amount, line_no) values ($1,$2,$3,$4,$4,$5,$6) returning id",
        [co, sh, prod, kgs, value, no]);
    const source = (sh: string, catCode: string, est: number) => cat(catCode).then((c) =>
      one(db, "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount) values ($1,'import_shipment',$2,$3,$4) returning id", [co, sh, c, est]));
    const goodsInvoice = async (sh: string, lines: [string, string, number, number][], cur = "TZS", rate = 1, date = d("01-05"), no = "INV-1") => {
      const id = await one(db, `insert into purchases(company_id, branch_id, supplier_id, document_date, currency_code, exchange_rate, rate_source,
                                  import_shipment_id, posting_mode, supplier_invoice_number) values ($1,$2,$3,$4,$5,$6,$7,$8,'invoice_only',$9) returning id`,
        [co, hq, yara, date, cur, rate, cur === "TZS" ? null : "manual", sh, no]);
      for (const [shLine, prod, qty, price] of lines) {
        await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, import_shipment_line_id, is_recoverable) values ($1,$2,$3,$4,$5,true)", [id, prod, qty, price, shLine]);
      }
      return id;
    };
    const costInvoice = async (supplier: string, date: string, lines: [string, string | null, number][], no: string, kind = "invoice", credited: string | null = null) => {
      const id = await one(db, `insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number, document_kind, credited_invoice_id)
                               values ($1,$2,$3,$4,$5,$6,$7) returning id`, [co, hq, supplier, date, no, kind, credited]);
      for (const [catCode, src, amt] of lines) {
        await db.query("insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount) values ($1,$2,$3,$4,$5)",
          [co, id, await cat(catCode), src, amt]);
      }
      return id;
    };
    const receipt = async (sh: string, date: string, lines: [string, number, boolean, string | null][], branch = hq, rate: number | null = null) => {
      const id = await one(db, "insert into import_receipts(company_id, shipment_id, branch_id, receipt_date, goods_accrual_rate) values ($1,$2,$3,$4,$5) returning id", [co, sh, branch, date, rate]);
      let i = 0;
      for (const [shLine, kgs, final, resolution] of lines) {
        await db.query(`insert into import_receipt_lines(company_id, receipt_id, shipment_line_id, quantity_received, net_kg_received, is_final, resolution, weighbridge_ref, batch_code, line_no)
                        values ($1,$2,$3,$4,$4,$5,$6,'WB-'||$7::text,'LOT-'||$7::text,$8)`, [co, id, shLine, kgs, final, resolution, String(i + 1), ++i]);
      }
      return id;
    };

    // ---------------------------------------------------------- gates and validation
    const sh0 = await shipment({});
    check("packaged bags cannot be imported", await fails(db,
      "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg) values ($1,$2,$3,10,500)", [co, sh0, urea50], "packaged"));
    check("bulk quantity must equal net kg", await fails(db,
      "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg) values ($1,$2,$3,10,500)", [co, sh0, urea], "net kg"));
    check("shipment gets a document number", ((await one(db, "select document_number from import_shipments where id=$1", [sh0])) ?? "").startsWith("IMP"));
    check("import functions blocked while the imports flag is off", await fails(db,
      "select recognise_import_ownership($1,$2,null,$3,$4)", [sh0, d("01-01"), owner, key()], "not enabled"));
    await db.query("update feature_flags set is_enabled=true where company_id=$1 and flag_key in ('imports','fx_settlement')", [co]);

    // ---------------------------------------------------------- acceptance: 100 MT, TZS 80M + 10M, storage 2M expensed
    const sh = await shipment({});
    const ln = await line(sh, urea, 100000, 80000000);
    check("freight cannot be added to a CIF shipment (already in goods value)", await fails(db,
      "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id) values ($1,'import_shipment',$2,$3)", [co, sh, await cat("FREIGHT")], "already includes freight"));
    const srcPort = await source(sh, "PORT", 6000000);
    const srcClear = await source(sh, "CLEARING", 4000000);
    const srcStore = await source(sh, "STORAGE", 2000000);
    check("ready needs a named place / lines", (await failMsg(db, "select set_import_shipment_status($1,'ready',null,$2)", [sh, owner])) === null);
    await db.query("select set_import_shipment_status($1,'dispatched',$2,$3)", [sh, d("01-03"), owner]);
    const sheetEst = (await db.query<Record<string, string>>("select * from landed_cost_sheet($1)", [sh])).rows[0];
    check("estimate sheet: 80M goods + 10M capitalised = 900/kg; commercial adds storage", n(sheetEst.est_total) === 90000000 && n(sheetEst.est_per_kg) === 900
      && n(sheetEst.commercial_extra) === 2000000, JSON.stringify(sheetEst));
    check("estimates post no journals", Number(await one(db, "select count(*) from journal_entries where source_id = any($1)", [[srcPort, srcClear, srcStore]])) === 0);

    const gi = await goodsInvoice(sh, [[ln, urea, 100000, 800]]);
    await db.query("select post_import_goods_invoice($1,$2,$3)", [gi, owner, key()]);
    check("goods invoice before ownership: Dr 2130 / Cr 2110 80M, no stock", (await jl("purchase", gi)) === "2110:0/80000000 2130:80000000/0"
      && (await stock(urea)) === undefined, await jl("purchase", gi));
    await db.query("select recognise_import_ownership($1,$2,null,$3,$4)", [sh, d("01-06"), owner, key()]);
    check("ownership at B/L: Dr 1157 / Cr 2130 80M; GR/IR cleared", (await jl("import_ownership", sh)) === "1157:80000000/0 2130:0/80000000"
      && (await ledger(sh, "grir")) === 0);
    // The approved accrual amount (here equal to the 6M estimate) is recorded explicitly.
    await db.query("select accrue_import_cost($1,6000000,$2,$3,$4)", [srcPort, d("01-07"), owner, key()]);
    check("approved accrual: Dr 1157 / Cr 2140 6M (explicit)", (await jl("cost_accrual", srcPort)) === "1157:6000000/0 2140:0/6000000", await jl("cost_accrual", srcPort));
    check("only estimated costs can be accrued (no double accrual)", await fails(db, "select accrue_import_cost($1,6000000,$2,$3,$4)", [srcPort, d("01-07"), owner, key()], "only an estimated"));

    const kr1 = key();
    const r1 = await receipt(sh, d("01-10"), [[ln, 60000, false, null]]);
    await db.query("select post_import_receipt($1,$2,$3)", [r1, owner, kr1]);
    let s = await stock(urea);
    check("partial receipt 60,000 kg at 860/kg (goods + accrued port)", n(s.q) === 60000 && n(s.v) === 51600000, JSON.stringify(s));
    check("receipt journal: Dr 1150 / Cr 1157 51.6M", (await jl("import_receipt", r1)) === "1150:51600000/0 1157:0/51600000");
    await db.query("select post_import_receipt($1,$2,$3)", [r1, owner, kr1]);
    check("retried receipt does not duplicate stock", n((await stock(urea)).q) === 60000
      && Number(await one(db, "select count(*) from stock_movements where source_type='import_receipt' and source_id=$1", [r1])) === 1);
    check("imported bulk increases bulk stock only (no bags created)", (await stock(urea50)) === undefined);
    check("receipt line carries weighbridge, batch and a provenance lot",
      (await one(db, "select weighbridge_ref || '|' || batch_code || '|' || (lot_id is not null) from import_receipt_lines where receipt_id=$1", [r1])) === "WB-1|LOT-1|true");

    // A sale of 10,000 kg between receipts.
    const cogs1 = n(await one(db, "select record_stock_movement($1,$2,$3,'sale','sale',gen_random_uuid(),'S-1',0,10000,0,$4)", [co, hq, urea, owner]));
    await db.query("select create_journal($1,$2,$3,'sale',gen_random_uuid(),'S-1','sale',$4,$5::jsonb)", [co, hq, d("01-11"), owner,
      JSON.stringify([{ account_id: await one(db, "select account_for($1,'inventory.cost_of_sales')", [co]), debit: cogs1, credit: 0 },
                      { account_id: await one(db, "select id from chart_of_accounts where company_id=$1 and code='1150'", [co]), debit: 0, credit: cogs1 }])]);

    const ciClear = await costInvoice(clear, d("01-12"), [["CLEARING", srcClear, 4000000]], "CLR-77");
    await db.query("select post_cost_invoice($1,$2,$3)", [ciClear, owner, key()]);
    check("late clearing cost 4M: 2.0M to stock held, 0.4M to cost of sales, 1.6M still in transit",
      (await jl("cost_invoice", ciClear)) === "1150:2000000/0 1157:1600000/0 2110:0/4000000 5100:400000/0", await jl("cost_invoice", ciClear));
    check("capitalised cost line without a shipment link rejected", await (async () => {
      const x = await costInvoice(clear, d("01-12"), [["PORT", null, 100]], "X-1");
      const r = await fails(db, "select post_cost_invoice($1,$2,$3)", [x, owner, key()], "must be linked");
      await db.query("delete from cost_invoices where id=$1", [x]); return r;
    })());
    check("second actual invoice on the same cost rejected", await (async () => {
      const x = await costInvoice(clear, d("01-12"), [["CLEARING", srcClear, 100]], "X-2");
      const r = await fails(db, "select post_cost_invoice($1,$2,$3)", [x, owner, key()], "already has its actual");
      await db.query("delete from cost_invoices where id=$1", [x]); return r;
    })());

    const r2 = await receipt(sh, d("01-15"), [[ln, 40000, true, null]]);
    await db.query("select post_import_receipt($1,$2,$3)", [r2, owner, key()]);
    s = await stock(urea);
    check("final receipt takes the exact remainder: 90,000 kg on hand at 900/kg", n(s.q) === 90000 && n(s.v) === 81000000 && n(s.a) === 900, JSON.stringify(s));
    check("receiving more than in transit rejected", await (async () => {
      const x = await receipt(sh, d("01-15"), [[ln, 1, true, null]]);
      const r = await fails(db, "select post_import_receipt($1,$2,$3)", [x, owner, key()], "receiv");
      await db.query("delete from import_receipts where id=$1", [x]); return r;
    })());

    const ciPort = await costInvoice(port, d("01-20"), [["PORT", srcPort, 6000000]], "TPA-9");
    await db.query("select post_cost_invoice($1,$2,$3)", [ciPort, owner, key()]);
    check("actual equal to the accrual: Dr 2140 / Cr 2110, cost unchanged", (await jl("cost_invoice", ciPort)) === "2110:0/6000000 2140:6000000/0", await jl("cost_invoice", ciPort));
    const ciStore = await costInvoice(store, d("01-25"), [["STORAGE", srcStore, 2000000]], "WH-3");
    await db.query("select post_cost_invoice($1,$2,$3)", [ciStore, owner, key()]);
    check("storage 2M is expensed (6150), stock value unchanged", (await jl("cost_invoice", ciStore)) === "2110:0/2000000 6150:2000000/0"
      && n((await stock(urea)).v) === 81000000);
    check("cost of sales = 10,000 kg x 900", n(await one(db, `select coalesce(sum(l.debit-l.credit),0) from journal_lines l join journal_entries j on j.id=l.journal_id
      where j.company_id=$1 and l.account_id=(select account_for($1,'inventory.cost_of_sales'))`, [co])) === 9000000);

    const sheet = (await db.query<Record<string, string>>("select * from landed_cost_sheet($1)", [sh])).rows[0];
    check("ACCEPTANCE: 100,000 kg at TZS 900/kg (80M + 10M)", n(sheet.act_total) === 90000000 && n(sheet.act_per_kg) === 900, JSON.stringify(sheet));
    check("ACCEPTANCE: storage appears in commercial cost only (92M, 920/kg)", n(sheet.commercial_total) === 92000000 && n(sheet.commercial_per_kg) === 920);
    check("partial receipts + allocations reconcile to the shipment total",
      n(await one(db, "select sum(value_tzs + cost_delta_tzs) from import_receipt_lines where shipment_line_id=$1", [ln])) === 90000000);
    check("control ledger: goods in transit, GR/IR and accruals all zero",
      (await ledger(sh, "git")) === 0 && (await ledger(sh, "grir")) === 0 && (await ledger(sh, "accrual")) === 0);
    const checks = (await db.query<{ check_key: string; ok: boolean }>("select * from import_finalization_checks($1)", [sh])).rows;
    check("all finalisation checks pass", checks.every((c) => c.ok), JSON.stringify(checks));
    const kf = key();
    await db.query("select finalize_import_shipment($1,$2,$3)", [sh, owner, kf]);
    check("shipment finalised and closed", (await one(db, "select cost_status || '/' || logistics_status from import_shipments where id=$1", [sh])) === "finalized/closed");
    check("accrual on a finalised shipment rejected", await (async () => {
      const x = await source(sh, "INSPECTION", 100);
      return fails(db, "select accrue_import_cost($1,100,$2,$3,$4)", [x, d("01-26"), owner, key()], "finalised");
    })());
    const credit = await costInvoice(clear, d("01-28"), [["CLEARING", srcClear, 500000]], "CLR-77-CN", "credit_note", ciClear);
    await db.query("select post_cost_invoice($1,$2,$3)", [credit, owner, key()]);
    check("credit note after finalisation is a linked negative adjustment", (await one(db, "select cost_status from import_shipments where id=$1", [sh])) === "adjusted"
      && n((await stock(urea)).v) < 81000000 && n(await one(db, "select actual_amount from cost_sources where id=$1", [srcClear])) === 3500000);

    // ---------------------------------------------------------- foreign shipment, ownership before invoice, transfer
    const shf = await shipment({ incoterm: "CFR", freight: true, insurance: false, cur: "USD", planning: 2600 });
    const lf = await line(shf, dap, 50000, 20000);
    await db.query("select set_import_shipment_status($1,'dispatched',$2,$3)", [shf, d("02-01"), owner]);
    check("ownership on a foreign shipment needs an accrual rate", await fails(db,
      "select recognise_import_ownership($1,$2,null,$3,$4)", [shf, d("02-02"), owner, key()], "exchange rate"));
    await db.query("select recognise_import_ownership($1,$2,2600,$3,$4)", [shf, d("02-02"), owner, key()]);
    const rf = await receipt(shf, d("02-10"), [[lf, 50000, true, null]]);
    await db.query("select post_import_receipt($1,$2,$3)", [rf, owner, key()]);
    check("USD goods accrued at 2,600: 50,000 kg at 1,040/kg", n((await stock(dap)).v) === 52000000);
    const tr = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3) returning id", [co, hq, mwz]);
    await db.query("insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,20000)", [tr, dap]);
    await db.query("select dispatch_stock_transfer($1,$2,$3)", [tr, owner, key()]);
    const tl = await one(db, "select id from stock_transfer_lines where transfer_id=$1", [tr]);
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [tr, owner, JSON.stringify([{ line_id: tl, qty: 10000 }]), key()]);
    const gif = await goodsInvoice(shf, [[lf, dap, 50000, 0.4]], "USD", 2650, d("02-20"), "YARA-USD-1");
    await db.query("select post_import_goods_invoice($1,$2,$3)", [gif, owner, key()]);
    check("invoice at 2,650: +1M goods value reaches HQ held (0.6M), Mwanza (0.2M), in-transit (0.2M)",
      n((await stock(dap)).v) === 31800000 && n((await stock(dap, mwz)).v) === 10600000
      && n(await one(db, "select unit_cost from stock_transfer_lines where id=$1", [tl])) === 1060, `${(await stock(dap)).v} ${(await stock(dap, mwz))?.v}`);
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [tr, owner, JSON.stringify([{ line_id: tl, qty: 10000 }]), key()]);
    check("remaining transfer arrives at the adjusted cost: everything at 1,060/kg (= 53M / 50,000 kg)",
      n((await stock(dap, mwz)).v) === 21200000 && n((await stock(dap)).v) + n((await stock(dap, mwz)).v) === 53000000);
    check("foreign shipment GR/IR cleared; payable USD 20,000 at TZS 53M",
      (await ledger(shf, "grir")) === 0 && (await one(db, "select fc_outstanding || '/' || outstanding from supplier_payables where purchase_id=$1", [gif])) === "20000.00/53000000.00");

    // ---------------------------------------------------------- correcting a goods invoice (void, then re-invoice)
    check("purchase void path stays blocked for import invoices", await fails(db,
      "update purchases set document_status='voided' where id=$1", [gif], "voided from the shipment"));
    check("void needs a reason", await fails(db, "select void_import_goods_invoice($1,$2,'  ',$3)", [gif, owner, key()], "reason"));
    const kv = key();
    await db.query("select void_import_goods_invoice($1,$2,'Wrong rate',$3)", [gif, owner, kv]);
    check("void of the USD invoice: Dr 2110 53M / Cr 2130, value back to the 2,600 accrual (-1M across HQ and Mwanza)",
      n((await stock(dap)).v) === 31200000 && n((await stock(dap, mwz)).v) === 20800000
      && (await one(db, "select status || '/' || outstanding || '/' || fc_outstanding from supplier_payables where purchase_id=$1", [gif])) === "voided/0.00/0.00",
      `${(await stock(dap)).v} ${(await stock(dap, mwz)).v} ${await jl("purchase_void", gif)}`);
    check("voided invoice reopens GR/IR at the provisional value (52M) and the line's invoiced quantity",
      (await ledger(shf, "grir")) === -52000000 && n(await one(db, "select goods_invoiced_qty from import_shipment_lines where id=$1", [lf])) === 0);
    await db.query("select void_import_goods_invoice($1,$2,'Wrong rate',$3)", [gif, owner, kv]);
    check("void retry posts nothing more", Number(await one(db, "select count(*) from journal_entries where source_type='purchase_void' and source_id=$1", [gif])) === 1);
    check("a voided invoice cannot be voided again", await fails(db, "select void_import_goods_invoice($1,$2,'again',$3)", [gif, owner, key()], "only posted"));
    const gif2 = await goodsInvoice(shf, [[lf, dap, 50000, 0.4]], "USD", 2650, d("02-21"), "YARA-USD-1R");
    await db.query("select post_import_goods_invoice($1,$2,$3)", [gif2, owner, key()]);
    check("replacement invoice restores 53M (1,060/kg) and clears GR/IR",
      n((await stock(dap)).v) + n((await stock(dap, mwz)).v) === 53000000 && (await ledger(shf, "grir")) === 0);

    // ---------------------------------------------------------- late cost after a sale that was voided
    const sop = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'SOP-B','SOP bulk',$2,'bulk') returning id", [co, kg]);
    const shr = await shipment({});
    const lr = await line(shr, sop, 1000, 1000000);
    const srcR = await source(shr, "CLEARING", 100000);
    await db.query("select set_import_shipment_status($1,'dispatched',$2,$3)", [shr, d("04-01"), owner]);
    await db.query("select recognise_import_ownership($1,$2,null,$3,$4)", [shr, d("04-02"), owner, key()]);
    await db.query("select post_import_receipt($1,$2,$3)", [await receipt(shr, d("04-03"), [[lr, 1000, true, null]]), owner, key()]);
    const giR = await goodsInvoice(shr, [[lr, sop, 1000, 1000]], "TZS", 1, d("04-03"), "SOP-1");
    await db.query("select post_import_goods_invoice($1,$2,$3)", [giR, owner, key()]);
    const cogsAcc = await one(db, "select account_for($1,'inventory.cost_of_sales')", [co]);
    const inv1150 = await one(db, "select id from chart_of_accounts where company_id=$1 and code='1150'", [co]);
    const saleMove = async (type: string, saleId: string, qIn: number, qOut: number, cost: number) => {
      const v = n(await one(db, "select record_stock_movement($1,$2,$3,$4,$4,$5,'S-X',$6,$7,$8,$9)", [co, hq, sop, type, saleId, qIn, qOut, cost, owner]));
      const val = qOut > 0 ? v : qIn * cost;
      await db.query("select create_journal($1,$2,$3,$4,$5,'S-X','sale',$6,$7::jsonb)", [co, hq, d("04-04"), type, saleId, owner,
        JSON.stringify([{ account_id: qOut > 0 ? cogsAcc : inv1150, debit: val, credit: 0 }, { account_id: qOut > 0 ? inv1150 : cogsAcc, debit: 0, credit: val }])]);
    };
    const saleA = await one(db, "select gen_random_uuid()"), saleB = await one(db, "select gen_random_uuid()"), saleC = await one(db, "select gen_random_uuid()");
    await saleMove("sale", saleA, 0, 400, 0);
    await saleMove("sale", saleC, 0, 100, 0);
    await saleMove("sale_void", saleA, 400, 0, 1000);
    await saleMove("sale", saleB, 0, 200, 0);
    const ciR = await costInvoice(clear, d("04-05"), [["CLEARING", srcR, 100000]], "CLR-SOP");
    await db.query("select post_cost_invoice($1,$2,$3)", [ciR, owner, key()]);
    check("late cost follows units of a voided sale back into stock: 70k held (700 kg), 30k cost of sales (300 kg sold)",
      (await jl("cost_invoice", ciR)) === "1150:70000/0 2110:0/100000 5100:30000/0" && n((await stock(sop)).v) === 770000,
      `${await jl("cost_invoice", ciR)} ${(await stock(sop)).v}`);

    // ---------------------------------------------------------- shortfall resolution
    const shs = await shipment({ event: "receipt" });
    const ls = await line(shs, can, 1000, 1000000);
    await db.query("select set_import_shipment_status($1,'dispatched',$2,$3)", [shs, d("03-01"), owner]);
    const rs = await receipt(shs, d("03-05"), [[ls, 990, true, null]]);
    check("final shortfall needs a resolution", await fails(db, "select post_import_receipt($1,$2,$3)", [rs, owner, key()], "resolve"));
    await db.query("update import_receipt_lines set resolution='write_off' where receipt_id=$1", [rs]);
    await db.query("select post_import_receipt($1,$2,$3)", [rs, owner, key()]);
    check("ownership on receipt + 10 kg write-off: Dr 1150 990k, Dr 6300 10k, net zero through 1157/2130",
      (await jl("import_receipt", rs)) === "1150:990000/0 1157:1000000/1000000 2130:0/1000000 6300:10000/0", await jl("import_receipt", rs));

    // ---------------------------------------------------------- permissions
    const keeper = await one(db, "insert into auth.users(email) values ('k4@test.local') returning id");
    await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active)
                    values ($1,'k4@test.local','K',(select id from roles where code='STOREKEEPER'),$2,true)`, [keeper, co]);
    await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [keeper, co]);
    await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [keeper, hq]);
    const shp = await shipment({});
    const lp = await line(shp, urea, 100, 100000);
    const sp1 = await source(shp, "PORT", 1000);
    check("storekeeper cannot accrue import costs", await fails(db, "select accrue_import_cost($1,1000,$2,$3,$4)", [sp1, d("03-02"), keeper, key()], "imports.post"));
    await db.query("select set_import_shipment_status($1,'dispatched',$2,$3)", [shp, d("03-02"), owner]);
    await db.query("select recognise_import_ownership($1,$2,null,$3,$4)", [shp, d("03-03"), owner, key()]);
    const rp = await receipt(shp, d("03-04"), [[lp, 100, true, null]]);
    check("storekeeper cannot void goods invoices (imports.void)", await fails(db,
      "select void_import_goods_invoice($1,$2,'x',$3)", [gif2, keeper, key()], "imports.void"));
    check("app users cannot call the goods-invoice void",
      (await one<boolean>(db, "select has_function_privilege('authenticated','public.void_import_goods_invoice(uuid,uuid,text,text)','execute')")) === false);
    check("storekeeper can receive (imports.receive)", (await failMsg(db, "select post_import_receipt($1,$2,$3)", [rp, keeper, key()])) === null);
    check("app users cannot call import posting functions",
      (await one<boolean>(db, "select has_function_privilege('authenticated','public.post_import_receipt(uuid,uuid,text)','execute')")) === false
      && (await one<boolean>(db, "select has_function_privilege('authenticated','public.post_cost_invoice(uuid,uuid,text)','execute')")) === false);

    // ---------------------------------------------------------- reconciliation
    check("every journal balances", Number(await one(db, `select count(*) from (select j.id from journal_entries j join journal_lines l on l.journal_id=j.id
      where j.company_id=$1 group by j.id having sum(l.debit) <> sum(l.credit)) x`, [co])) === 0);
    const sub1150 = n(await one(db, "select coalesce(sum(stock_value),0) from stock_balances where company_id=$1", [co]));
    const inTransitVal = n(await one(db, "select coalesce(sum((l.qty_dispatched-l.qty_received)*l.unit_cost),0) from stock_transfer_lines l join stock_transfers t on t.id=l.transfer_id where t.company_id=$1 and t.status in ('dispatched','partially_received')", [co]));
    check("1150 GL = stock subledger (+ branch transfers in transit)", (await gl("1150")) === sub1150 + inTransitVal, `${await gl("1150")} vs ${sub1150}+${inTransitVal}`);
    check("1157 GL = goods in transit on shipment lines = control ledger",
      (await gl("1157")) === n(await one(db, "select coalesce(sum(git_value),0) from import_shipment_lines where company_id=$1", [co]))
      && (await gl("1157")) === n(await one(db, "select coalesce(sum(amount),0) from import_shipment_ledger where company_id=$1 and account_key='git'", [co])));
    check("2130 GL = GR/IR control ledger", (await gl("2130")) === n(await one(db, "select coalesce(sum(amount),0) from import_shipment_ledger where company_id=$1 and account_key='grir'", [co])));
    check("2140 GL = accrual control ledger", (await gl("2140")) === n(await one(db, "select coalesce(sum(amount),0) from import_shipment_ledger where company_id=$1 and account_key='accrual'", [co])));

    console.log(`\n${passed} import Stage 4 checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nImport Stage 4 test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main();
