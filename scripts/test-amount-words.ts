/** Unit tests for amounts in words (commercial invoice). */
import { amountInWords, numberToWords } from "../src/lib/pdf/amount-words";
let passed = 0, failed = 0;
const check = (n: string, c: boolean, d = "") => { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.error(`  FAIL ${n} ${d}`); } };
const cases: [number, string][] = [
  [76560000, "Seventy-Six Million Five Hundred Sixty Thousand Tanzanian Shillings Only"],
  [1250.5, "One Thousand Two Hundred Fifty Tanzanian Shillings and Fifty Cents Only"],
  [9780210000, "Nine Billion Seven Hundred Eighty Million Two Hundred Ten Thousand Tanzanian Shillings Only"],
  [242100001.76, "Two Hundred Forty-Two Million One Hundred Thousand One Tanzanian Shillings and Seventy-Six Cents Only"],
  [0, "Zero Tanzanian Shillings Only"], [19, "Nineteen Tanzanian Shillings Only"], [100, "One Hundred Tanzanian Shillings Only"],
  [1000001, "One Million One Tanzanian Shillings Only"], [0.05, "Zero Tanzanian Shillings and Five Cents Only"],
];
for (const [v, w] of cases) check(`${v} -> ${w}`, amountInWords(v) === w, amountInWords(v));
check("numberToWords(45) = Forty-Five", numberToWords(45) === "Forty-Five");
console.log(`\n${passed} amount-in-words checks passed.`);
if (failed) process.exit(1);
