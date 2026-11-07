/**
 * Payment-first sales with truck fulfilment (migration 0044). One
 * transaction, ROLLED BACK. PGlite only.
 *
 * Covers the acceptance list: no order before approval, self-approval
 * blocked, one approval records the receipt once and commits funds, stock
 * reserved, 90 MT dispatched on three 30 MT trucks (and unequal 28/32/30)
 * with invoices that reconcile to the order, quantity limits, partial
 * loading, cancellation releasing allocations, idempotent dispatch, document
 * regeneration without reposting, excess payment kept as credit, one receipt
 * funding two orders, duplicate payment references, reversal blocking open
 * trucks, delivery exceptions, amendments and access control.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-sales-fulfilment runs only against the PGlite test database (npm run test:db).");
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
const num = async (db: Client, sql: string, p: unknown[] = []) => Number(await one(db, sql, p));
/** Runs in a savepoint; returns the error message, or "" when it succeeded. */
async function err(db: Client, sql: string, p: unknown[] = []): Promise<string> {
  await db.query("savepoint sp");
  try { await db.query(sql, p); await db.query("release savepoint sp"); return ""; }
  catch (e) { await db.query("rollback to savepoint sp"); return (e as Error).message || "error"; }
}
const can = async (db: Client, role: string, perm: string) =>
  Number(await one(db, `select count(*) from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
    where r.code = $1 and p.code = $2`, [role, perm])) === 1;

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const co = await one(db, "select id from companies where code='ELEMENTS'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const bank = await one(db, "select id from payment_accounts where company_id=$1 and code='NMB'", [co]);
    const mpesa = await one(db, "select id from payment_accounts where company_id=$1 and code='MPESA'", [co]);
    const vat = await one(db, "select id from tax_codes where company_id=$1 and code='VAT18'", [co]);
    const a1150 = await one(db, "select id from chart_of_accounts where company_id=$1 and code='1150'", [co]);
    const a3200 = await one(db, "select id from chart_of_accounts where company_id=$1 and code='3200'", [co]);
    const aru = await one(db, "insert into branches(company_id, code, name) values ($1,'ARX','Arusha X') returning id", [co]);
    const mt = await one(db, "insert into units(company_id, code, name) values ($1,'MTX','Metric tonne') returning id", [co]);
    const bal = async (code: string) => num(db, `select coalesce(sum(jl.debit - jl.credit),0) from journal_lines jl join journal_entries je on je.id = jl.journal_id
      join chart_of_accounts a on a.id = jl.account_id where je.company_id=$1 and a.code=$2`, [co, code]);

    const bankLedger = await one(db, "select resolve_payment_ledger($1,$2)", [co, bank]);
    const bankBal = () => num(db, "select coalesce(sum(debit - credit),0) from journal_lines where account_id=$1", [bankLedger]);

    // ------------------------------------------------------------ roles
    check("Branch Manager and Sales Manager approve sales; the Sales Officer does not",
      await can(db, "DIRECTOR", "sales.approve") && await can(db, "SALES_MANAGER", "sales.approve") && !(await can(db, "CASHIER", "sales.approve")));
    check("the Sales Officer fulfils approved orders", await can(db, "CASHIER", "sales.fulfil")
      && await one(db, "select name from roles where code='CASHIER'") === "Sales Officer");
    check("Customer Advances (2150) exists", await num(db, "select count(*) from chart_of_accounts where company_id=$1 and code='2150'", [co]) === 1);

    const mkUser = async (email: string, role: string, branch: string) => {
      const id = await one(db, "insert into auth.users(email) values ($1) returning id", [email]);
      await db.query("insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active) values ($1,$2,$3,(select id from roles where code=$4),$5,true)", [id, email, email.split("@")[0], role, co]);
      await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [id, co]);
      await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [id, branch]);
      return id;
    };
    const officer = await mkUser("officer@test.local", "CASHIER", hq);
    const manager = await mkUser("manager@test.local", "DIRECTOR", hq);
    const salesMgr = await mkUser("salesmgr@test.local", "SALES_MANAGER", hq);
    const mgrAru = await mkUser("manager-aru@test.local", "DIRECTOR", aru);
    const auditor = await mkUser("auditor@test.local", "AUDITOR", hq);

    // ------------------------------------------------------------ stock: 200 MT of fertiliser
    const prod = await one(db, "insert into products(company_id, sku, name, base_unit_id, selling_price) values ($1,'UREA-MT','Urea bulk',$2,333333.33) returning id", [co, mt]);
    await db.query("select record_stock_movement_value($1,$2,$3,'opening','opening',gen_random_uuid(),'OPEN',$4,$5,$6)", [co, hq, prod, 200, 100000000, owner]);
    await db.query("select create_journal($1,$2,current_date,'opening',gen_random_uuid(),'OPEN','opening',$3,$4::jsonb)", [co, hq, owner,
      JSON.stringify([{ account_id: a1150, debit: 100000000, credit: 0 }, { account_id: a3200, debit: 0, credit: 100000000 }])]);
    const svc = await one(db, "insert into products(company_id, sku, name, base_unit_id, selling_price, track_inventory) values ($1,'TRANS','Transport',$2,0,false) returning id", [co, mt]);
    const cust = await one(db, "insert into customers(company_id, code, name) values ($1,'SF-C','Fulfilment customer') returning id", [co]);

    // A request with lines and payments, inserted the way the server action does.
    const mkRequest = async (lines: { product: string; qty: number; price: number; tax?: boolean; stock?: boolean }[],
      payments: { account: string; amount: number; ref: string }[], mode = "delivery", by = officer) => {
      const rq = await one(db, `insert into sales_requests(company_id, branch_id, customer_id, fulfilment_mode, destination, consignee_name, created_by)
        values ($1,$2,$3,$4,'Mbeya','Mbeya Agro',$5) returning id`, [co, hq, cust, mode, by]);
      let i = 0;
      for (const l of lines) {
        await db.query(`insert into sales_request_lines(request_id, line_no, product_id, description, quantity, unit_price, original_price,
            tax_code_id, tax_rate, tax_type, tax_name, track_inventory) values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)`,
          [rq, ++i, l.product, l.stock === false ? "Transport" : "Urea bulk", l.qty, l.price, l.tax === false ? null : vat,
           l.tax === false ? 0 : 18, l.tax === false ? "zero_rated" : "standard", l.tax === false ? null : "VAT 18%", l.stock !== false]);
      }
      for (const p of payments) {
        await db.query(`insert into sales_request_payments(request_id, payment_method, payment_account_id, payment_date, amount, reference)
          values ($1,'bank_transfer',$2,current_date,$3,$4)`, [rq, p.account, p.amount, p.ref]);
      }
      return rq;
    };
    const verifyAll = async (rq: string) => JSON.stringify((await db.query("select id from sales_request_payments where request_id=$1", [rq])).rows
      .map((r) => ({ payment_id: r.id, basis: "Checked NMB statement" })));
    const approve = (rq: string, by: string, ver: string) =>
      db.query("select approve_sales_request($1,$2,gen_random_uuid()::text,$3::jsonb,'ok') as id", [rq, by, ver]).then((r) => r.rows[0].id as string);

    // ------------------------------------------------------------ request -> one approval
    const order90 = 35399999.65; // 90 x 333,333.33 = 29,999,999.70 + VAT 5,399,999.95
    const rq = await mkRequest([{ product: prod, qty: 90, price: 333333.33 }], [{ account: bank, amount: 36000000, ref: "NMB-TT-001" }]);
    check("a draft request creates no order, receipt or journal",
      await num(db, "select count(*) from sales_orders where request_id=$1", [rq]) === 0
      && await num(db, "select count(*) from customer_receipts where company_id=$1", [co]) === 0);
    check("a draft cannot be approved", (await err(db, "select approve_sales_request($1,$2,'k-d','[]'::jsonb,null)", [rq, manager])) !== "");
    const srq = await one(db, "select submit_sales_request($1,$2)", [rq, officer]);
    check("submission numbers the request SRQ-YY-########", /^SRQ-\d{2}-\d{8}$/.test(srq), srq);
    check("an auditor cannot submit requests", (await err(db, "select submit_sales_request($1,$2)", [rq, auditor])) !== "");
    check("the officer cannot approve their own request", /cannot approve|permission/i.test(await err(db, "select approve_sales_request($1,$2,'k1',$3::jsonb,null)", [rq, officer, await verifyAll(rq)])));
    check("a manager of another branch cannot approve", (await err(db, "select approve_sales_request($1,$2,'k2',$3::jsonb,null)", [rq, mgrAru, await verifyAll(rq)])) !== "");
    check("approval needs every payment verified with a basis",
      /not verified/.test(await err(db, "select approve_sales_request($1,$2,'k3','[]'::jsonb,null)", [rq, manager])));
    check("still no order or receipt after failed attempts",
      await num(db, "select count(*) from sales_orders where request_id=$1", [rq]) === 0
      && await num(db, "select count(*) from customer_receipts where company_id=$1", [co]) === 0);

    // Return for correction, then resubmit and approve.
    check("return needs a reason", (await err(db, "select decide_sales_request($1,$2,'return',' ')", [rq, manager])) !== "");
    await db.query("select decide_sales_request($1,$2,'return','attach the bank slip')", [rq, manager]);
    check("returned requests go back to the officer", await one(db, "select status from sales_requests where id=$1", [rq]) === "returned");
    await db.query("select submit_sales_request($1,$2)", [rq, officer]);
    check("resubmission keeps the same number", await one(db, "select document_number from sales_requests where id=$1", [rq]) === srq);

    const ver = await verifyAll(rq);
    const idem = "approve-" + rq;
    const so = await one(db, "select approve_sales_request($1,$2,$3,$4::jsonb,'Verified on NMB online')", [rq, manager, idem, ver]);
    const so2 = await one(db, "select approve_sales_request($1,$2,$3,$4::jsonb,'again')", [rq, manager, idem, ver]);
    const so3 = await one(db, "select approve_sales_request($1,$2,'other-key',$3::jsonb,'again')", [rq, manager, ver]);
    check("Approve creates the Sales Order directly approved; repeats return the same order",
      so === so2 && so === so3 && await one(db, "select status from sales_orders where id=$1", [so]) === "approved");
    check("the order number is SO-YY-########", /^SO-\d{2}-\d{8}$/.test(await one(db, "select document_number from sales_orders where id=$1", [so])));
    check("the order value is 35,399,999.65", await num(db, "select grand_total from sales_orders where id=$1", [so]) === order90);
    check("the receipt was recorded exactly once, as an advance",
      await num(db, "select count(*) from customer_receipts where company_id=$1 and receipt_kind='advance'", [co]) === 1
      && await one(db, "select verified_by from customer_receipts where company_id=$1", [co]) === manager);
    check("receipt journal Dr bank / Cr Customer Advances 36,000,000", await bal("2150") === -36000000 && await bankBal() === 36000000);
    const rcpt = await one(db, "select id from customer_receipts where company_id=$1", [co]);
    check("funds committed = order value; the excess stays as customer credit",
      await num(db, "select sum(amount_committed) from sales_order_funds where order_id=$1", [so]) === order90
      && await num(db, "select customer_receipt_available($1)", [rcpt]) === Math.round((36000000 - order90) * 100) / 100);
    check("approval posts no revenue and moves no stock",
      await bal("4100") === 0 && await num(db, "select quantity from stock_balances where branch_id=$1 and product_id=$2", [hq, prod]) === 200);
    check("90 MT is reserved for the order", await num(db, "select sales_reserved_qty($1,$2,$3)", [co, hq, prod]) === 90);
    check("the approval is on the timeline with the approver",
      await num(db, "select count(*) from sales_events where order_id=$1 and event_type='approved' and user_id=$2", [so, manager]) === 1);
    check("a converted request cannot be returned", (await err(db, "select decide_sales_request($1,$2,'reject','late')", [rq, manager])) !== "");

    // ------------------------------------------------------------ duplicate payment reference
    const rqDup = await mkRequest([{ product: prod, qty: 1, price: 333333.33 }], [{ account: bank, amount: 400000, ref: " nmb-tt-001 " }]);
    await db.query("select submit_sales_request($1,$2)", [rqDup, officer]);
    check("the same bank reference cannot be recorded twice",
      /already recorded/.test(await err(db, "select approve_sales_request($1,$2,'kd',$3::jsonb,null)", [rqDup, manager, await verifyAll(rqDup)])));
    await db.query("select decide_sales_request($1,$2,'reject','duplicate payment')", [rqDup, manager]);

    // ------------------------------------------------------------ stock reservation across orders
    const rqBig = await mkRequest([{ product: prod, qty: 120, price: 1000 }], [{ account: mpesa, amount: 141600, ref: "MP-BIG" }]);
    await db.query("select submit_sales_request($1,$2)", [rqBig, officer]);
    check("a second order cannot take stock already reserved (200 on hand, 90 reserved, 120 asked)",
      /Not enough stock/.test(await err(db, "select approve_sales_request($1,$2,'kb',$3::jsonb,null)", [rqBig, manager, await verifyAll(rqBig)])));
    check("the failed approval left no receipt behind",
      await num(db, "select count(*) from customer_receipts where reference='MP-BIG'") === 0);
    await db.query("select decide_sales_request($1,$2,'reject','not enough stock')", [rqBig, manager]);

    // ------------------------------------------------------------ underpaid request
    const rqShort = await mkRequest([{ product: prod, qty: 10, price: 1000 }], [{ account: mpesa, amount: 5000, ref: "MP-SHORT" }]);
    await db.query("select submit_sales_request($1,$2)", [rqShort, officer]);
    check("verified funds must cover the full sale",
      /do not cover/.test(await err(db, "select approve_sales_request($1,$2,'ks',$3::jsonb,null)", [rqShort, manager, await verifyAll(rqShort)])));

    // ------------------------------------------------------------ trucks for SO (90 MT -> 3 x 30)
    const ol = await one(db, "select id from sales_order_lines where order_id=$1", [so]);
    const header = JSON.stringify({ transporter_name: "Kilimo Haulage", driver_name: "J. Driver", driver_licence: "DL-123",
      vehicle_registration: "T 123 ABC", trailer_registration: "T 456 DEF" });
    const mkTruck = (key: string, qty: number) =>
      one(db, "select create_sales_shipment($1,$2,$3,$4::jsonb,$5::jsonb)", [so, officer, key, header, JSON.stringify([{ order_line_id: ol, qty }])]);
    const t1 = await mkTruck("truck-1", 30);
    check("creating a truck twice with the same key returns the same truck", await mkTruck("truck-1", 30) === t1);
    check("remaining to allocate is 60", await num(db, "select quantity - qty_dispatched - qty_allocated from sales_order_lines where id=$1", [ol]) === 60);
    check("a truck cannot take more than the remaining balance",
      /only 60/.test(await err(db, "select create_sales_shipment($1,$2,'too-much',$3::jsonb,$4::jsonb)", [so, officer, header, JSON.stringify([{ order_line_id: ol, qty: 61 }])])));
    check("loading cannot be recorded before the loading order",
      /loading order/.test(await err(db, "select record_shipment_loading($1,$2,'[]'::jsonb)", [t1, officer])));
    check("dispatch is refused before loading", (await err(db, "select dispatch_sales_shipment($1,$2,'x',true)", [t1, officer])) !== "");
    const lo1 = await one(db, "select issue_loading_order($1,$2)", [t1, officer]);
    const loNo = await one(db, "select loading_order_number from sales_shipments where id=$1", [t1]);
    check("the loading order gets its own LO number and a stored version", /^LO-\d{2}-\d{8}$/.test(loNo) && !!lo1);
    check("reissuing the loading order keeps the number and the version",
      await one(db, "select issue_loading_order($1,$2)", [t1, officer]) === lo1 && await one(db, "select loading_order_number from sales_shipments where id=$1", [t1]) === loNo);
    const sl1 = await one(db, "select id from sales_shipment_lines where shipment_id=$1", [t1]);
    await db.query("select record_shipment_loading($1,$2,$3::jsonb)", [t1, officer, JSON.stringify([{ shipment_line_id: sl1, qty_loaded: 30, batch: "B-77" }])]);
    check("dispatch needs the checks confirmed", /checked/.test(await err(db, "select dispatch_sales_shipment($1,$2,'x1',false)", [t1, officer])));
    check("an auditor cannot dispatch", (await err(db, "select dispatch_sales_shipment($1,$2,'x2',true)", [t1, auditor])) !== "");
    const inv1 = await one(db, "select dispatch_sales_shipment($1,$2,'disp-1',true)", [t1, officer]);
    const inv1b = await one(db, "select dispatch_sales_shipment($1,$2,'disp-1-retry',true)", [t1, officer]);
    check("dispatching twice returns the same invoice and moves stock once",
      inv1 === inv1b && await num(db, "select quantity from stock_balances where branch_id=$1 and product_id=$2", [hq, prod]) === 170
      && await num(db, "select count(*) from sales where shipment_id=$1", [t1]) === 1);
    check("truck 1 invoice = one third of the order (9,999,999.90 + VAT 1,799,999.98)",
      await num(db, "select net_total from sales where id=$1", [inv1]) === 9999999.9 && await num(db, "select tax_total from sales where id=$1", [inv1]) === 1799999.98);
    check("the truck invoice is paid from the committed advance (no new cash)",
      await one(db, "select payment_status from sales where id=$1", [inv1]) === "paid" && await bankBal() === 36000000 && await bal("1140") === 0);
    check("truck documents: DN number, delivery note and commercial invoice stored",
      /^DN-\d{2}-\d{8}$/.test(await one(db, "select delivery_note_number from sales_shipments where id=$1", [t1]))
      && await num(db, "select count(*) from document_versions where owner_type='sales_shipment' and owner_id=$1 and kind in ('delivery_note','commercial_invoice')", [t1]) === 2);
    check("the commercial invoice snapshot shows the invoice and the payment applied",
      await num(db, "select (snapshot->'invoice'->>'grand_total')::numeric from document_versions where owner_id=$1 and kind='commercial_invoice'", [t1]) === 11799999.88
      && await num(db, "select jsonb_array_length(snapshot->'invoice'->'payments') from document_versions where owner_id=$1 and kind='commercial_invoice'", [t1]) === 1);
    check("after dispatch the loading order is only reprinted (no new number or version)",
      await one(db, "select issue_loading_order($1,$2)", [t1, officer]) === lo1
      && await num(db, "select count(*) from document_versions where owner_id=$1 and kind='loading_order'", [t1]) === 1);
    check("a dispatched truck cannot be cancelled", /cannot be cancelled/.test(await err(db, "select cancel_sales_shipment($1,$2,'x')", [t1, officer])));
    check("remaining 60", await num(db, "select quantity - qty_dispatched from sales_order_lines where id=$1", [ol]) === 60);

    // Truck 2 planned 30, partially loaded 28; a cancelled truck releases its allocation.
    const tx = await mkTruck("truck-x", 10);
    await db.query("select cancel_sales_shipment($1,$2,'truck broke down')", [tx, officer]);
    check("cancelling a truck releases its allocation", await num(db, "select qty_allocated from sales_order_lines where id=$1", [ol]) === 0
      && await num(db, "select count(*) from sales where shipment_id=$1", [tx]) === 0);
    const t2 = await mkTruck("truck-2", 30);
    await db.query("select issue_loading_order($1,$2)", [t2, officer]);
    const sl2 = await one(db, "select id from sales_shipment_lines where shipment_id=$1", [t2]);
    await db.query("select record_shipment_loading($1,$2,$3::jsonb)", [t2, officer, JSON.stringify([{ shipment_line_id: sl2, qty_loaded: 28 }])]);
    check("partial loading frees the unloaded 2 MT for another truck", await num(db, "select quantity - qty_dispatched - qty_allocated from sales_order_lines where id=$1", [ol]) === 32);
    const inv2 = await one(db, "select dispatch_sales_shipment($1,$2,'disp-2',true)", [t2, officer]);
    const t3 = await mkTruck("truck-3", 32);
    await db.query("select issue_loading_order($1,$2)", [t3, officer]);
    const sl3 = await one(db, "select id from sales_shipment_lines where shipment_id=$1", [t3]);
    check("loading more than the approved balance is refused",
      /more than the approved/.test(await err(db, "select record_shipment_loading($1,$2,$3::jsonb)", [t3, officer, JSON.stringify([{ shipment_line_id: sl3, qty_loaded: 33 }])])));
    await db.query("select record_shipment_loading($1,$2,$3::jsonb)", [t3, officer, JSON.stringify([{ shipment_line_id: sl3, qty_loaded: 32 }])]);
    const inv3 = await one(db, "select dispatch_sales_shipment($1,$2,'disp-3',true)", [t3, officer]);
    const sums = (await db.query("select sum(net_total) n, sum(tax_total) t, sum(grand_total) g from sales where id = any($1::uuid[])", [[inv1, inv2, inv3]])).rows[0];
    check("30 + 28 + 32 MT: the three invoices add up exactly to the order (net, VAT, total)",
      Number(sums.n) === 29999999.7 && Number(sums.t) === 5399999.95 && Number(sums.g) === order90, JSON.stringify(sums));
    check("each truck has its own unique invoice, LO and DN numbers",
      await num(db, "select count(distinct document_number) from sales where id = any($1::uuid[])", [[inv1, inv2, inv3]]) === 3
      && await num(db, "select count(distinct delivery_note_number) from sales_shipments where order_id=$1 and delivery_note_number is not null", [so]) === 3
      && await num(db, "select count(distinct loading_order_number) from sales_shipments where order_id=$1 and status<>'cancelled'", [so]) === 3);
    check("fully dispatched: 0 remaining, stock 200 - 90 = 110, nothing reserved",
      await num(db, "select quantity - qty_dispatched from sales_order_lines where id=$1", [ol]) === 0
      && await num(db, "select quantity from stock_balances where branch_id=$1 and product_id=$2", [hq, prod]) === 110
      && await num(db, "select sales_reserved_qty($1,$2,$3)", [co, hq, prod]) === 0);
    check("no more trucks once the order is fully dispatched",
      (await err(db, "select create_sales_shipment($1,$2,'t4',$3::jsonb,$4::jsonb)", [so, officer, header, JSON.stringify([{ order_line_id: ol, qty: 1 }])])) !== "");
    check("revenue 29,999,999.70 and VAT 5,399,999.95 posted; advance reduced by the applied amount",
      await bal("4100") === -29999999.7 && await bal("2120") === -5399999.95 && await bal("2150") === -Math.round((36000000 - order90) * 100) / 100);
    check("the order is in fulfilment until deliveries are recorded", await one(db, "select status from sales_orders where id=$1", [so]) === "in_fulfilment");

    // Deliveries: truck 1 and 2 fine, truck 3 short by 1 MT -> exception, order not closed.
    for (const t of [t1, t2]) await db.query("select record_shipment_delivery($1,$2,$3::jsonb)", [t, officer, JSON.stringify({ recipient_name: "Store keeper Mbeya" })]);
    check("delivery needs who received it", /received/.test(await err(db, "select record_shipment_delivery($1,$2,'{}'::jsonb)", [t3, officer])));
    check("accepted + short + damaged must equal dispatched",
      /must equal/.test(await err(db, "select record_shipment_delivery($1,$2,$3::jsonb)", [t3, officer, JSON.stringify({ recipient_name: "X", lines: [{ shipment_line_id: sl3, qty_accepted: 30, qty_short: 1 }] })])));
    await db.query("select record_shipment_delivery($1,$2,$3::jsonb)", [t3, officer, JSON.stringify({ recipient_name: "Store keeper Mbeya", lines: [{ shipment_line_id: sl3, qty_accepted: 31, qty_short: 1 }] })]);
    check("a shortage raises an exception, restores no stock and keeps the order open",
      await num(db, "select count(*) from sales_order_exceptions where order_id=$1 and kind='delivery_shortage' and status='open'", [so]) === 1
      && await num(db, "select quantity from stock_balances where branch_id=$1 and product_id=$2", [hq, prod]) === 110
      && await one(db, "select status from sales_orders where id=$1", [so]) === "in_fulfilment");
    const exc = await one(db, "select id from sales_order_exceptions where order_id=$1", [so]);
    check("the officer cannot resolve exceptions", (await err(db, "select resolve_sales_exception($1,$2,'ok')", [exc, officer])) !== "");
    await db.query("select resolve_sales_exception($1,$2,'Transporter liable; claim raised')", [exc, salesMgr]);
    check("resolving the last exception completes the order and releases unused commitments",
      await one(db, "select status from sales_orders where id=$1", [so]) === "completed"
      && await num(db, "select sum(amount_committed - amount_applied - amount_released) from sales_order_funds where order_id=$1", [so]) === 0);
    check("timeline has every step with users",
      await num(db, "select count(distinct event_type) from sales_events where order_id=$1 or request_id=$2", [so, rq]) >= 9
      && await num(db, "select count(*) from sales_events where (order_id=$1 or request_id=$2) and user_id is null", [so, rq]) === 0);

    // ------------------------------------------------------------ one receipt funds a second order (customer credit)
    const credit = await num(db, "select customer_receipt_available($1)", [rcpt]);
    const rq2 = await mkRequest([{ product: prod, qty: 0.5, price: 1000 }], []);
    await db.query("insert into sales_request_funds(request_id, receipt_id, amount) values ($1,$2,590)", [rq2, rcpt]);
    await db.query("select submit_sales_request($1,$2)", [rq2, officer]);
    const so2b = await approve(rq2, salesMgr, "[]");
    check("existing customer credit funds a second order (Sales Manager approves)",
      !!so2b && await num(db, "select customer_receipt_available($1)", [rcpt]) === Math.round((credit - 590) * 100) / 100
      && await num(db, "select count(*) from customer_receipts where company_id=$1", [co]) === 1);
    const rq3 = await mkRequest([{ product: prod, qty: 1, price: 1000 }], []);
    await db.query("insert into sales_request_funds(request_id, receipt_id, amount) values ($1,$2,$3)", [rq3, rcpt, credit]);
    await db.query("select submit_sales_request($1,$2)", [rq3, officer]);
    check("funds already committed elsewhere cannot be used again",
      /no longer available/.test(await err(db, "select approve_sales_request($1,$2,'k-over','[]'::jsonb,null)", [rq3, manager])));

    // ------------------------------------------------------------ many receipts fund one order; charges; collection
    const rq4 = await mkRequest([
      { product: prod, qty: 10, price: 100000 },
      { product: svc, qty: 1, price: 50000, tax: false, stock: false }], [
      { account: bank, amount: 600000, ref: "NMB-A" }, { account: mpesa, amount: 680000, ref: "MP-B" }], "collection");
    await db.query("select submit_sales_request($1,$2)", [rq4, officer]);
    const so4 = await approve(rq4, manager, await verifyAll(rq4));
    check("two receipts fund one order (1,180,000 + transport 50,000 = 1,230,000)",
      await num(db, "select grand_total from sales_orders where id=$1", [so4]) === 1230000
      && await num(db, "select count(*) from sales_order_funds where order_id=$1", [so4]) === 2);
    const ol4 = await one(db, "select id from sales_order_lines where order_id=$1 and track_inventory", [so4]);
    const truck = async (order: string, line: string, key: string, qty: number) => {
      const t = await one(db, "select create_sales_shipment($1,$2,$3,$4::jsonb,$5::jsonb)", [order, officer, key, JSON.stringify({ collector_name: "C. Collector", collector_id_number: "NIDA-1" }), JSON.stringify([{ order_line_id: line, qty }])]);
      await db.query("select issue_loading_order($1,$2)", [t, officer]);
      const l = await one(db, "select id from sales_shipment_lines where shipment_id=$1", [t]);
      await db.query("select record_shipment_loading($1,$2,$3::jsonb)", [t, officer, JSON.stringify([{ shipment_line_id: l, qty_loaded: qty }])]);
      return t;
    };
    const c1 = await truck(so4, ol4, "c1", 4);
    const ci1 = await one(db, "select dispatch_sales_shipment($1,$2,'c1d',true)", [c1, officer]);
    check("charges follow the goods share (40% of transport on the first truck)",
      await num(db, "select grand_total from sales where id=$1", [ci1]) === 472000 + 20000);
    check("collection orders are marked dispatched (not in transit)", await one(db, "select status from sales_shipments where id=$1", [c1]) === "dispatched");
    const c2 = await truck(so4, ol4, "c2", 6);
    const ci2 = await one(db, "select dispatch_sales_shipment($1,$2,'c2d',true)", [c2, officer]);
    check("the final truck takes the remaining charge and the invoices reconcile",
      await num(db, "select sum(grand_total) from sales where sales_order_id=$1", [so4]) === 1230000
      && await num(db, "select grand_total from sales where id=$1", [ci2]) === 708000 + 30000);
    await db.query("select record_shipment_delivery($1,$2,$3::jsonb)", [c1, officer, JSON.stringify({ recipient_name: "C. Collector" })]);
    check("collected shipments are marked collected", await one(db, "select status from sales_shipments where id=$1", [c1]) === "collected");

    // ------------------------------------------------------------ payment reversal
    const rq5 = await mkRequest([{ product: prod, qty: 4, price: 100000 }], [{ account: bank, amount: 472000, ref: "NMB-BOUNCE" }]);
    await db.query("select submit_sales_request($1,$2)", [rq5, officer]);
    const so5 = await approve(rq5, manager, await verifyAll(rq5));
    const ol5 = await one(db, "select id from sales_order_lines where order_id=$1", [so5]);
    const r5 = await one(db, "select id from customer_receipts where reference='NMB-BOUNCE'");
    const d5 = await truck(so5, ol5, "r5a", 2);
    const i5 = await one(db, "select dispatch_sales_shipment($1,$2,'r5ad',true)", [d5, officer]);
    const p5 = await truck(so5, ol5, "r5b", 2);
    check("only a manager reverses a payment", (await err(db, "select reverse_customer_advance($1,$2,'bounced')", [r5, officer])) !== "");
    await db.query("select reverse_customer_advance($1,$2,'bank reversed the transfer')", [r5, manager]);
    check("reversal puts the order on hold with an exception and blocks the open truck",
      await one<boolean>(db, "select on_hold from sales_orders where id=$1", [so5]) === true
      && await num(db, "select count(*) from sales_order_exceptions where order_id=$1 and kind='payment_reversed' and status='open'", [so5]) === 1
      && /on hold/.test(await err(db, "select dispatch_sales_shipment($1,$2,'r5bd',true)", [p5, officer])));
    check("the dispatched truck is flagged and its invoice is unpaid again",
      await one<boolean>(db, "select payment_flag from sales_shipments where id=$1", [d5]) === true
      && await one(db, "select payment_status from sales where id=$1", [i5]) === "unpaid");
    check("resolving the reversal needs replacement funds",
      /short of verified funds/.test(await err(db, "select resolve_sales_exception((select id from sales_order_exceptions where order_id=$1),$2,'ok')", [so5, manager])));

    // ------------------------------------------------------------ amendments
    const rq6 = await mkRequest([{ product: prod, qty: 5, price: 100000 }], [{ account: bank, amount: 1000000, ref: "NMB-AMD" }]);
    await db.query("select submit_sales_request($1,$2)", [rq6, officer]);
    const so6 = await approve(rq6, manager, await verifyAll(rq6));
    const ol6 = await one(db, "select id from sales_order_lines where order_id=$1", [so6]);
    const r6 = await one(db, "select id from customer_receipts where reference='NMB-AMD'");
    const am = await one(db, "select request_sales_amendment($1,$2,'change_lines',$3::jsonb,'customer wants 2 MT more')", [so6, officer, JSON.stringify({ lines: [{ order_line_id: ol6, quantity: 7 }] })]);
    check("an increase without funds is refused", /more verified funds/.test(await err(db, "select approve_sales_amendment($1,$2,'[]'::jsonb)", [am, manager])));
    await db.query("select approve_sales_amendment($1,$2,$3::jsonb)", [am, manager, JSON.stringify([{ receipt_id: r6, amount: 236000 }])]);
    check("an approved increase with extra funds updates the order (7 MT = 826,000)",
      await num(db, "select grand_total from sales_orders where id=$1", [so6]) === 826000
      && await num(db, "select sum(amount_committed - amount_released) from sales_order_funds where order_id=$1", [so6]) === 826000);
    const am2 = await one(db, "select request_sales_amendment($1,$2,'cancel_remaining','{}'::jsonb,'customer cancelled')", [so6, officer]);
    check("the requester cannot approve their own amendment", (await err(db, "select approve_sales_amendment($1,$2,'[]'::jsonb)", [am2, officer])) !== "");
    await db.query("select approve_sales_amendment($1,$2,'[]'::jsonb)", [am2, salesMgr]);
    check("cancelling an undispatched order releases the stock and all funds to customer credit",
      await one(db, "select status from sales_orders where id=$1", [so6]) === "cancelled"
      && await num(db, "select customer_receipt_available($1)", [r6]) === 1000000);
    check("a customer advance can be refunded by a manager (Dr 2150 / Cr bank)",
      (await err(db, "select refund_customer_advance($1,$2,$3,1000000,'TT-REF','order cancelled')", [r6, manager, bank])) === ""
      && await num(db, "select customer_receipt_available($1)", [r6]) === 0);
    check("a refunded receipt cannot be refunded again", (await err(db, "select refund_customer_advance($1,$2,$3,1,'x','x')", [r6, manager, bank])) !== "");

    // ------------------------------------------------------------ Sales Officer creates customers, no duplicates
    const qc = (name: string, phone: string, tin: string | null = null, email: string | null = null, by = officer) =>
      err(db, "select create_customer_quick($1,$2,$3,$4,$5,$6,$7,null,null,null)", [co, hq, by, name, phone, email, tin]);
    check("the Sales Officer creates a missing customer with an auto code",
      (await qc("Mbeya Agro Dealers", "+255 754 123 456", "123-456-789", "info@mbeya-agro.tz")) === ""
      && /^CUST-\d{4}$/.test(await one(db, "select code from customers where name='Mbeya Agro Dealers'")));
    check("the same name (other case and spaces) is refused", /already exists.*same name/.test(await qc("  mbeya   AGRO dealers ", "0700 000 001")));
    check("the same phone in another format is refused", /same phone/.test(await qc("Another Dealer", "0754123456")));
    check("the same TIN is refused", /same TIN/.test(await qc("Third Dealer", "0700 000 002", "123456789")));
    check("the same email is refused", /same email/.test(await qc("Fourth Dealer", "0700 000 003", null, "INFO@mbeya-agro.tz")));
    check("a phone number is required", (await qc("No Phone Ltd", "")) !== "");
    check("an auditor cannot create customers", (await qc("Auditor Customer", "0700 000 004", null, null, auditor)) !== "");
    check("the database itself blocks a duplicate inserted another way",
      (await err(db, "insert into customers(company_id, code, name) values ($1,'DUP-1','MBEYA agro dealers')", [co])) !== "");

    // ------------------------------------------------------------ ledger integrity
    check("every journal balances", await num(db, `select count(*) from (select je.id from journal_entries je join journal_lines jl on jl.journal_id = je.id
      where je.company_id=$1 group by je.id having sum(jl.debit) <> sum(jl.credit)) x`, [co]) === 0);
    check("workflow functions are not callable by signed-in users directly",
      await one<boolean>(db, "select has_function_privilege('authenticated','public.approve_sales_request(uuid,uuid,text,jsonb,text)','execute')") === false
      && await one<boolean>(db, "select has_function_privilege('authenticated','public.dispatch_sales_shipment(uuid,uuid,text,boolean)','execute')") === false);

    console.log(`\nSales fulfilment: ${passed} checks passed.`);
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
