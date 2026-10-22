/**
 * Import upgrade - Stage 6 (transfer costs, dispatch trips, shared dispatch file).
 * One transaction, ROLLED BACK. PGlite test database only (npm run test:db).
 */
import { createDbClient } from "./db";
import type { Client } from "pg";
import { renderDeliveryNote, type DeliveryNoteSnapshot } from "../src/lib/transfers/delivery-note";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-import6 runs only against the PGlite test database (npm run test:db).");
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
const key = () => `stage6-key-${++k}-${Math.random().toString(36).slice(2)}`;
const n = (x: unknown) => Number(x);

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const Y = new Date().getFullYear();
    const d = (md: string) => `${Y}-${md}`;
    const co = await one(db, "select id from companies where code='LETIQ'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const mwz = await one(db, "insert into branches(company_id, code, name, address) values ($1,'MWZ6','Mwanza','Nyakato Rd, Mwanza') returning id", [co]);
    const aru = await one(db, "insert into branches(company_id, code, name) values ($1,'ARU6','Arusha') returning id", [co]);
    const kg = await one(db, "select id from units where company_id=$1 and code='KG'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    await db.query("update feature_flags set is_enabled=true where company_id=$1 and flag_key in ('transfer_logistics','attachments')", [co]);

    const acc = (code: string) => one(db, "select id from chart_of_accounts where company_id=$1 and code=$2", [co, code]);
    const a1150 = await acc("1150"), a3200 = await acc("3200");
    const opening = async (prod: string, qty: number, value: number, br: string) => {
      await db.query("select record_stock_movement_value($1,$2,$3,'opening','opening',gen_random_uuid(),'OPEN',$4,$5,$6)", [co, br, prod, qty, value, owner]);
      await db.query("select create_journal($1,$2,$3,'opening',gen_random_uuid(),'OPEN','opening',$4,$5::jsonb)", [co, br, d("01-01"), owner,
        JSON.stringify([{ account_id: a1150, debit: value, credit: 0 }, { account_id: a3200, debit: 0, credit: value }])]);
    };
    const gl = async (code: string) => n(await one(db, `select coalesce(sum(l.debit-l.credit),0) from journal_lines l join journal_entries j on j.id=l.journal_id
       where j.company_id=$1 and l.account_id=(select id from chart_of_accounts where company_id=$1 and code=$2)`, [co, code]));
    const jl = async (st: string, sid: string) => (await db.query<{ code: string; d: string; c: string }>(
      `select c.code, sum(l.debit)::text d, sum(l.credit)::text c from journal_entries j join journal_lines l on l.journal_id=j.id
       join chart_of_accounts c on c.id=l.account_id where j.source_type=$1 and j.source_id=$2 group by c.code order by c.code`, [st, sid]))
      .rows.map((r) => `${r.code}:${n(r.d)}/${n(r.c)}`).join(" ");
    const stock = async (prod: string, br: string) => (await db.query<{ q: string; v: string; a: string }>(
      "select quantity::text q, stock_value::text v, avg_unit_cost::text a from stock_balances where product_id=$1 and branch_id=$2", [prod, br])).rows[0] ?? { q: "0", v: "0", a: "0" };
    const user = async (email: string, role: string, branches: string[]) => {
      const id = await one(db, "insert into auth.users(email) values ($1) returning id", [email]);
      await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active)
                      values ($1,$2,$2,(select id from roles where code=$3),$4,true)`, [id, email, role, co]);
      await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [id, co]);
      for (const b of branches) await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [id, b]);
      return id;
    };
    const sender = await user("send6@test.local", "STOREKEEPER", [hq]);
    const receiver = await user("recv6@test.local", "STOREKEEPER", [mwz]);
    const outsider = await user("aru6@test.local", "STOREKEEPER", [aru]);
    const accountant = await user("acc6@test.local", "ACCOUNTANT", [hq, mwz, aru]);
    const transfer = (from: string, to: string) => one(db,
      "insert into stock_transfers(company_id, source_branch_id, destination_branch_id, source_location, destination_location) values ($1,$2,$3,'Main store','Bay 2') returning id", [co, from, to]);
    const tline = (t: string, prod: string, qty: number, batch: string | null = null) => one(db,
      "insert into stock_transfer_lines(transfer_id, product_id, qty_requested, batch_reference) values ($1,$2,$3,$4) returning id", [t, prod, qty, batch]);
    const trip = async (t: string, no: number, lines: [string, number][], driver = "Juma Ali", lic = "DL-778899") => {
      const id = await one(db, `insert into stock_transfer_dispatches(company_id, transfer_id, trip_no, dispatch_date, expected_arrival_at, driver_name, driver_phone, driver_licence,
          vehicle_registration, trailer_registration, transporter_name, transporter_contact)
        values ($1,$2,$3,$4,$5,$6,'+255 700 111 222',$7,'T 123 ABC','T 456 DEF','Fast Haulage','+255 700 333 444') returning id`,
        [co, t, no, d("03-01"), `${d("03-03")}T10:00:00+03:00`, driver, lic]);
      for (const [l, q] of lines) await db.query("insert into stock_transfer_dispatch_lines(company_id, dispatch_id, transfer_line_id, qty) values ($1,$2,$3,$4)", [co, id, l, q]);
      return id;
    };
    const dl = (tripId: string, line: string) => one(db, "select id from stock_transfer_dispatch_lines where dispatch_id=$1 and transfer_line_id=$2", [tripId, line]);
    const receive = (tripId: string, u: string, lines: object[], req = key(), kk = req) =>
      one(db, "select receive_transfer_trip($1,$2,$3::jsonb,$4,'arrived','M. Receiver',$5,$6)", [tripId, u, JSON.stringify(lines), `${d("03-03")}T09:00:00+03:00`, req, kk]);
    const charge = (t: string, catCode: string, est: number, desc: string, tripId: string | null = null, basis: string | null = null) => one(db,
      `insert into cost_sources(company_id, owner_type, stock_transfer_id, transfer_dispatch_id, cost_category_id, estimated_amount, description, allocation_basis)
       values ($1,'stock_transfer',$2,$3,(select id from cost_categories where company_id=$1 and code=$4),$5,$6,$7) returning id`, [co, t, tripId, catCode, est, desc, basis]);
    const transitTotal = async () => n(await one(db, `select coalesce(sum(x.transit_value),0) from stock_transfer_dispatch_lines x
      join stock_transfer_dispatches dd on dd.id=x.dispatch_id where dd.company_id=$1 and dd.status not in ('draft','voided')`, [co]));

    // ------------------------------------------------------------ products and opening stock
    const npk = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'NPK6','NPK bulk',$2,'bulk') returning id", [co, kg]);
    const n50 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,'NPK6-50','NPK 50 kg',$2,'packaged',50,$3) returning id", [co, bag, npk]);
    const n25 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id, transfer_loss_tolerance_pct) values ($1,'NPK6-25','NPK 25 kg',$2,'packaged',25,$3,2) returning id", [co, bag, npk]);
    await opening(n50, 1000, 46500000, hq);
    await opening(n50, 500, 25000000, mwz);
    await opening(n25, 400, 8000000, hq);

    // ------------------------------------------------------------ ACCEPTANCE: 1,000 bags at 46,500 + 2.0M charges
    const t1 = await transfer(hq, mwz);
    const l1 = await tline(t1, n50, 1000, "LOT-A");
    await db.query("insert into stock_transfer_agents(company_id, transfer_id, name, company_name, phone, role) values ($1,$2,'Asha K','Clear Ltd','+255 711 000 000','Clearing agent'),($1,$2,'Peter M',null,'+255 722 000 000','Escort')", [co, t1]);
    const trip1 = await trip(t1, 1, [[l1, 1000]]);
    check("cross-company: a transfer to another company's branch is rejected", await (async () => {
      const co2 = await one(db, "insert into companies(code, name) values ('OTHER6','Other Co') returning id");
      const b2 = await one(db, "insert into branches(company_id, code, name) values ($1,'OB6','Other branch') returning id", [co2]);
      return fails(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3)", [co, hq, b2]);
    })());
    check("receiving branch cannot dispatch the sender's cargo", await fails(db, "select dispatch_transfer_trip($1,$2,$3)", [trip1, receiver, key()], "branch"));
    const kd = key();
    await db.query("select dispatch_transfer_trip($1,$2,$3)", [trip1, sender, kd]);
    await db.query("select dispatch_transfer_trip($1,$2,$3)", [trip1, sender, kd]);
    check("dispatch moves source stock to 1155 at carrying cost (Dr 1155 / Cr 1150 46.5M), once",
      (await jl("stock_transfer_dispatch", trip1)) === "1150:0/46500000 1155:46500000/0" && n((await stock(n50, hq)).q) === 0
      && Number(await one(db, "select count(*) from stock_movements where source_id=$1 and movement_type='transfer_out'", [t1])) === 1);
    check("same-company transfer posts no revenue", Number(await one(db, `select count(*) from journal_lines l join journal_entries j on j.id=l.journal_id
      join chart_of_accounts c on c.id=l.account_id where j.source_id=$1 and c.account_type='revenue'`, [trip1])) === 0);
    check("dispatched cargo quantities are locked", await fails(db, "select dispatch_transfer_trip($1,$2,$3)", [trip1, sender, key()], "already dispatched"));
    check("over-dispatch beyond the request is rejected", await (async () => {
      const x = await trip(t1, 2, [[l1, 1]]);
      const r = await fails(db, "select dispatch_transfer_trip($1,$2,$3)", [x, sender, key()], "exceed");
      await db.query("delete from stock_transfer_dispatches where id=$1", [x]); return r;
    })());

    const cLoad = await charge(t1, "LOADING", 200000, "Loading", trip1);
    const cTrans = await charge(t1, "TRANSPORT", 1500000, "Transport");
    const cOff = await charge(t1, "LOADING", 300000, "Offloading (receiver)");
    check("storekeeper cannot accrue transfer charges", await fails(db, "select accrue_transfer_cost($1,200000,$2,$3,$4)", [cLoad, d("03-01"), sender, key()], "transfer_cost"));
    check("an outsider cannot accrue charges on someone else's transfer", await fails(db, "select accrue_transfer_cost($1,200000,$2,$3,$4)", [cLoad, d("03-01"), outsider, key()]));
    await db.query("select accrue_transfer_cost($1,200000,$2,$3,$4)", [cLoad, d("03-01"), accountant, key()]);
    await db.query("select accrue_transfer_cost($1,1500000,$2,$3,$4)", [cTrans, d("03-01"), accountant, key()]);
    const offSup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'OFF6','Mwanza Porters') returning id", [co]);
    const ciOff = await one(db, "insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number) values ($1,$2,$3,$4,'POR-1') returning id", [co, mwz, offSup, d("03-03")]);
    await db.query("insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount) values ($1,$2,(select id from cost_categories where company_id=$1 and code='LOADING'),$3,300000)", [co, ciOff, cOff]);
    await db.query("select post_cost_invoice($1,$2,$3)", [ciOff, owner, key()]);
    check("receiver's offloading invoice and accrued loading / transport sit in 1155 with the cargo (48.5M)",
      (await gl("1155")) === 48500000 && (await transitTotal()) === 48500000 && (await jl("cost_invoice", ciOff)) === "1155:300000/0 2110:0/300000");
    check("the sender cannot receive", await fails(db, "select receive_transfer_trip($1,$2,$3::jsonb,null,null,null,'x',$4)", [trip1, sender, JSON.stringify([{ dispatch_line_id: await dl(trip1, l1), accepted: 1 }]), key()], "branch"));
    const req1 = key();
    const r1 = await receive(trip1, receiver, [{ dispatch_line_id: await dl(trip1, l1), accepted: 1000 }], req1);
    const r1b = await receive(trip1, receiver, [{ dispatch_line_id: await dl(trip1, l1), accepted: 1000 }], req1);
    check("ACCEPTANCE: destination receipt value 48,500,000 (48,500 per bag)",
      (await jl("stock_transfer_receipt", r1)) === "1150:48500000/0 1155:0/48500000" && n(await one(db, "select value from stock_transfer_receipt_lines where receipt_id=$1", [r1])) === 48500000);
    const m1 = await stock(n50, mwz);
    check("ACCEPTANCE: with 500 bags worth 25M already there, the new average is 73.5M / 1,500 = 49,000",
      n(m1.q) === 1500 && n(m1.v) === 73500000 && n(m1.a) === 49000, JSON.stringify(m1));
    check("duplicate receipt request returns the same receipt; no double stock", r1 === r1b
      && Number(await one(db, "select count(*) from stock_transfer_receipts where transfer_id=$1", [t1])) === 1 && n(m1.q) === 1500);
    check("1155 back to zero; transfer received and the cargo no longer outstanding",
      (await gl("1155")) === 0 && (await one(db, "select status from stock_transfers where id=$1", [t1])) === "received");
    const ciTr = await one(db, "insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number) values ($1,$2,$3,$4,'FH-9') returning id",
      [co, hq, await one(db, "insert into suppliers(company_id, code, name) values ($1,'FH6','Fast Haulage') returning id", [co]), d("03-10")]);
    await db.query("insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount) values ($1,$2,(select id from cost_categories where company_id=$1 and code='TRANSPORT'),$3,1600000)", [co, ciTr, cTrans]);
    await db.query("select post_cost_invoice($1,$2,$3)", [ciTr, owner, key()]);
    check("later transport invoice 1.6M vs 1.5M accrual: only +100k, into the bags now held at Mwanza",
      (await jl("cost_invoice", ciTr)) === "1150:100000/0 2110:0/1600000 2140:1500000/0" && n((await stock(n50, mwz)).v) === 73600000, await jl("cost_invoice", ciTr));
    check("transfer costing stays provisional until every charge is invoiced (logistics already received)",
      (await one(db, "select status || '/' || cost_status from stock_transfers where id=$1", [t1])) === "received/provisional");

    // ------------------------------------------------------------ partial trips, quarantine, shortage and resolutions
    const t2 = await transfer(hq, mwz);
    const l2 = await tline(t2, n25, 300);
    const tA = await trip(t2, 1, [[l2, 200]]);
    await db.query("select dispatch_transfer_trip($1,$2,$3)", [tA, sender, key()]);
    const tB = await trip(t2, 2, [[l2, 100]], "Neema S", "DL-112233");
    await db.query("select dispatch_transfer_trip($1,$2,$3)", [tB, sender, key()]);
    check("two trips under one transfer with their own drivers",
      (await one(db, "select string_agg(driver_name || ':' || document_number, ',' order by trip_no) from stock_transfer_dispatches where transfer_id=$1", [t2])) ===
      `Juma Ali:${await one(db, "select document_number from stock_transfers where id=$1", [t2])}-T1,Neema S:${await one(db, "select document_number from stock_transfers where id=$1", [t2])}-T2`);
    const rA = await receive(tA, receiver, [{ dispatch_line_id: await dl(tA, l2), accepted: 180, quarantined: 10, short: 10 }]);
    check("partial receipt: 180 accepted at exactly 20,000 each (shortage not spread over accepted goods)",
      n(await one(db, "select value from stock_transfer_receipt_lines where receipt_id=$1", [rA])) === 3600000 && n((await stock(n25, mwz)).q) === 180);
    check("quarantined and short cargo stay in transit (1155 = 20 bags of trip 1 + 100 bags of trip 2), not saleable",
      (await gl("1155")) === 2400000 && (await one(db, "select status || '/' || has_open_discrepancy from stock_transfers where id=$1", [t2])) === "partially_received/true");
    const rlA = await one(db, "select id from stock_transfer_receipt_lines where receipt_id=$1", [rA]);
    check("a storekeeper cannot resolve discrepancies", await fails(db, "select resolve_transfer_discrepancy($1,'quarantine','release',6,null,$2,$3)", [rlA, receiver, key()], "transfer_resolve"));
    await db.query("select resolve_transfer_discrepancy($1,'quarantine','release',6,'repacked',$2,$3)", [rlA, owner, key()]);
    await db.query("select resolve_transfer_discrepancy($1,'quarantine','write_off',4,'torn',$2,$3)", [rlA, owner, key()]);
    check("normal loss limited to the 2% tolerance (4 of 200)", await fails(db, "select resolve_transfer_discrepancy($1,'short','normal_loss',10,null,$2,$3)", [rlA, owner, key()], "tolerance"));
    await db.query("select resolve_transfer_discrepancy($1,'short','normal_loss',4,null,$2,$3)", [rlA, owner, key()]);
    await db.query("select resolve_transfer_discrepancy($1,'short','claim',6,'carrier',$2,$3)", [rlA, owner, key()]);
    check("cannot resolve more than is open", await fails(db, "select resolve_transfer_discrepancy($1,'short','claim',1,null,$2,$3)", [rlA, owner, key()], "open"));
    const reqB = key();
    await receive(tB, receiver, [{ dispatch_line_id: await dl(tB, l2), accepted: 100 }], reqB);
    await receive(tB, receiver, [{ dispatch_line_id: await dl(tB, l2), accepted: 100 }], reqB);
    const m2 = await stock(n25, mwz);
    check("dispositions reconcile: 180 + 6 released + 100 = 286 bags; normal loss 80k absorbed (5.8M); write-off 80k (6300); claim 120k (1145)",
      n(m2.q) === 286 && n(m2.v) === 5800000 && (await gl("6300")) === 80000 && (await gl("1145")) === 120000, JSON.stringify(m2));
    check("every bag accounted for: dispatched 300 = accepted 286 + lost 14",
      (await one(db, "select qty_dispatched || '/' || qty_received || '/' || (qty_lost_normal + qty_lost_abnormal) || '/' || qty_quarantined || '/' || qty_short_pending from stock_transfer_lines where id=$1", [l2]))
        === "300.0000/286.0000/14.0000/0.0000/0.0000");
    check("transfer received with no open discrepancy; 1155 zero",
      (await one(db, "select status || '/' || has_open_discrepancy from stock_transfers where id=$1", [t2])) === "received/false" && (await gl("1155")) === 0);
    check("trip receipt cannot exceed what is still to arrive", await fails(db, "select receive_transfer_trip($1,$2,$3::jsonb,null,null,null,$4,$5)",
      [tB, receiver, JSON.stringify([{ dispatch_line_id: await dl(tB, l2), accepted: 1 }]), key(), key()], "nothing to receive"));

    // ------------------------------------------------------------ void a trip, driver change, legacy wrappers
    const t3 = await transfer(hq, mwz);
    const l3 = await tline(t3, n25, 50);
    const tC = await trip(t3, 1, [[l3, 50]]);
    await db.query("select dispatch_transfer_trip($1,$2,$3)", [tC, sender, key()]);
    check("storekeeper cannot void a trip", await fails(db, "select void_transfer_trip($1,$2,'x',$3)", [tC, sender, key()], "transactions.void"));
    check("driver change needs a reason", await fails(db, "select change_transfer_trip_transport($1,$2,$3::jsonb,'')", [tC, sender, JSON.stringify({ driver_name: "X" })], "reason"));
    await db.query("select change_transfer_trip_transport($1,$2,$3::jsonb,'driver fell ill')", [tC, sender, JSON.stringify({ driver_name: "Baraka T", vehicle_registration: "T 999 XYZ" })]);
    check("driver / vehicle change keeps the previous details and the reason",
      (await one(db, "select (old_values->>'driver_name') || '>' || (new_values->>'driver_name') || '|' || reason from stock_transfer_dispatch_changes where dispatch_id=$1", [tC]))
        === "Juma Ali>Baraka T|driver fell ill");
    const hqBefore = n((await stock(n25, hq)).v);
    await db.query("select void_transfer_trip($1,$2,'wrong branch',$3)", [tC, owner, key()]);
    check("voiding an unreceived trip returns the exact value to the source; 1155 zero",
      n((await stock(n25, hq)).v) === hqBefore + 1000000 && (await gl("1155")) === 0 && (await one(db, "select status from stock_transfers where id=$1", [t3])) === "draft");
    check("a received trip cannot be voided", await fails(db, "select void_transfer_trip($1,$2,'x',$3)", [tA, owner, key()], "already received"));

    const t4 = await transfer(hq, aru);
    const l4 = await tline(t4, n25, 10);
    const k4 = key();
    await db.query("select dispatch_stock_transfer($1,$2,$3)", [t4, owner, k4]);
    await db.query("select dispatch_stock_transfer($1,$2,$3)", [t4, owner, k4]);
    check("existing dispatch action creates one trip (retry-safe) and posts to 1155",
      Number(await one(db, "select count(*) from stock_transfer_dispatches where transfer_id=$1", [t4])) === 1 && (await gl("1155")) === 200000);
    const k4r = key();
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [t4, owner, JSON.stringify([{ line_id: l4, qty: 4 }]), k4r]);
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [t4, owner, JSON.stringify([{ line_id: l4, qty: 4 }]), k4r]);
    check("existing receive action: partial receipt, retry posts once (Stage 1 D4)",
      n((await stock(n25, aru)).q) === 4 && (await gl("1155")) === 120000);
    check("existing receive action checks the receiving branch (Stage 1 D3)",
      await fails(db, "select receive_stock_transfer($1,$2,$3::jsonb,$4)", [t4, receiver, JSON.stringify([{ line_id: l4, qty: 1 }]), key()], "branch"));

    // ------------------------------------------------------------ delivery notes
    const dn1 = (await db.query<{ version_id: string; version_no: number; is_new: boolean }>("select * from issue_delivery_note($1,$2)", [trip1, receiver])).rows[0];
    const dn1b = (await db.query<{ version_id: string; version_no: number; is_new: boolean }>("select * from issue_delivery_note($1,$2)", [trip1, sender])).rows[0];
    check("delivery note v1 issued; unchanged content reuses it (both branches)", dn1.version_no === 1 && dn1.is_new && dn1b.version_id === dn1.version_id && !dn1b.is_new);
    check("an unrelated branch cannot issue the delivery note", await fails(db, "select * from issue_delivery_note($1,$2)", [trip1, outsider], "sending or receiving"));
    check("issuing a delivery note posts nothing",
      Number(await one(db, "select count(*) from journal_entries where source_id=$1", [dn1.version_id])) === 0
      && Number(await one(db, "select count(*) from stock_movements where source_id=$1", [trip1])) === 0);
    const snapRow = (await db.query<{ snapshot: DeliveryNoteSnapshot; content_sha256: string; created_at: string }>("select snapshot, content_sha256, created_at::text from document_versions where id=$1", [dn1.version_id])).rows[0];
    const snapText = JSON.stringify(snapRow.snapshot);
    check("delivery note content: references, both branches, driver, vehicle, agents, quantities and net kg",
      snapRow.snapshot.reference.endsWith("-T1") && snapRow.snapshot.sender.code === "HQ" && snapRow.snapshot.receiver.code === "MWZ6"
      && snapRow.snapshot.driver.name === "Juma Ali" && snapRow.snapshot.vehicle.registration === "T 123 ABC" && snapRow.snapshot.agents.length === 2
      && snapRow.snapshot.lines[0].qty === 1000 && Number(snapRow.snapshot.lines[0].net_kg) === 50000 && snapRow.snapshot.lines[0].batch === "LOT-A", snapText);
    check("delivery note shows no licence number and no costs", !snapText.includes("DL-778899") && !snapText.includes("46500") && !snapText.includes("48500"));
    const pdf = Buffer.from(renderDeliveryNote(snapRow.snapshot, { version: 1, sha256: snapRow.content_sha256, issuedAt: snapRow.created_at })).toString("latin1");
    check("PDF is a valid PDF with the reference, company, quantities and signature spaces",
      pdf.startsWith("%PDF-1.4") && pdf.trimEnd().endsWith("%%EOF") && pdf.includes(snapRow.snapshot.reference) && pdf.includes("DELIVERY NOTE")
      && pdf.includes("1,000") && pdf.includes("50,000") && pdf.includes("Received by \\(receiver\\)") && pdf.includes("Signature")
      && !pdf.includes("DL-778899"), pdf.slice(0, 200));
    check("PDF output is deterministic", Buffer.from(renderDeliveryNote(snapRow.snapshot, { version: 1, sha256: snapRow.content_sha256, issuedAt: snapRow.created_at })).toString("latin1") === pdf);
    const tD = await trip(t3, 2, [[l3, 20]]);
    const dD1 = (await db.query<{ version_no: number }>("select * from issue_delivery_note($1,$2)", [tD, sender])).rows[0];
    await db.query("update stock_transfer_dispatches set driver_name='Changed Driver' where id=$1", [tD]);
    const dD2 = (await db.query<{ version_no: number; is_new: boolean }>("select * from issue_delivery_note($1,$2)", [tD, sender])).rows[0];
    check("re-issuing after a change creates version 2 and keeps version 1",
      dD1.version_no === 1 && dD2.version_no === 2 && dD2.is_new && Number(await one(db, "select count(*) from document_versions where owner_id=$1", [tD])) === 2);
    check("delivery-note versions cannot be edited", await fails(db, "update document_versions set version=9 where owner_id=$1", [tD]));

    // ------------------------------------------------------------ documents (private storage controls)
    const path = (owner: string) => `${co}/stock_transfer_dispatch/${owner}/${crypto.randomUUID()}`;
    const sha = "a".repeat(64);
    const first = await one(db, "select register_attachment($1,'stock_transfer_dispatch',$2,'loading_photo',$3,'f.jpg','f.jpg','image/jpeg',100,$4,null)", [sender, trip1, path(trip1), sha]);
    check("sender uploads loading photos; receiver uploads the signed delivery note",
      (await failMsg(db, "select register_attachment($1,'stock_transfer_dispatch',$2,'signed_delivery_note',$3,'s.pdf','s.pdf','application/pdf',100,$4,null)", [receiver, trip1, path(trip1), sha])) === null);
    check("a new version supersedes the photo and keeps the old one",
      (await failMsg(db, "select register_attachment($1,'stock_transfer_dispatch',$2,'loading_photo',$3,'g.jpg','g.jpg','image/jpeg',100,$4,$5)", [sender, trip1, path(trip1), sha, first])) === null
      && Number(await one(db, "select count(*) from document_attachments where owner_id=$1 and category='loading_photo'", [trip1])) === 2);
    check("a storekeeper cannot upload or see driver licences", await fails(db,
      "select register_attachment($1,'stock_transfer_dispatch',$2,'driver_licence',$3,'l.jpg','l.jpg','image/jpeg',100,$4,null)", [sender, trip1, path(trip1), sha], "driver licence"));
    check("transport invoices need financial permission", await fails(db,
      "select register_attachment($1,'stock_transfer_dispatch',$2,'transport_invoice',$3,'t.pdf','t.pdf','application/pdf',100,$4,null)", [sender, trip1, path(trip1), sha], "financial"));
    check("owner can store the licence image", (await failMsg(db, "select register_attachment($1,'stock_transfer_dispatch',$2,'driver_licence',$3,'l.jpg','l.jpg','image/jpeg',100,$4,null)", [owner, trip1, path(trip1), sha])) === null);
    check("both branches can open the trip's documents; an unrelated branch cannot",
      (await one<boolean>(db, "select can_access_document_owner($1,'stock_transfer_dispatch',$2)", [sender, trip1])) === true
      && (await one<boolean>(db, "select can_access_document_owner($1,'stock_transfer_dispatch',$2)", [receiver, trip1])) === true
      && (await one<boolean>(db, "select can_access_document_owner($1,'stock_transfer_dispatch',$2)", [outsider, trip1])) === false);

    // ------------------------------------------------------------ RLS: same cargo for both branches, nothing for others
    const seen = async (uid: string) => {
      await db.query("savepoint rls");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await db.query("set local role authenticated");
      const r = {
        t: Number(await one(db, "select count(*) from stock_transfers where id=$1", [t1])),
        trips: Number(await one(db, "select count(*) from stock_transfer_dispatches where transfer_id=$1", [t1])),
        lines: Number(await one(db, "select count(*) from stock_transfer_dispatch_lines where dispatch_id=$1", [trip1])),
        events: Number(await one(db, "select count(*) from stock_transfer_events where transfer_id=$1", [t1])),
        agents: Number(await one(db, "select count(*) from stock_transfer_agents where transfer_id=$1", [t1])),
        receipts: Number(await one(db, "select count(*) from stock_transfer_receipts where transfer_id=$1", [t1])),
      };
      let licence = true;
      try { await db.query("savepoint lic"); await db.query("select driver_licence from stock_transfer_dispatches limit 1"); await db.query("release savepoint lic"); }
      catch { licence = false; await db.query("rollback to savepoint lic"); }
      await db.query("rollback to savepoint rls");
      return { ...r, licence };
    };
    const vs = await seen(sender), vr = await seen(receiver), vo = await seen(outsider);
    check("sender and receiver see the same transfer, trips, cargo, timeline, agents and receipts",
      JSON.stringify({ ...vs, licence: 0 }) === JSON.stringify({ ...vr, licence: 0 }) && vs.t === 1 && vs.trips === 1 && vs.lines === 1 && vs.events >= 3 && vs.agents === 2 && vs.receipts === 1,
      JSON.stringify([vs, vr]));
    check("an unrelated branch user sees none of it", vo.t + vo.trips + vo.lines + vo.events + vo.agents + vo.receipts === 0, JSON.stringify(vo));
    check("app users cannot read driver licence numbers directly", !vs.licence && !vr.licence);
    check("app users cannot call transfer posting functions",
      (await one<boolean>(db, "select has_function_privilege('authenticated','public.receive_transfer_trip(uuid,uuid,jsonb,timestamptz,text,text,text,text)','execute')")) === false);
    check("timeline records dispatch, charges, receipt and delivery note",
      (await one(db, "select string_agg(distinct event_type, ',' order by event_type) from stock_transfer_events where transfer_id=$1", [t1]))
        === "charge_accrued,charge_invoiced,delivery_note,dispatched,received");

    // ------------------------------------------------------------ reconciliation
    check("every journal balances", Number(await one(db, `select count(*) from (select j.id from journal_entries j join journal_lines l on l.journal_id=j.id
      where j.company_id=$1 group by j.id having sum(l.debit) <> sum(l.credit)) x`, [co])) === 0);
    const sub = n(await one(db, "select coalesce(sum(stock_value),0) from stock_balances where company_id=$1", [co]));
    check("1150 GL = stock subledger (in-transit value is no longer inside 1150)", (await gl("1150")) === sub, `${await gl("1150")} vs ${sub}`);
    check("1155 GL = value on trips still in transit", (await gl("1155")) === (await transitTotal()), `${await gl("1155")} vs ${await transitTotal()}`);
    check("2140 GL = charges accrued and not invoiced",
      (await gl("2140")) === -n(await one(db, "select coalesce(sum(accrued_amount),0) from cost_sources where company_id=$1 and status='accrued'", [co])));
    check("transfer line totals equal their trips",
      Number(await one(db, `select count(*) from stock_transfer_lines l where l.company_id=$1 and exists (select 1 from stock_transfers t where t.id=l.transfer_id and t.posts_in_transit)
        and l.transit_value <> coalesce((select sum(x.transit_value) from stock_transfer_dispatch_lines x join stock_transfer_dispatches dd on dd.id=x.dispatch_id
          where x.transfer_line_id=l.id and dd.status not in ('draft','voided')),0)`, [co])) === 0);

    console.log(`\n${passed} transfer Stage 6 checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nTransfer Stage 6 test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main();
