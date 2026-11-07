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
      await one(db, "select status || '|' || vehicle_registration || '|' || driver_name from stock_transfer_dispatches where id=$1", [d]) === "dispatched|T 1 AAA|Juma");
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

    console.log(`\nTransfer route change: ${passed} checks passed.`);
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
