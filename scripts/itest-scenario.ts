/**
 * Stage 9 — the full end-to-end scenario, in one rolled-back transaction on
 * the PGlite test database:
 *
 *   USD purchase → TZS accounting → approved provisional import costs →
 *   partial bulk receipts → actual clearing invoice → mixed 50/25/5 kg
 *   rebagging with packaging inventory → dispatch with driver / agent
 *   documents and delivery note → sender / receiver in-transit view →
 *   partial receipt and offloading cost → approved shortage / damage →
 *   branch sale → late transport invoice → supplier partial settlement and
 *   FX difference → period close → permitted subsequent adjustment.
 *
 * Every step checks its numbers; the end reconciles inventory, in-transit
 * stock, AP, accruals, FX, cost of sales and the GL.
 */
import { writeFileSync } from "node:fs";
import { createDbClient } from "./db";
import type { Client } from "pg";
import { renderDeliveryNote, type DeliveryNoteSnapshot } from "../src/lib/transfers/delivery-note";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-scenario runs only against the PGlite test database (npm run test:db).");
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
let k = 0;
const key = () => `scenario-key-${++k}-${Math.random().toString(36).slice(2)}`;
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
    const mwz = await one(db, "insert into branches(company_id, code, name, address) values ($1,'MWZ','Mwanza','Nyakato Rd, Mwanza') returning id", [co]);
    const aru = await one(db, "insert into branches(company_id, code, name) values ($1,'ARU','Arusha') returning id", [co]);
    const kg = await one(db, "select id from units where company_id=$1 and code='KG'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    const nmb = await one(db, "select id from payment_accounts where company_id=$1 and code='NMB'", [co]);
    const cash = await one(db, "select id from payment_accounts where company_id=$1 and code='CASH'", [co]);
    const walkin = await one(db, "select id from customers where company_id=$1 and code='WALK-IN'", [co]);
    await db.query("update payment_accounts set allow_negative=true, overdraft_limit=10000000000 where id=$1", [nmb]);
    await db.query("update feature_flags set is_enabled=true where company_id=$1", [co]);
    const acc = (code: string) => one(db, "select id from chart_of_accounts where company_id=$1 and code=$2", [co, code]);
    const gl = async (code: string) => n(await one(db, `select coalesce(sum(l.debit-l.credit),0) from journal_lines l join journal_entries j on j.id=l.journal_id
       where j.company_id=$1 and l.account_id=(select id from chart_of_accounts where company_id=$1 and code=$2)`, [co, code]));
    const jl = async (st: string, sid: string) => (await db.query<{ code: string; d: string; c: string }>(
      `select c.code, sum(l.debit)::text d, sum(l.credit)::text c from journal_entries j join journal_lines l on l.journal_id=j.id
       join chart_of_accounts c on c.id=l.account_id where j.source_type=$1 and j.source_id=$2 group by c.code order by c.code`, [st, sid]))
      .rows.map((r) => `${r.code}:${n(r.d)}/${n(r.c)}`).join(" ");
    const stock = async (prod: string, br: string) => (await db.query<{ q: string; v: string; a: string }>(
      "select quantity::text q, stock_value::text v, avg_unit_cost::text a from stock_balances where product_id=$1 and branch_id=$2", [prod, br])).rows[0] ?? { q: "0", v: "0", a: "0" };
    const cat = (code: string) => one(db, "select id from cost_categories where company_id=$1 and code=$2", [co, code]);
    const user = async (email: string, role: string, branches: string[]) => {
      const id = await one(db, "insert into auth.users(email) values ($1) returning id", [email]);
      await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active) values ($1,$2,$2,(select id from roles where code=$3),$4,true)`, [id, email, role, co]);
      await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [id, co]);
      for (const b of branches) await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [id, b]);
      return id;
    };
    const sender = await user("sender@scenario.test", "STOREKEEPER", [hq]);
    const receiver = await user("receiver@scenario.test", "STOREKEEPER", [mwz]);
    const outsider = await user("outsider@scenario.test", "STOREKEEPER", [aru]);
    const accountant = await user("accountant@scenario.test", "ACCOUNTANT", [hq, mwz, aru]);
    const a1150 = await acc("1150"), a3200 = await acc("3200");
    const opening = async (prod: string, qty: number, value: number) => {
      await db.query("select record_stock_movement_value($1,$2,$3,'opening','opening',gen_random_uuid(),'OPEN',$4,$5,$6)", [co, hq, prod, qty, value, owner]);
      await db.query("select create_journal($1,$2,$3,'opening',gen_random_uuid(),'OPEN','opening',$4,$5::jsonb)", [co, hq, d("05-31"), owner,
        JSON.stringify([{ account_id: a1150, debit: value, credit: 0 }, { account_id: a3200, debit: 0, credit: value }])]);
    };
    const supplier = (code: string) => one(db, "insert into suppliers(company_id, code, name) values ($1,$2,$2) returning id", [co, code]);
    const costInvoice = async (sup: string, src: string, catCode: string, amt: number, date: string, kind = "invoice", credited: string | null = null, branch = hq) => {
      const id = await one(db, `insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number, document_kind, credited_invoice_id)
        values ($1,$2,$3,$4,$5,$6,$7) returning id`, [co, branch, sup, date, `S-${k}-${Math.random().toString(36).slice(2, 6)}`, kind, credited]);
      await db.query("insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount) values ($1,$2,$3,$4,$5)", [co, id, await cat(catCode), src, amt]);
      return id;
    };

    // ---------------------------------------------------------------- products and packaging inventory
    const urea = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'UREA','Urea bulk',$2,'bulk') returning id", [co, kg]);
    const pack = (sku: string, kgs: number) => one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,$2,$2,$3,'packaged',$4,$5) returning id", [co, sku, bag, kgs, urea]);
    const u50 = await pack("UREA-50", 50), u25 = await pack("UREA-25", 25), u5 = await pack("UREA-5", 5);
    const mat = (sku: string) => one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,$2,$2,$3,'packaging_material') returning id", [co, sku, bag]);
    const eb50 = await mat("EMPTY-50"), eb25 = await mat("EMPTY-25"), eb5 = await mat("EMPTY-5");
    await opening(eb50, 1000, 800000); await opening(eb25, 1000, 500000); await opening(eb5, 2000, 400000);

    // ---------------------------------------------------------------- 1. USD purchase -> TZS accounting
    const yara = await supplier("YARA-FZE");
    const sh = await one(db, `insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance,
        currency_code, named_place, ownership_event, planning_rate, bill_of_lading, vessel) values ($1,$2,$3,'CIF',true,true,'USD','Dar es Salaam','bill_of_lading',2500,'BL-778','MV Kilimanjaro') returning id`, [co, hq, yara]);
    const sl = await one(db, "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg, fc_amount, line_no) values ($1,$2,$3,100000,100000,32000,1) returning id", [co, sh, urea]);
    await db.query("select set_import_shipment_status($1,'dispatched',$2,$3)", [sh, d("06-01"), owner]);
    await db.query("select recognise_import_ownership($1,$2,2500,$3,$4)", [sh, d("06-02"), owner, key()]);
    const gi = await one(db, `insert into purchases(company_id, branch_id, supplier_id, document_date, currency_code, exchange_rate, rate_source, rate_reference, import_shipment_id, posting_mode, supplier_invoice_number)
        values ($1,$2,$3,$4,'USD',2520,'manual','BoT',$5,'invoice_only','YARA-INV-1') returning id`, [co, hq, yara, d("06-03"), sh]);
    await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, import_shipment_line_id, is_recoverable) values ($1,$2,100000,0.32,$3,true)", [gi, urea, sl]);
    await db.query("select post_import_goods_invoice($1,$2,$3)", [gi, owner, key()]);
    check("1. USD 32,000 goods: owned at 2,500 (80M), invoiced at 2,520 → AP USD 32,000 / TZS 80.64M; +640k to goods in transit",
      (await one(db, "select fc_outstanding || '/' || outstanding from supplier_payables where purchase_id=$1", [gi])) === "32000.00/80640000.00"
      && (await gl("1157")) === 80640000 && (await gl("2130")) === 0);

    // ---------------------------------------------------------------- 2. approved provisional import costs
    const srcPort = await one(db, "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount, description) values ($1,'import_shipment',$2,$3,6000000,'Port') returning id", [co, sh, await cat("PORT")]);
    const srcClear = await one(db, "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount, description) values ($1,'import_shipment',$2,$3,4000000,'Clearing') returning id", [co, sh, await cat("CLEARING")]);
    await db.query("select accrue_import_cost($1,6000000,$2,$3,$4)", [srcPort, d("06-04"), owner, key()]);
    await db.query("select accrue_import_cost($1,4000000,$2,$3,$4)", [srcClear, d("06-04"), owner, key()]);
    check("2. accruals 6M + 4M approved explicitly (Cr 2140), goods in transit 90.64M", (await gl("2140")) === -10000000 && (await gl("1157")) === 90640000);

    // ---------------------------------------------------------------- 3. partial bulk receipts + actual clearing invoice
    const receipt = async (kgs: number, final: boolean, date: string) => {
      const id = await one(db, "insert into import_receipts(company_id, shipment_id, branch_id, receipt_date) values ($1,$2,$3,$4) returning id", [co, sh, hq, date]);
      await db.query(`insert into import_receipt_lines(company_id, receipt_id, shipment_line_id, quantity_received, net_kg_received, is_final, weighbridge_ref, batch_code, line_no)
        values ($1,$2,$3,$4,$4,$5,'WB-1','LOT-778',1)`, [co, id, sl, kgs, final]);
      await db.query("select post_import_receipt($1,$2,$3)", [id, owner, key()]);
      return id;
    };
    await receipt(60000, false, d("06-05"));
    check("3a. receipt 60,000 kg = 60% of in-transit value (54,384,000)", n((await stock(urea, hq)).v) === 54384000);
    const clr = await supplier("CLEARCO");
    const ciClear = await costInvoice(clr, srcClear, "CLEARING", 4500000, d("06-06"));
    await db.query("select post_cost_invoice($1,$2,$3)", [ciClear, owner, key()]);
    check("3b. actual clearing 4.5M vs 4M accrual: only +500k (300k to stock received, 200k still in transit)",
      (await jl("cost_invoice", ciClear)) === "1150:300000/0 1157:200000/0 2110:0/4500000 2140:4000000/0", await jl("cost_invoice", ciClear));
    await receipt(40000, true, d("06-07"));
    const sU = await stock(urea, hq);
    check("3c. final receipt takes the remainder: 100,000 kg at 911.40/kg (91,140,000); 1157 and GR/IR cleared",
      n(sU.q) === 100000 && n(sU.v) === 91140000 && (await gl("1157")) === 0 && (await gl("2130")) === 0, JSON.stringify(sU));

    // ---------------------------------------------------------------- 4. mixed 50/25/5 kg rebagging with packaging inventory
    const ro = await one(db, "insert into rebag_orders(company_id, branch_id, bulk_product_id, order_date, operator_name) values ($1,$2,$3,$4,'Line A') returning id", [co, hq, urea, d("06-08")]);
    await db.query("insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity, lot_id) values ($1,$2,'bulk',$3,50000,(select lot_id from import_receipt_lines where shipment_line_id=$4 limit 1))", [co, ro, urea, sl]);
    const o50 = await one(db, "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg, line_no) values ($1,$2,$3,500,25000,1) returning id", [co, ro, u50]);
    const o25 = await one(db, "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg, line_no) values ($1,$2,$3,600,15000,2) returning id", [co, ro, u25]);
    const o5 = await one(db, "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg, line_no) values ($1,$2,$3,2000,10000,3) returning id", [co, ro, u5]);
    for (const [m, o, q] of [[eb50, o50, 500], [eb25, o25, 600], [eb5, o5, 2000]] as [string, string, number][]) {
      await db.query("insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity, target_output_id, qty_per_bag) values ($1,$2,'packaging',$3,$4,$5,1)", [co, ro, m, q, o]);
    }
    await db.query("insert into cost_sources(company_id, owner_type, rebag_order_id, cost_category_id, estimated_amount, description, allocation_basis) values ($1,'rebag_order',$2,$3,310000,'Filling crew','quantity')", [co, ro, await cat("REBAG_LAB")]);
    await db.query("select complete_rebag_order($1,$2,$3)", [ro, sender, key()]);
    const s50 = await stock(u50, hq), s25 = await stock(u25, hq), s5 = await stock(u5, hq);
    check("4. 50,000 kg → 500 × 50 kg + 600 × 25 kg + 2,000 × 5 kg (3,100 bags, 50,000 kg); per bag 46,470 / 23,385 / 4,857 (bulk 911.40/kg + own bags + 100 labour)",
      n(s50.q) === 500 && n(s25.q) === 600 && n(s5.q) === 2000 && n(s50.a) === 46470 && n(s25.a) === 23385 && n(s5.a) === 4857
      && n((await stock(urea, hq)).v) === 45570000 && n((await stock(eb5, hq)).q) === 0, `${JSON.stringify([s50, s25, s5])}`);

    // ---------------------------------------------------------------- 5. dispatch with driver / agent documents and delivery note
    const tr = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id, source_location, destination_location) values ($1,$2,$3,'Main store','Bay 2') returning id", [co, hq, mwz]);
    const tl = await one(db, "insert into stock_transfer_lines(transfer_id, product_id, qty_requested, batch_reference) values ($1,$2,400,'LOT-778') returning id", [tr, u50]);
    await db.query("insert into stock_transfer_agents(company_id, transfer_id, name, company_name, phone, role) values ($1,$2,'Asha K','Clear Ltd','+255 711 000 001','Escort')", [co, tr]);
    const trip = await one(db, `insert into stock_transfer_dispatches(company_id, transfer_id, trip_no, dispatch_date, expected_arrival_at, driver_name, driver_phone, driver_licence, vehicle_registration, trailer_registration, transporter_name, transporter_contact)
        values ($1,$2,1,$3,$4,'Juma Ali','+255 700 111 222','DL-5566','T 123 ABC','T 456 DEF','Fast Haulage','+255 700 333 444') returning id`, [co, tr, d("06-10"), `${d("06-12")}T10:00:00+03:00`]);
    await db.query("insert into stock_transfer_dispatch_lines(company_id, dispatch_id, transfer_line_id, qty) values ($1,$2,$3,400)", [co, trip, tl]);
    const kd = key();
    await db.query("select dispatch_transfer_trip($1,$2,$3)", [trip, sender, kd]);
    check("5a. duplicate dispatch request posts once", (await failMsg(db, "select dispatch_transfer_trip($1,$2,$3)", [trip, sender, kd])) === null
      && Number(await one(db, "select count(*) from stock_movements where source_id=$1 and movement_type='transfer_out'", [tr])) === 1);
    const sha = "b".repeat(64);
    const doc = (u: string, cat2: string) => failMsg(db, "select register_attachment($1,'stock_transfer_dispatch',$2,$3,$4,'f.pdf','f.pdf','application/pdf',1000,$5,null)",
      [u, trip, cat2, `${co}/stock_transfer_dispatch/${trip}/${Math.random().toString(36).slice(2)}`, sha]);
    check("5b. documents: owner stores the licence, sender the loading photo / weighbridge; storekeeper refused the licence",
      (await doc(owner, "driver_licence")) === null && (await doc(sender, "loading_photo")) === null && (await doc(sender, "weighbridge_ticket")) === null
      && (await doc(sender, "driver_licence")) !== null);
    const dn = (await db.query<{ version_id: string; version_no: number }>("select * from issue_delivery_note($1,$2)", [trip, sender])).rows[0];
    const snap = (await db.query<{ snapshot: DeliveryNoteSnapshot; content_sha256: string; created_at: string }>("select snapshot, content_sha256, created_at::text from document_versions where id=$1", [dn.version_id])).rows[0];
    const pdf = renderDeliveryNote(snap.snapshot, { version: dn.version_no, sha256: snap.content_sha256, issuedAt: snap.created_at });
    if (process.env.LETIQ_SCENARIO_PDF) writeFileSync(process.env.LETIQ_SCENARIO_PDF, pdf);
    const pdfText = Buffer.from(pdf).toString("latin1");
    check("5c. delivery note v1: reference, 400 bags / 20,000 kg, driver, agent, signature spaces; no licence number or cost",
      dn.version_no === 1 && pdfText.includes(snap.snapshot.reference) && pdfText.includes("20,000") && pdfText.includes("Juma Ali") && pdfText.includes("Asha K")
      && !pdfText.includes("DL-5566") && !pdfText.includes("46470") && !JSON.stringify(snap.snapshot).includes("DL-5566"));
    const srcTransport = await one(db, "insert into cost_sources(company_id, owner_type, stock_transfer_id, cost_category_id, estimated_amount, description) values ($1,'stock_transfer',$2,$3,800000,'Transport') returning id", [co, tr, await cat("TRANSPORT")]);
    await db.query("select accrue_transfer_cost($1,800000,$2,$3,$4)", [srcTransport, d("06-10"), accountant, key()]);
    check("5d. 400 bags in transit: 18,588,000 + 800,000 accrued transport = 19,388,000 in 1155", (await gl("1155")) === 19388000);

    // ---------------------------------------------------------------- 6. sender / receiver in-transit view
    const seen = async (uid: string) => {
      await db.query("savepoint rls");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await db.query("set local role authenticated");
      const r = [Number(await one(db, "select count(*) from stock_transfers where id=$1", [tr])), Number(await one(db, "select count(*) from stock_transfer_dispatches where id=$1", [trip])),
        Number(await one(db, "select count(*) from stock_transfer_dispatch_lines where dispatch_id=$1", [trip])), Number(await one(db, "select count(*) from stock_transfer_agents where transfer_id=$1", [tr]))];
      await db.query("rollback to savepoint rls");
      return r.join(",");
    };
    check("6. sender and receiver see the same cargo; an unrelated branch sees nothing",
      (await seen(sender)) === "1,1,1,1" && (await seen(receiver)) === "1,1,1,1" && (await seen(outsider)) === "0,0,0,0");

    // ---------------------------------------------------------------- 7. partial receipt and offloading cost
    const dlId = await one(db, "select id from stock_transfer_dispatch_lines where dispatch_id=$1", [trip]);
    const req = key();
    const rcp = await one(db, "select receive_transfer_trip($1,$2,$3::jsonb,$4,'arrived','M. Receiver',$5,$6)",
      [trip, receiver, JSON.stringify([{ dispatch_line_id: dlId, accepted: 380, quarantined: 10, short: 10 }]), `${d("06-12")}T09:00:00+03:00`, req, req]);
    const rcp2 = await one(db, "select receive_transfer_trip($1,$2,$3::jsonb,$4,'arrived','M. Receiver',$5,$6)",
      [trip, receiver, JSON.stringify([{ dispatch_line_id: dlId, accepted: 380, quarantined: 10, short: 10 }]), `${d("06-12")}T09:00:00+03:00`, req, req]);
    check("7a. receipt 380 accepted at 48,470 (18,418,600); 10 quarantined + 10 short held in transit; duplicate request returns the same receipt",
      n((await stock(u50, mwz)).v) === 18418600 && (await gl("1155")) === 969400 && rcp === rcp2);
    const off = await one(db, "insert into cost_sources(company_id, owner_type, stock_transfer_id, transfer_dispatch_id, cost_category_id, estimated_amount, description) values ($1,'stock_transfer',$2,$3,$4,200000,'Offloading') returning id", [co, tr, trip, await cat("LOADING")]);
    const porters = await supplier("MWZ-PORTERS");
    const ciOff = await costInvoice(porters, off, "LOADING", 200000, d("06-12"), "invoice", null, mwz);
    await db.query("select post_cost_invoice($1,$2,$3)", [ciOff, owner, key()]);
    check("7b. receiver's offloading 200,000: 190,000 to the 380 bags received, 10,000 to the 20 still held",
      (await jl("cost_invoice", ciOff)) === "1150:190000/0 1155:10000/0 2110:0/200000" && n((await stock(u50, mwz)).v) === 18608600, await jl("cost_invoice", ciOff));

    // ---------------------------------------------------------------- 8. approved shortage / damage handling
    const rl = await one(db, "select id from stock_transfer_receipt_lines where receipt_id=$1", [rcp]);
    check("8a. a storekeeper cannot approve losses", (await failMsg(db, "select resolve_transfer_discrepancy($1,'quarantine','write_off',10,null,$2,$3)", [rl, receiver, key()])) !== null);
    await db.query("select resolve_transfer_discrepancy($1,'quarantine','write_off',10,'torn bags',$2,$3)", [rl, owner, key()]);
    await db.query("select resolve_transfer_discrepancy($1,'short','claim',10,'carrier',$2,$3)", [rl, owner, key()]);
    check("8b. 10 damaged written off (489,700 to 6300), 10 short claimed (489,700 to 1145); 1155 cleared",
      (await gl("6300")) === 489700 && (await gl("1145")) === 489700 && (await gl("1155")) === 0);

    // ---------------------------------------------------------------- 9. branch sale
    const sale = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total) values ($1,$2,$3,$4,$5,12000000) returning id", [co, mwz, d("06-15"), walkin, owner]);
    await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, net_amount, tax_amount, line_total, track_inventory, line_no) values ($1,$2,200,60000,12000000,0,12000000,true,1)", [sale, u50]);
    await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,12000000)", [sale, cash]);
    await db.query("select post_sale($1,$2,null)", [sale, owner]);
    check("9. Mwanza sells 200 bags at 60,000: cost of sales 9,794,000 at the 48,970 average", n(await one(db, "select cogs_total from sales where id=$1", [sale])) === 9794000);

    // ---------------------------------------------------------------- 10. late transport invoice
    const haul = await supplier("FAST-HAULAGE");
    const ciTr = await costInvoice(haul, srcTransport, "TRANSPORT", 900000, d("06-20"));
    await db.query("select post_cost_invoice($1,$2,$3)", [ciTr, owner, key()]);
    check("10. late transport 900k vs 800k accrual: +100k → 45k to the 180 bags held, 50k to the 200 sold, 5k to the 20 lost",
      (await jl("cost_invoice", ciTr)) === "1150:45000/0 2110:0/900000 2140:800000/0 5100:50000/0 6300:5000/0", await jl("cost_invoice", ciTr));

    // ---------------------------------------------------------------- 11. supplier partial settlement and FX difference
    const pay = await one(db, "insert into supplier_payments(company_id, branch_id, supplier_id, document_date, currency_code) values ($1,$2,$3,$4,'USD') returning id", [co, hq, yara, d("06-25")]);
    await db.query("insert into supplier_payment_funding(payment_id, payment_account_id, amount) values ($1,$2,40800000)", [pay, nmb]);
    await db.query("insert into supplier_payment_allocations(payment_id, payable_id, amount, fc_amount) values ($1,(select id from supplier_payables where purchase_id=$2),0,16000)", [pay, gi]);
    await db.query("select post_supplier_payment($1,$2,$3)", [pay, owner, key()]);
    check("11. pays USD 16,000 with TZS 40.8M (2,550): releases 40.32M carrying, FX loss 480,000; USD 16,000 / TZS 40.32M still owed",
      (await gl("6400")) === 480000 && (await one(db, "select fc_outstanding || '/' || outstanding from supplier_payables where purchase_id=$1", [gi])) === "16000.00/40320000.00");

    // ---------------------------------------------------------------- 12. period close, then a permitted subsequent adjustment
    await db.query("update accounting_periods set end_date=$2 where company_id=$1 and start_date <= $3 and end_date >= $3", [co, d("05-31"), d("06-15")]);
    await db.query("insert into accounting_periods(company_id, financial_year, name, start_date, end_date, status) values ($1,$2,'June',$3,$4,'closed'), ($1,$2,'July-December',$5,$6,'open')",
      [co, String(Y), d("06-01"), d("06-30"), d("07-01"), d("12-31")]);
    check("12a. nothing can be posted into closed June", (await failMsg(db, "select post_cost_invoice($1,$2,$3)", [await costInvoice(haul, srcTransport, "TRANSPORT", 50000, d("06-28"), "credit_note", ciTr), owner, key()])) !== null);
    const cn = await costInvoice(haul, srcTransport, "TRANSPORT", 50000, d("07-05"), "credit_note", ciTr);
    await db.query("select post_cost_invoice($1,$2,$3)", [cn, owner, key()]);
    check("12b. July credit note 50k follows the goods: -22,500 held, -25,000 cost of sales (June sale), -2,500 loss",
      (await jl("cost_invoice", cn)) === "1150:0/22500 2110:50000/0 5100:0/25000 6300:0/2500", await jl("cost_invoice", cn));
    const catchUp = (await db.query<{ catch_up: boolean; ref_number: string; amount: string }>("select catch_up, ref_number, amount::text from late_cost_report($1,$2,$3) where src_id=$4 and target='cogs'", [co, d("07-01"), d("07-31"), cn])).rows;
    check("12c. the June sale's share is a reported catch-up in July (closed period not reopened)",
      catchUp.length === 1 && catchUp[0].catch_up && n(catchUp[0].amount) === -25000
      && Number(await one(db, "select count(*) from journal_entries where company_id=$1 and entry_date between $2 and $3 and created_at > now() - interval '1 second' and source_type='cost_invoice' and source_id=$4", [co, d("06-01"), d("06-30"), cn])) === 0);

    // ---------------------------------------------------------------- reconciliation
    check("R1. Mwanza 180 bags at 8,837,100 (18,608,600 - 9,794,000 + 45,000 - 22,500)", n((await stock(u50, mwz)).q) === 180 && n((await stock(u50, mwz)).v) === 8837100);
    check("R2. inventory: GL 1150 = stock subledger", (await gl("1150")) === n(await one(db, "select sum(stock_value) from stock_balances where company_id=$1", [co])));
    check("R3. in transit 1155 = 0, import transit 1157 = 0, GR/IR 2130 = 0", (await gl("1155")) === 0 && (await gl("1157")) === 0 && (await gl("2130")) === 0);
    check("R4. accruals 2140 = 6,310,000 explained (port 6M awaiting invoice, rebagging labour 310k)", (await gl("2140")) === -6310000);
    check("R5. AP 2110 = USD balance 40.32M + clearing 4.5M + offloading 200k + transport 900k - credit 50k = 45,870,000", (await gl("2110")) === -45870000, String(await gl("2110")));
    check("R6. FX loss 480,000; losses 6300 = 489,700 + 5,000 - 2,500; claims 1145 = 489,700", (await gl("6400")) === 480000 && (await gl("6300")) === 492200 && (await gl("1145")) === 489700);
    check("R7. cost of sales = 9,794,000 + 50,000 - 25,000", (await gl("5100")) === 9819000);
    const recon = (await db.query<{ check_key: string; ok: boolean; detail: string }>("select * from cost_reconciliation_checks($1)", [co])).rows;
    check("R8. all 13 reconciliation checks pass", recon.length === 13 && recon.every((r) => r.ok), JSON.stringify(recon.filter((r) => !r.ok)));
    check("R9. trial balance balances", n(await one(db, "select coalesce(sum(l.debit - l.credit),0) from journal_lines l join journal_entries j on j.id=l.journal_id where j.company_id=$1", [co])) === 0);

    console.log(`\n${passed} end-to-end scenario checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nScenario test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main();
