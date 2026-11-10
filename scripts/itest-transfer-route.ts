/**
 * Changing the route (destination branch) of a stock transfer (migration
 * 0045). One transaction, ROLLED BACK. PGlite only.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-transfer-route runs only against the PGlite test database (npm run test:db).");
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
async function err(db: Client, sql: string, p: unknown[] = []): Promise<string> {
  await db.query("savepoint sp");
  try { await db.query(sql, p); await db.query("release savepoint sp"); return ""; }
  catch (e) { await db.query("rollback to savepoint sp"); return (e as Error).message || "error"; }
}

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const co = await one(db, "select id from companies where code='ELEMENTS'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    await db.query("update feature_flags set is_enabled=true where company_id=$1", [co]);
    const dod = await one(db, "insert into branches(company_id, code, name) values ($1,'RDOD','Dodoma R') returning id", [co]);
    const mwz = await one(db, "insert into branches(company_id, code, name) values ($1,'RMWZ','Mwanza R') returning id", [co]);
    const p = await one(db, "insert into products(company_id, sku, name, base_unit_id, net_weight_kg) values ($1,'RT-A','Route bag',$2,50) returning id", [co, bag]);
    await db.query("select record_stock_movement($1,$2,$3,'opening','opening',gen_random_uuid(),'OPEN',100,0,1000,$4)", [co, hq, p, owner]);
    const transit = (b: string) => one<number>(db, "select coalesce((select qty_in_transit from stock_balances where branch_id=$1 and product_id=$2),0)", [b, p]).then(Number);

    const t = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id, reference, notes) values ($1,$2,$3,'REF-1','keep me') returning id", [co, hq, dod]);
    const l = await one(db, "insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,20) returning id", [t, p]);

    check("a reason is required", (await err(db, "select change_transfer_destination($1,$2,$3,' ')", [t, owner, mwz])) !== "");
    check("the destination cannot be the sending branch", /sending branch/.test(await err(db, "select change_transfer_destination($1,$2,$3,'x')", [t, owner, hq])));
    await db.query("select change_transfer_destination($1,$2,$3,'customer moved')", [t, owner, mwz]);
    check("a draft transfer changes route and keeps everything else",
      await one(db, "select destination_branch_id from stock_transfers where id=$1", [t]) === mwz
      && await one(db, "select reference || '|' || notes from stock_transfers where id=$1", [t]) === "REF-1|keep me"
      && Number(await one(db, "select qty_requested from stock_transfer_lines where id=$1", [l])) === 20);

    // Dispatch a trip to Mwanza, then redirect it to Dodoma while on the road.
    const d = await one(db, `insert into stock_transfer_dispatches(company_id, transfer_id, trip_no, dispatch_date, driver_name, vehicle_registration)
      values ($1,$2,1,current_date,'Juma','T 1 AAA') returning id`, [co, t]);
    await db.query("insert into stock_transfer_dispatch_lines(company_id, dispatch_id, transfer_line_id, qty) values ($1,$2,$3,20)", [co, d, l]);
    await db.query("select dispatch_transfer_trip($1,$2,gen_random_uuid()::text)", [d, owner]);
    await db.query("select * from issue_delivery_note($1,$2)", [d, owner]);
    const dn = await one(db, "select delivery_note_number from stock_transfer_dispatches where id=$1", [d]);
    check("dispatched goods are in transit to Mwanza", await transit(mwz) === 20 && await transit(dod) === 0);
    await db.query("select change_transfer_destination($1,$2,$3,'redirected on the road')", [t, owner, dod]);
    check("in-transit stock moves to the new destination", await transit(dod) === 20 && await transit(mwz) === 0);
    check("the trip, truck and driver are unchanged",
      await one(db, "select status || '|' || vehicle_registration || '|' || driver_name from stock_transfer_dispatches where id=$1", [d]) === "dispatched|T1AAA|Juma");
    check("the delivery note keeps its number and shows the new destination",
      await one(db, "select delivery_note_number from stock_transfer_dispatches where id=$1", [d]) === dn
      && await one(db, "select snapshot->'receiver'->>'name' from document_versions where owner_id=$1 and kind='delivery_note' order by version desc limit 1", [d]) === "Dodoma R");
    check("the change is recorded with the reason",
      Number(await one(db, "select count(*) from stock_transfer_events where transfer_id=$1 and event_type='route_changed' and note like '%redirected on the road%'", [t])) === 1);

    // After receipt the route is fixed.
    await db.query("select receive_transfer_trip($1,$2,$3::jsonb,now(),null,'Store',gen_random_uuid()::text,gen_random_uuid()::text)",
      [d, owner, JSON.stringify([{ dispatch_line_id: await one(db, "select id from stock_transfer_dispatch_lines where dispatch_id=$1", [d]), accepted: 20, quarantined: 0, short: 0 }])]);
    check("goods arrive at the new destination", Number(await one(db, "select quantity from stock_balances where branch_id=$1 and product_id=$2", [dod, p])) === 20);
    // A transport charge posted with its supplier: owed to the supplier, added to the received goods.
    const haul = await one(db, "insert into suppliers(company_id, code, name) values ($1,'RT-HAUL','Route Haulage') returning id", [co]);
    const src = await one(db, `insert into cost_sources(company_id, owner_type, stock_transfer_id, cost_category_id, estimated_amount, supplier_id, allocation_basis)
      values ($1,'stock_transfer',$2,(select id from cost_categories where company_id=$1 and code='TRANSPORT'),20000,$3,'quantity') returning id`, [co, t, haul]);
    const ci = await one(db, `insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number, document_kind)
      values ($1,$2,$3,current_date,'RT-77','invoice') returning id`, [co, hq, haul]);
    await db.query(`insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount)
      values ($1,$2,(select id from cost_categories where company_id=$1 and code='TRANSPORT'),$3,20000)`, [co, ci, src]);
    const before = Number(await one(db, "select stock_value from stock_balances where branch_id=$1 and product_id=$2", [dod, p]));
    await db.query("select post_cost_invoice($1,$2,gen_random_uuid()::text)", [ci, owner]);
    check("a transfer charge posted with its supplier is owed to the supplier and added to the received goods",
      Number(await one(db, "select coalesce(sum(outstanding),0) from supplier_payables where supplier_id=$1", [haul])) === 20000
      && Number(await one(db, "select stock_value from stock_balances where branch_id=$1 and product_id=$2", [dod, p])) === before + 20000);
    check("a received transfer cannot change route", (await err(db, "select change_transfer_destination($1,$2,$3,'late')", [t, owner, mwz])) !== "");

    // ------------------------------------------------------------ changing quantities (0055)
    const gl = async (code: string) => Number(await one(db, `select coalesce(sum(jl.debit - jl.credit),0) from journal_lines jl join journal_entries je on je.id = jl.journal_id
      join chart_of_accounts a on a.id = jl.account_id where je.company_id=$1 and a.code=$2`, [co, code]));
    const stockQty = async (b: string) => Number(await one(db, "select coalesce((select quantity from stock_balances where branch_id=$1 and product_id=$2),0)", [b, p]));
    const t2 = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3) returning id", [co, hq, mwz]);
    const l2 = await one(db, "insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,30) returning id", [t2, p]);
    check("requested quantity can be changed before dispatch", (await err(db, "select change_transfer_line_quantity($1,$2,25,'customer wants less')", [l2, owner])) === ""
      && Number(await one(db, "select qty_requested from stock_transfer_lines where id=$1", [l2])) === 25);
    const mkUser = async (email: string, role: string) => {
      const id = await one(db, "insert into auth.users(email) values ($1) returning id", [email]);
      await db.query("insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active) values ($1,$2,$2,(select id from roles where code=$3),$4,true)", [id, email, role, co]);
      await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [id, co]);
      await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [id, hq]);
      return id;
    };
    const sm = await mkUser("rt-sm@test.local", "SALES_MANAGER"), so = await mkUser("rt-so@test.local", "CASHIER");
    check("a Sales Manager of the sending branch can change a transfer quantity",
      (await err(db, "select change_transfer_line_quantity($1,$2,26,'customer added 1')", [l2, sm])) === "");
    check("a Sales Officer cannot", /not allowed|permission|authoris/i.test(await err(db, "select change_transfer_line_quantity($1,$2,27,'x')", [l2, so])));
    await db.query("select change_transfer_line_quantity($1,$2,25,'back to 25')", [l2, owner]);
    check("a reason is required to change a quantity", (await err(db, "select change_transfer_line_quantity($1,$2,24,' ')", [l2, owner])) !== "");
    const d2 = await one(db, `insert into stock_transfer_dispatches(company_id, transfer_id, trip_no, dispatch_date, driver_name, vehicle_registration)
      values ($1,$2,1,current_date,'Ali','T 2 BBB') returning id`, [co, t2]);
    const dl2 = await one(db, "insert into stock_transfer_dispatch_lines(company_id, dispatch_id, transfer_line_id, qty) values ($1,$2,$3,20) returning id", [co, d2, l2]);
    await db.query("select change_trip_line_quantity($1,$2,22,'loaded 2 more',gen_random_uuid()::text)", [dl2, owner]);
    check("a draft trip's quantity simply changes", Number(await one(db, "select qty from stock_transfer_dispatch_lines where id=$1", [dl2])) === 22);
    await db.query("select dispatch_transfer_trip($1,$2,gen_random_uuid()::text)", [d2, owner]);
    await db.query("select * from issue_delivery_note($1,$2)", [d2, owner]);
    const hqBefore = await stockQty(hq);
    check("lowering the requested quantity below what is loaded corrects the trip (22 -> 20) and returns the stock",
      (await err(db, "select change_transfer_line_quantity($1,$2,20,'customer wants 20')", [l2, owner])) === ""
      && Number(await one(db, "select qty from stock_transfer_dispatch_lines where id=$1", [dl2])) === 20
      && Number(await one(db, "select qty_requested from stock_transfer_lines where id=$1", [l2])) === 20
      && await stockQty(hq) === hqBefore + 2);
    await db.query("select change_trip_line_quantity($1,$2,22,'back to 22',gen_random_uuid()::text)", [dl2, owner]);
    const hqQ = await stockQty(hq), tr0 = await transit(mwz), g1155 = await gl("1155"), g1150 = await gl("1150");
    await db.query("select change_trip_line_quantity($1,$2,18,'4 bags fell off at loading, not sent',gen_random_uuid()::text)", [dl2, owner]);
    check("reducing a dispatched trip returns the stock to the sending branch and reduces goods in transit",
      await stockQty(hq) === hqQ + 4 && await transit(mwz) === tr0 - 4
      && Number(await one(db, "select qty from stock_transfer_dispatch_lines where id=$1", [dl2])) === 18
      && Number(await one(db, "select qty_dispatched from stock_transfer_lines where id=$1", [l2])) === 18);
    check("the returned value moves from goods in transit (1155) back to inventory (1150): 4 bags x 1,000",
      await gl("1155") === g1155 - 4000 && await gl("1150") === g1150 + 4000, `${await gl("1155") - g1155} ${await gl("1150") - g1150}`);
    await db.query("select change_trip_line_quantity($1,$2,21,'counted again: 21 on the truck',gen_random_uuid()::text)", [dl2, owner]);
    check("increasing takes more out of the sending branch into transit",
      await stockQty(hq) === hqQ + 1 && await transit(mwz) === tr0 - 1 && await gl("1155") === g1155 - 1000 && await gl("1150") === g1150 + 1000);
    check("every change is in the trip history and the delivery note is re-issued each time (AMENDED)",
      Number(await one(db, "select count(*) from stock_transfer_dispatch_changes where dispatch_id=$1 and new_values ? 'quantity RT-A'", [d2])) === 4
      && Number(await one(db, "select max(version) from document_versions where owner_id=$1 and kind='delivery_note'", [d2])) === 5
      && Number(await one(db, "select (snapshot->'lines'->0->>'qty')::numeric from document_versions where owner_id=$1 and kind='delivery_note' order by version desc limit 1", [d2])) === 21);
    const dl2id = await one(db, "select id from stock_transfer_dispatch_lines where id=$1", [dl2]);
    await db.query("select receive_transfer_trip($1,$2,$3::jsonb,now(),null,'Store',gen_random_uuid()::text,gen_random_uuid()::text)",
      [d2, owner, JSON.stringify([{ dispatch_line_id: dl2id, accepted: 21, quarantined: 0, short: 0 }])]);
    check("after receipt the trip quantity cannot be changed",
      /already received/.test(await err(db, "select change_trip_line_quantity($1,$2,20,'late',gen_random_uuid()::text)", [dl2, owner])));
    check("the received goods arrive at the corrected quantity", await stockQty(mwz) === 21);
    check("ledger balances", Number(await one(db, `select count(*) from (select je.id from journal_entries je join journal_lines jl on jl.journal_id=je.id
      where je.company_id=$1 group by je.id having sum(jl.debit) <> sum(jl.credit)) x`, [co])) === 0);

    // ------------------------------------------------------------ registrations saved in one form (0059)
    const t9 = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id, vehicle_registration, trailer_registration) values ($1,$2,$3,'T. T 760 DWG','t-111 zz.z') returning id", [co, hq, mwz]);
    check("a transfer saves T. T 760 DWG as T760DWG and the trailer as T111ZZZ",
      await one(db, "select vehicle_registration || '|' || trailer_registration from stock_transfers where id=$1", [t9]) === "T760DWG|T111ZZZ");
    const d9 = await one(db, "insert into stock_transfer_dispatches(company_id, transfer_id, trip_no, dispatch_date, vehicle_registration) values ($1,$2,1,current_date,'UAA 123A') returning id", [co, t9]);
    check("foreign plates keep every letter and digit (UAA 123A -> UAA123A)", await one(db, "select vehicle_registration from stock_transfer_dispatches where id=$1", [d9]) === "UAA123A");
    await db.query("update stock_transfer_dispatches set vehicle_registration='T. 760DWG' where id=$1", [d9]);
    check("trips are corrected on update too", await one(db, "select vehicle_registration from stock_transfer_dispatches where id=$1", [d9]) === "T760DWG");
    console.log(`\nTransfer route change: ${passed} checks passed.`);
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
