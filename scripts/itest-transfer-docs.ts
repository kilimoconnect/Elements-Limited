/**
 * Transfer delivery note numbers and Head Office GRNs (migration 0038) on
 * the final schema. One transaction, ROLLED BACK. PGlite only.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-transfer-docs runs only against the PGlite test database (npm run test:db).");
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
    const br = await one(db, "insert into branches(company_id, code, name) values ($1,'DOD','Dodoma') returning id", [co]);

    // Two suppliers; product A bought from S1 then S2 (latest = S2), product B from S1, product C never bought.
    const s1 = await one(db, "insert into suppliers(company_id, code, name, contact_person, phone, email, tin, address) values ($1,'S1','Agro Supplies Ltd','Asha','+255 711','sales@agro.tz','111-222-333','Arusha') returning id", [co]);
    const s2 = await one(db, "insert into suppliers(company_id, code, name) values ($1,'S2','Fert Imports Ltd') returning id", [co]);
    const prod = (sku: string) => one(db, "insert into products(company_id, sku, name, base_unit_id, net_weight_kg) values ($1,$2,$3,$4,50) returning id", [co, sku, `Product ${sku}`, bag]);
    const A = await prod("TD-A"), B = await prod("TD-B"), C = await prod("TD-C");
    const buy = async (sup: string, product: string, date: string, inv: string) => {
      const p = await one(db, "insert into purchases(company_id, branch_id, supplier_id, document_date, due_date, supplier_invoice_number, created_by) values ($1,$2,$3,$4,$4,$5,$6) returning id", [co, hq, sup, date, inv, owner]);
      await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, tax_rate, is_recoverable, track_inventory, line_no) values ($1,$2,100,1000,0,true,true,1)", [p, product]);
      await db.query("select post_purchase($1,$2,null)", [p, owner]);
    };
    const Y = new Date().getFullYear();
    await buy(s1, A, `${Y}-01-05`, "TD-1");
    await buy(s2, A, `${Y}-01-20`, "TD-2");
    await buy(s1, B, `${Y}-01-10`, "TD-3");
    await db.query("select record_stock_movement($1,$2,$3,'opening','opening',gen_random_uuid(),'OPEN',10,0,1000,$4)", [co, hq, C, owner]);

    // A transfer HQ -> Dodoma with one draft trip.
    const t = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id, destination_location) values ($1,$2,$3,'Bay 1') returning id", [co, hq, br]);
    const line = (p: string, q: number) => one(db, "insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,$3) returning id", [t, p, q]);
    const lA = await line(A, 20), lB = await line(B, 10), lC = await line(C, 5);
    const trip = async (no: number) => {
      const id = await one(db, `insert into stock_transfer_dispatches(company_id, transfer_id, trip_no, dispatch_date, driver_name, driver_phone, vehicle_registration, trailer_registration, transporter_name)
        values ($1,$2,$3,current_date,'Juma Ali','+255 700 111','T 123 ABC','T 456 DEF','Fast Haulage') returning id`, [co, t, no]);
      for (const l of [lA, lB, lC]) await db.query("insert into stock_transfer_dispatch_lines(company_id, dispatch_id, transfer_line_id, qty) values ($1,$2,$3,1)", [co, id, l]);
      return id;
    };
    const t1 = await trip(1);

    // ------------------------------------------------------------ delivery note numbers
    const v1 = (await db.query<{ version_id: string; version_no: number; is_new: boolean }>("select * from issue_delivery_note($1,$2)", [t1, owner])).rows[0];
    const dn1 = await one(db, "select delivery_note_number from stock_transfer_dispatches where id=$1", [t1]);
    const YY = String(new Date().getFullYear()).slice(2);
    check("the first delivery note gets an auto number (DN-YY-NNNNNNNN)", new RegExp(`^DN-${YY}-\\d{8}$`).test(dn1 ?? ""), String(dn1));
    check("the delivery note shows its number, destination, truck and driver",
      await one(db, "select snapshot->>'delivery_note_number' from document_versions where id=$1", [v1.version_id]) === dn1
      && await one(db, "select snapshot->'receiver'->>'name' from document_versions where id=$1", [v1.version_id]) === "Dodoma"
      && await one(db, "select snapshot->'vehicle'->>'registration' from document_versions where id=$1", [v1.version_id]) === "T 123 ABC"
      && await one(db, "select snapshot->'driver'->>'name' from document_versions where id=$1", [v1.version_id]) === "Juma Ali");
    check("the delivery note carries no prices or supplier",
      !(await one<string>(db, "select snapshot::text from document_versions where id=$1", [v1.version_id])).match(/unit_cost|price|value|supplier/i));
    const v1b = (await db.query<{ is_new: boolean }>("select * from issue_delivery_note($1,$2)", [t1, owner])).rows[0];
    check("re-issuing keeps the same number and version", !v1b.is_new && await one(db, "select delivery_note_number from stock_transfer_dispatches where id=$1", [t1]) === dn1);
    await db.query("update stock_transfer_dispatches set driver_name='Peter Mushi' where id=$1", [t1]);
    await db.query("select * from issue_delivery_note($1,$2)", [t1, owner]);
    check("a changed driver makes a new version under the same number",
      Number(await one(db, "select max(version) from document_versions where owner_id=$1 and kind='delivery_note'", [t1])) === 2
      && await one(db, "select delivery_note_number from stock_transfer_dispatches where id=$1", [t1]) === dn1);
    const t2 = await trip(2);
    await db.query("select * from issue_delivery_note($1,$2)", [t2, owner]);
    const dn2 = await one(db, "select delivery_note_number from stock_transfer_dispatches where id=$1", [t2]);
    check("a second trip gets the next number", !!dn2 && dn2 !== dn1 && Number(dn2.slice(-8)) === Number(dn1.slice(-8)) + 1, `${dn1} ${dn2}`);

    // ------------------------------------------------------------ suppliers per line and GRN numbers
    const map = new Map((await db.query<{ transfer_line_id: string; supplier_id: string | null }>("select * from transfer_line_suppliers($1)", [t])).rows.map((r) => [r.transfer_line_id, r.supplier_id]));
    check("a product's supplier is its latest posted purchase (A → S2)", map.get(lA) === s2);
    check("B → S1", map.get(lB) === s1);
    check("a product never bought has no supplier", map.get(lC) === null);

    const g1 = await one(db, "select issue_transfer_grn($1,$2,$3)", [t, s1, owner]);
    const g2 = await one(db, "select issue_transfer_grn($1,$2,$3)", [t, s2, owner]);
    const g0 = await one(db, "select issue_transfer_grn($1,null,$2)", [t, owner]);
    const grnRe = new RegExp(`^GRN-${YY}-\\d{8}$`);
    check("each supplier gets its own GRN number (GRN-YY-NNNNNNNN)", grnRe.test(g1) && grnRe.test(g2) && new Set([g1, g2, g0]).size === 3, `${g1} ${g2} ${g0}`);
    check("downloading again keeps the same GRN number",
      await one(db, "select issue_transfer_grn($1,$2,$3)", [t, s1, owner]) === g1
      && await one(db, "select issue_transfer_grn($1,null,$2)", [t, owner]) === g0);
    check("a supplier of another company is refused",
      await (async () => {
        await db.query("savepoint sp");
        try { await db.query("select issue_transfer_grn($1,gen_random_uuid(),$2)", [t, owner]); await db.query("release savepoint sp"); return false; }
        catch { await db.query("rollback to savepoint sp"); return true; }
      })());

    // ------------------------------------------------------------ numbering in general
    const nx = (type: string) => one(db, "select next_document_number($1,$2,$3)", [co, hq, type]);
    check("every sequence uses eight digits and restarts yearly",
      Number(await one(db, "select count(*) from document_sequences where company_id=$1 and (number_length <> 8 or reset_frequency <> 'yearly')", [co])) === 0);
    check("transfers number as STR-YY-NNNNNNNN", new RegExp(`^STR-${YY}-\\d{8}$`).test(await nx("stock_transfer")));
    check("import receipts use IGR, not GRN", (await nx("import_receipt")).startsWith(`IGR-${YY}-`));
    await db.query("update document_sequences set period_key='00', current_number=41 where company_id=$1 and document_type='sales_invoice'", [co]);
    check("a new year starts the count again at 00000001", await nx("sales_invoice") === `INV-${YY}-00000001`);
    check("within the year the count continues", await nx("sales_invoice") === `INV-${YY}-00000002`);

    // ------------------------------------------------------------ access
    check("the new functions are service-role only",
      Number(await one(db, `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname in ('transfer_line_suppliers','issue_transfer_grn','issue_delivery_note','delivery_note_snapshot')
          and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`)) === 0);
    check("app users can read GRN numbers but not write them",
      await one<boolean>(db, "select has_table_privilege('authenticated','public.transfer_grns','select')") === true
      && await one<boolean>(db, "select has_table_privilege('authenticated','public.transfer_grns','insert')") === false);

    console.log(`\nTransfer delivery notes and GRNs: ${passed} checks passed.`);
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
