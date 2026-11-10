/** Unit tests for phone number correction. */
import { normalisePhone } from "../src/lib/phone";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.error(`  FAIL ${name} ${detail}`); }
}
const cases: [string, string][] = [
  ["0687 322 677", "0687322677"], ["0687-322-677", "0687322677"], ["0687.322.677", "0687322677"], ["(0687) 322677", "0687322677"],
  ["+255 687 322 677", "0687322677"], ["255687322677", "0687322677"], ["+255 0687 322 677", "0687322677"], ["00255687322677", "0687322677"],
  ["687 322 677", "0687322677"], ["0784272737", "0784272737"], ["+255 684 222 512", "0684222512"], ["+255222923923 ", "0222923923"],
  ["+254 712 345 678", "+254712345678"], ["00254712345678", "+254712345678"], ["254712345678", "+254712345678"],
  ["+256 772 123456", "+256772123456"], ["+250 788 123 456", "+250788123456"], ["+260 97 1234567", "+260971234567"],
  ["+263 77 123 4567", "+263771234567"], ["+265 99 123 4567", "+265991234567"], ["+258 84 123 4567", "+258841234567"],
  ["0687 322 677 / 0712 345 678", "0687322677 / 0712345678"], ["0687322677, +254712345678", "0687322677 / +254712345678"],
  ["", ""], ["  ", ""], ["none", ""],
];
for (const [v, out] of cases) check(`"${v}" -> "${out}"`, normalisePhone(v) === out, `got "${normalisePhone(v)}"`);
check("already-correct numbers are unchanged", ["0687322677", "+254712345678"].every((v) => normalisePhone(v) === v));
check("correcting twice gives the same result", cases.every(([v]) => normalisePhone(normalisePhone(v)) === normalisePhone(v)));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
