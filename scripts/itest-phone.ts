/**
 * Phone numbers saved in one standard form (migration 0062), checked against
 * the TypeScript rules. One transaction, ROLLED BACK. PGlite only.
 */
import { createDbClient } from "./db";
import { normalisePhone } from "../src/lib/phone";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-phone runs only against the PGlite test database (npm run test:db).");
  process.exit(1);
}
let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); } else { console.error(`  FAIL ${name} ${detail}`); process.exitCode = 1; }
}

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const inputs = ["0687 322 677", "0687-322-677", "+255 687 322 677", "255687322677", "+255 0687 322 677", "00255687322677", "687 322 677",
      "+254 712 345 678", "00254712345678", "254712345678", "+256 772 123456", "+255222923923 ", "0687 322 677 / 0712 345 678",
      "0687322677, +254712345678", "0687322677 or 0712345678", "", "  ", "none", "(0687) 322677"];
    for (const v of inputs) {
      const { rows } = await db.query("select public.normalise_phone($1) as p", [v]);
      check(`database matches the app for "${v}"`, rows[0].p === normalisePhone(v), `db "${rows[0].p}" app "${normalisePhone(v)}"`);
    }
    const nul = (await db.query("select public.normalise_phone(null) as p")).rows[0].p;
    check("null stays null", nul === null);

    const co = (await db.query("select id from companies where code='ELEMENTS'")).rows[0].id;
    const c = (await db.query("insert into customers(company_id, code, name, phone) values ($1,'PH-1','Phone test','+255 687 322 677') returning phone", [co])).rows[0].phone;
    check("a new customer's phone is corrected on save", c === "0687322677", c);
    const u = (await db.query("update customers set phone='0712.345.678' where company_id=$1 and code='PH-1' returning phone", [co])).rows[0].phone;
    check("an edited customer's phone is corrected on save", u === "0712345678", u);
    const s = (await db.query("insert into suppliers(company_id, code, name, phone) values ($1,'PH-S','Phone supplier','254 712 345 678') returning phone", [co])).rows[0].phone;
    check("a supplier's foreign phone keeps its country code", s === "+254712345678", s);
    const trg = (await db.query("select count(*)::int n from pg_trigger where tgname='trg_normalise_phone'")).rows[0].n;
    check("phone triggers are on all 12 tables", trg === 12, String(trg));
  } finally {
    await db.query("rollback");
    await db.end();
  }
  console.log(`\nphone: ${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
