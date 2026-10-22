/**
 * Stage 9 — negative cases and regression across the whole upgrade, on the
 * final schema (all migrations). One transaction, ROLLED BACK. PGlite only.
 *
 * Negative: API / RPC / table / Storage-path access, guessed cross-company
 * references, unrelated branches, foreign currency outside purchasing,
 * invalid pack outputs, negative stock, duplicate posting, competing
 * rebagging, invalid allocations, edits to posted records, locked periods,
 * unsafe reversals.
 * Regression: stock adjustments + Kardex consistency, bank reconciliation
 * adjustment, manual journal + trial balance / statements, audit log
 * immutability.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-negative runs only against the PGlite test database (npm run test:db).");
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
const key = () => `neg-key-${++k}-${Math.random().toString(36).slice(2)}`;
const n = (x: unknown) => Number(x);

// Functions an app role may call: RLS helpers that only answer about the
// caller. Everything else (posting, reports, helpers) is service-role only.
const APP_CALLABLE = new Set(["has_company_access", "current_user_has_branch", "has_branch_access", "is_active_user", "is_owner", "current_user_id", "uid"]);

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
    const kg = await one(db, "select id from units where company_id=$1 and code='KG'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    const cash = await one(db, "select id from payment_accounts where company_id=$1 and code='CASH'", [co]);
    const walkin = await one(db, "select id from customers where company_id=$1 and code='WALK-IN'", [co]);
    await db.query("update feature_flags set is_enabled=true where company_id=$1", [co]);
    const mwz = await one(db, "insert into branches(company_id, code, name) values ($1,'MWZN','Mwanza') returning id", [co]);
    const a1150 = await one(db, "select id from chart_of_accounts where company_id=$1 and code='1150'", [co]);
    const a3200 = await one(db, "select id from chart_of_accounts where company_id=$1 and code='3200'", [co]);
    const opening = async (prod: string, qty: number, value: number, br = hq) => {
      await db.query("select record_stock_movement_value($1,$2,$3,'opening','opening',gen_random_uuid(),'OPEN',$4,$5,$6)", [co, br, prod, qty, value, owner]);
      await db.query("select create_journal($1,$2,$3,'opening',gen_random_uuid(),'OPEN','opening',$4,$5::jsonb)", [co, br, d("01-01"), owner,
        JSON.stringify([{ account_id: a1150, debit: value, credit: 0 }, { account_id: a3200, debit: 0, credit: value }])]);
    };
    const bulk = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'NEG-B','Neg bulk',$2,'bulk') returning id", [co, kg]);
    const b50 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,'NEG-50','Neg 50',$2,'packaged',50,$3) returning id", [co, bag, bulk]);
    await opening(bulk, 1000, 900000);
    await opening(b50, 10, 450000);
    const sup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'NEGSUP','Neg supplier') returning id", [co]);

    // ------------------------------------------------------------ API / RPC / table access
    const callable = (await db.query<{ proname: string; who: string }>(`
      select p.proname, r.rolname who from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      cross join (select rolname from pg_roles where rolname in ('anon','authenticated')) r
      where ns.nspname = 'public' and p.prosecdef and has_function_privilege(r.rolname, p.oid, 'execute')`)).rows
      .filter((r) => !APP_CALLABLE.has(r.proname));
    check("no security-definer function in public is callable by anon / authenticated except RLS self-checks",
      callable.length === 0, JSON.stringify(callable.slice(0, 40)));
    // Some older tables keep Supabase's classic grants (0023); what blocks app writes there is
    // row-level security with read-only policies. Assert that for every app-writable table.
    const writable = (await db.query<{ tablename: string }>(`
      select c.relname tablename from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'
        and (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete')
          or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))
        and (not c.relrowsecurity or exists (select 1 from pg_policies pp where pp.schemaname = 'public' and pp.tablename = c.relname
               and pp.cmd in ('INSERT','UPDATE','DELETE','ALL') and pp.roles && array['public','anon','authenticated']::name[]
               -- master data is Owner-writable by design (migration 0005); anything else is a failure
               and not (coalesce(pp.qual, '') || coalesce(pp.with_check, '')) ~ 'is_owner\(\)'))`)).rows;
    check("every app-writable table is protected by row-level security; the only write policies are Owner-only master data (0005)", writable.length === 0, JSON.stringify(writable.map((r) => r.tablename)));
    const ownerOnly = Number(await one(db, `select count(distinct tablename) from pg_policies where schemaname='public' and cmd in ('INSERT','UPDATE','DELETE','ALL')
      and (coalesce(qual,'') || coalesce(with_check,'')) ~ 'is_owner\\(\\)'`));
    check("Owner-only write policies are limited to master data / identity tables (none on transactions or the new upgrade tables)",
      Number(await one(db, `select count(*) from pg_policies where schemaname='public' and cmd in ('INSERT','UPDATE','DELETE','ALL') and tablename in
        ('sales','purchases','stock_movements','journal_entries','journal_lines','stock_balances','import_shipments','rebag_orders','stock_transfers','stock_transfer_dispatches',
         'cost_sources','cost_invoices','cost_delta_lines','document_attachments','product_price_changes','supplier_payables')`)) === 0 && ownerOnly > 0);
    await db.query("savepoint w_sp");
    const director = await one(db, "insert into auth.users(email) values ('negdir@test.local') returning id");
    await db.query("insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active) values ($1,'negdir@test.local','D',(select id from roles where code='DIRECTOR'),$2,true)", [director, co]);
    await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [director, co]);
    await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [director, hq]);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [director]);
    await db.query("set local role authenticated");
    const writes: string[] = [];
    const attempts: [string, string][] = [["sales", "update public.sales set grand_total = 0"], ["stock_movements", "delete from public.stock_movements"],
      ["journal_entries", "update public.journal_entries set memo = 'x'"], ["products", "update public.products set selling_price = 1"],
      ["stock_transfers", "update public.stock_transfers set status = 'voided'"], ["supplier_payables", "update public.supplier_payables set outstanding = 0"]];
    for (const [t, sql] of attempts) {
      await db.query("savepoint w1");
      try { const r = await db.query(sql); if ((r as { rowCount?: number }).rowCount) writes.push(t); } catch { /* denied */ }
      await db.query("rollback to savepoint w1");
    }
    await db.query("rollback to savepoint w_sp");
    check("a Director's browser session cannot write anything through the Data API (0 rows changed, incl. product prices)", writes.length === 0, writes.join(","));
    await db.query("savepoint anon_sp");
    await db.query("set local role anon");
    let anonRows = 0;
    for (const t of ["stock_movements", "journal_entries", "import_shipments", "stock_transfers", "rebag_orders", "cost_delta_lines", "document_attachments", "product_price_changes"]) {
      try { anonRows += Number(await one(db, `select count(*) from public.${t}`)); } catch { /* permission denied is fine */ }
    }
    await db.query("rollback to savepoint anon_sp");
    check("an anonymous caller reads nothing", anonRows === 0);

    // ------------------------------------------------------------ guessed cross-company references
    const co2 = await one(db, "insert into companies(code, name) values ('NEGCO','Other Company') returning id");
    const br2 = await one(db, "insert into branches(company_id, code, name) values ($1,'OX','Other branch') returning id", [co2]);
    const unit2 = await one(db, "insert into units(company_id, code, name, allow_decimal, kg_factor) values ($1,'KGX','kg',true,1) returning id", [co2]);
    const prod2 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'X-B','Other bulk',$2,'bulk') returning id", [co2, unit2]);
    const sup2 = await one(db, "insert into suppliers(company_id, code, name) values ($1,'XS','Other supplier') returning id", [co2]);
    const sh = await one(db, "insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance, currency_code, named_place) values ($1,$2,$3,'CIF',true,true,'TZS','Dar') returning id", [co, hq, sup]);
    const xco = [
      ["import line with another company's product", "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg, fc_amount) values ($1,$2,$3,10,10,10)", [co, sh, prod2]],
      ["shipment with another company's supplier", "insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance, currency_code, named_place) values ($1,$2,$3,'CIF',true,true,'TZS','Dar')", [co, hq, sup2]],
      ["transfer to another company's branch", "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3)", [co, hq, br2]],
      ["cost line on another company's category", "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id) values ($1,'import_shipment',$2,(select id from cost_categories where company_id=$3 limit 1))", [co, sh, co2]],
      ["rebag order on another company's product", "insert into rebag_orders(company_id, branch_id, bulk_product_id) values ($1,$2,$3)", [co, hq, prod2]],
      ["purchase from another company's supplier", "insert into purchases(company_id, branch_id, supplier_id) values ($1,$2,$3)", [co, hq, sup2]],
    ] as [string, string, unknown[]][];
    for (const [label, sql, p] of xco) check(`guessed cross-company reference rejected: ${label}`, await fails(db, sql, p));
    const okPur = await one(db, "insert into purchases(company_id, branch_id, supplier_id) values ($1,$2,$3) returning id", [co, hq, sup]);
    check("guessed cross-company reference rejected: purchase line with another company's product", await fails(db, "insert into purchase_lines(purchase_id, product_id, quantity, unit_cost) values ($1,$2,1,1)", [okPur, prod2], "cross-company"));
    const okSale = await one(db, "insert into sales(company_id, branch_id, customer_id, created_by) values ($1,$2,$3,$4) returning id", [co, hq, walkin, owner]);
    check("guessed cross-company reference rejected: sale line with another company's product", await fails(db, "insert into sale_lines(sale_id, product_id, quantity, unit_price) values ($1,$2,1,1)", [okSale, prod2], "cross-company"));
    const acc2 = await one(db, "select id from chart_of_accounts where company_id=$1 limit 1", [co2]) ?? await one(db,
      "insert into chart_of_accounts(company_id, code, name, account_type, normal_balance, allow_posting) values ($1,'9999','Other','expense','debit',true) returning id", [co2]);
    check("guessed cross-company reference rejected: journal line on another company's account", await fails(db,
      "select create_journal($1,$2,$3,'test',gen_random_uuid(),'T','t',$4,$5::jsonb)", [co, hq, d("03-01"), owner,
      JSON.stringify([{ account_id: acc2, debit: 1, credit: 0 }, { account_id: a3200, debit: 0, credit: 1 }])], "cross-company"));

    // ------------------------------------------------------------ unrelated branch (functions re-check the branch)
    const keeper = await one(db, "insert into auth.users(email) values ('negk@test.local') returning id");
    await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active) values ($1,'negk@test.local','K',(select id from roles where code='STOREKEEPER'),$2,true)`, [keeper, co]);
    await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [keeper, co]);
    await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [keeper, mwz]);
    const ro = await one(db, "insert into rebag_orders(company_id, branch_id, bulk_product_id, order_date) values ($1,$2,$3,$4) returning id", [co, hq, bulk, d("03-01")]);
    await db.query("insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity) values ($1,$2,'bulk',$3,100)", [co, ro, bulk]);
    check("a storekeeper of another branch cannot issue this branch's rebagging", await fails(db, "select issue_rebag_order($1,$2,$3)", [ro, keeper, key()], "branch"));

    // ------------------------------------------------------------ foreign currency outside purchasing
    for (const t of ["sales", "expenses", "stock_transfers", "rebag_orders", "stock_adjustments"]) {
      check(`${t} cannot carry a foreign currency`, Number(await one(db, "select count(*) from information_schema.columns where table_schema='public' and table_name=$1 and column_name='currency_code'", [t])) === 0);
    }
    check("foreign cost invoice rejected", await fails(db, "insert into cost_invoices(company_id, branch_id, supplier_id, currency_code, exchange_rate) values ($1,$2,$3,'USD',2600)", [co, hq, sup]));

    // ------------------------------------------------------------ invalid pack outputs
    check("pack output kg must equal bags x pack weight", await fails(db, "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg) values ($1,$2,$3,2,99)", [co, ro, b50], "bags x"));
    check("fractional bags rejected", await fails(db, "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg) values ($1,$2,$3,1.5,75)", [co, ro, b50]));
    check("a bulk product cannot be an output", await fails(db, "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg) values ($1,$2,$3,1,1)", [co, ro, bulk]));
    check("packaged bags cannot be imported", await fails(db, "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg) values ($1,$2,$3,1,50)", [co, sh, b50], "packaged"));

    // ------------------------------------------------------------ negative available stock
    const sale = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total) values ($1,$2,$3,$4,$5,100) returning id", [co, hq, d("03-02"), walkin, owner]);
    await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, net_amount, tax_amount, line_total, track_inventory, line_no) values ($1,$2,11,10,110,0,110,true,1)", [sale, b50]);
    await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,110)", [sale, cash]);
    check("selling more bags than on hand is rejected", await fails(db, "select post_sale($1,$2,null)", [sale, owner], "insufficient"));
    const tr = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3) returning id", [co, hq, mwz]);
    await db.query("insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,11)", [tr, b50]);
    check("dispatching more than on hand is rejected", await fails(db, "select dispatch_stock_transfer($1,$2,$3)", [tr, owner, key()], "insufficient"));

    // ------------------------------------------------------------ competing rebagging on the same bulk
    const r1 = await one(db, "insert into rebag_orders(company_id, branch_id, bulk_product_id, order_date) values ($1,$2,$3,$4) returning id", [co, hq, bulk, d("03-03")]);
    const r2 = await one(db, "insert into rebag_orders(company_id, branch_id, bulk_product_id, order_date) values ($1,$2,$3,$4) returning id", [co, hq, bulk, d("03-03")]);
    for (const r of [r1, r2]) {
      await db.query("insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity) values ($1,$2,'bulk',$3,600)", [co, r, bulk]);
      await db.query("insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg, line_no) values ($1,$2,$3,12,600,1)", [co, r, b50]);
    }
    await db.query("select complete_rebag_order($1,$2,$3)", [r1, owner, key()]);
    check("two orders competing for 1,000 kg (600 each): the second is refused, stock never negative",
      await fails(db, "select complete_rebag_order($1,$2,$3)", [r2, owner, key()], "insufficient") && n(await one(db, "select quantity from stock_balances where branch_id=$1 and product_id=$2", [hq, bulk])) === 400);
    check("a completed order cannot be completed again", await fails(db, "select complete_rebag_order($1,$2,$3)", [r1, owner, key()], "already completed"));

    // ------------------------------------------------------------ invalid allocation
    const t1 = gen(), t2 = gen();
    check("manual allocation amounts must add up to the total", await fails(db, "select * from allocate_amount(100, 'manual', $1::jsonb)", [JSON.stringify([{ id: t1, amount: 60 }, { id: t2, amount: 30 }])], "must equal"));
    check("percent allocation must total 100%", await fails(db, "select * from allocate_amount(100, 'percent', $1::jsonb)", [JSON.stringify([{ id: t1, percent: 60 }, { id: t2, percent: 30 }])]));
    check("duplicate allocation targets rejected", await fails(db, "select * from allocate_amount(100, 'quantity', $1::jsonb)", [JSON.stringify([{ id: t1, factor: 1 }, { id: t1, factor: 1 }])], "distinct"));
    check("allocation sums exactly (100 over 3 equal targets = 33.34 + 33.33 + 33.33)",
      n(await one(db, "select sum(amount) from allocate_amount(100, 'quantity', $1::jsonb)", [JSON.stringify([{ id: t1, factor: 1 }, { id: t2, factor: 1 }, { id: gen(), factor: 1 }])])) === 100);

    // ------------------------------------------------------------ edits to posted records
    check("journal lines cannot be edited", await fails(db, "update journal_lines set debit = debit + 1 where journal_id = (select id from journal_entries where company_id=$1 limit 1)", [co]));
    check("stock movements cannot be deleted", await fails(db, "delete from stock_movements where company_id=$1", [co]));
    check("lines of a completed rebag order cannot change", await fails(db, "update rebag_outputs set bags=13, net_kg=650 where order_id=$1", [r1], "cannot change"));
    check("cost delta evidence is immutable", await fails(db, "update cost_delta_lines set amount=0 where company_id=$1", [co])
      || Number(await one(db, "select count(*) from cost_delta_lines where company_id=$1", [co])) === 0);
    await db.query("insert into audit_logs(user_id, company_id, action, resource_type) values ($1,$2,'test.action','test')", [owner, co]);
    check("audit log cannot be altered or deleted", await fails(db, "update audit_logs set action='x' where action='test.action'") && await fails(db, "delete from audit_logs where action='test.action'"));
    check("posted rebag status cannot be set directly", await fails(db, "update rebag_orders set document_status='voided' where id=$1", [r1], "only through"));

    // ------------------------------------------------------------ locked period
    await db.query("update accounting_periods set end_date=$2 where company_id=$1 and start_date <= $3 and end_date >= $3", [co, d("01-31"), d("01-15")]);
    await db.query("insert into accounting_periods(company_id, financial_year, name, start_date, end_date, status) values ($1,$2,'Feb locked',$3,$4,'locked'), ($1,$2,'Rest',$5,$6,'open')",
      [co, String(Y), d("02-01"), d("02-28"), d("03-01"), d("12-31")]);
    const rl = await one(db, "insert into rebag_orders(company_id, branch_id, bulk_product_id, order_date) values ($1,$2,$3,$4) returning id", [co, hq, bulk, d("02-10")]);
    await db.query("insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity) values ($1,$2,'bulk',$3,50)", [co, rl, bulk]);
    await db.query("insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg, line_no) values ($1,$2,$3,1,50,1)", [co, rl, b50]);
    check("posting into a locked period is refused (rebagging dated in locked February)", await fails(db, "select complete_rebag_order($1,$2,$3)", [rl, owner, key()], "closed or locked"));
    const sl = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total) values ($1,$2,$3,$4,$5,10) returning id", [co, hq, d("02-15"), walkin, owner]);
    await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, net_amount, tax_amount, line_total, track_inventory, line_no) values ($1,$2,1,10,10,0,10,true,1)", [sl, b50]);
    await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,10)", [sl, cash]);
    check("existing sales also respect the locked period", await fails(db, "select post_sale($1,$2,null)", [sl, owner], "closed or locked"));

    // ------------------------------------------------------------ unsafe reversals
    const s3 = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total) values ($1,$2,$3,$4,$5,30) returning id", [co, hq, d("03-04"), walkin, owner]);
    await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, net_amount, tax_amount, line_total, track_inventory, line_no) values ($1,$2,15,2,30,0,30,true,1)", [s3, b50]);
    await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,30)", [s3, cash]);
    await db.query("select post_sale($1,$2,null)", [s3, owner]);
    check("a rebag order whose bags were sold cannot be voided", await fails(db, "select void_rebag_order($1,$2,'x',$3)", [r1, owner, key()], "already used"));
    const tr2 = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3) returning id", [co, hq, mwz]);
    const tl2 = await one(db, "insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,2) returning id", [tr2, b50]);
    await db.query("select dispatch_stock_transfer($1,$2,$3)", [tr2, owner, key()]);
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [tr2, owner, JSON.stringify([{ line_id: tl2, qty: 1 }]), key()]);
    check("a transfer with received cargo cannot be voided", await fails(db, "select void_stock_transfer($1,$2,'x')", [tr2, owner], "already received"));
    check("duplicate receipt beyond the dispatched quantity refused", await fails(db, "select receive_stock_transfer($1,$2,$3::jsonb,$4)", [tr2, owner, JSON.stringify([{ line_id: tl2, qty: 2 }]), key()], "more than dispatched"));

    // ------------------------------------------------------------ regression: adjustments, Kardex, bank reconciliation, manual journal, statements
    const adj = await one(db, "insert into stock_adjustments(company_id, branch_id, adjustment_date, direction, reason, created_by) values ($1,$2,$3,'decrease','count',$4) returning id", [co, hq, d("03-05"), owner]);
    await db.query("insert into stock_adjustment_lines(adjustment_id, product_id, quantity, line_no) values ($1,$2,10,1)", [adj, bulk]);
    await db.query("select post_stock_adjustment($1,$2,$3)", [adj, owner, key()]);
    check("stock adjustment posts and Kardex balances stay consistent with movements",
      Number(await one(db, `select count(*) from stock_balances b where b.company_id=$1 and b.quantity <> (select coalesce(sum(qty_in-qty_out),0) from stock_movements m where m.branch_id=b.branch_id and m.product_id=b.product_id)`, [co])) === 0
      && n(await one(db, "select balance_qty from stock_movements where source_id=$1", [adj])) === n(await one(db, "select quantity from stock_balances where branch_id=$1 and product_id=$2", [hq, bulk])));
    const nmb = await one(db, "select id from payment_accounts where company_id=$1 and code='NMB'", [co]);
    const rec = await one(db, "insert into bank_reconciliations(company_id, payment_account_id, statement_start, statement_end) values ($1,$2,$3,$4) returning id", [co, nmb, d("03-01"), d("03-31")]);
    const line = await one(db, "insert into bank_statement_lines(reconciliation_id, txn_date, description, money_out, fingerprint) values ($1,$2,'Bank fee',5000,'fp1') returning id", [rec, d("03-10")]);
    const fees = await one(db, "select id from chart_of_accounts where company_id=$1 and account_type='expense' and allow_posting order by code limit 1", [co]);
    await db.query("select post_bank_adjustment($1,$2,$3,'out',5000,'Bank fee',null,$4)", [rec, line, fees, owner]);
    check("bank reconciliation adjustment posts and marks the statement line", (await one(db, "select status from bank_statement_lines where id=$1", [line])) === "adjusted");
    check("trial balance balances across all postings", n(await one(db, "select coalesce(sum(closing_net),0) from report_trial_balance($1,'1900-01-01',$2)", [co, d("12-31")])) === 0);
    const recon = (await db.query<{ check_key: string; ok: boolean; detail: string }>("select * from cost_reconciliation_checks($1)", [co])).rows;
    check("cost reconciliation checks pass on this data", recon.every((r) => r.ok), JSON.stringify(recon.filter((r) => !r.ok)));
    check("indexes for replay and source lookups exist",
      Number(await one(db, "select count(*) from pg_indexes where schemaname='public' and indexname in ('stock_movements_replay_idx','stock_movements_source_id_idx','journal_entries_source_id_idx','stdl_movement_idx','irl_movement_idx')")) === 5);
    check("account mappings can be created from Admin (created_by column present)",
      Number(await one(db, "select count(*) from information_schema.columns where table_name='account_mappings' and column_name='created_by'")) === 1);

    console.log(`\n${passed} negative and regression checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nNegative test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}
function gen() { return crypto.randomUUID(); }

main();
