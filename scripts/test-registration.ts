/** Unit tests for vehicle registration matching (recent-use warning on stock transfers). */
import { normaliseRegistration, matchRecentTrucks, type TripRecord } from "../src/lib/transfers/registration";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.error(`  FAIL ${name} ${detail}`); }
}

// Formatting variants all normalise to T360AWB.
const variants = ["T360AWB", "T. 360 AWB", "T 360AWB", "t-360-awb", "T 360 AWB", "T\t360 AWB", "T/360_AWB", " t.360.awb "];
for (const v of variants) check(`"${v.replace(/ /g, "<nbsp>").replace(/\t/g, "<tab>")}" -> T360AWB`, normaliseRegistration(v) === "T360AWB", normaliseRegistration(v));
for (const v of ["T. 760DWG", "T 760 DWG", "T. T 760 DWG", "T T. 760DWG", "t.760.dwg"]) check(`"${v}" -> T760DWG`, normaliseRegistration(v) === "T760DWG", normaliseRegistration(v));
check("only a doubled T on a Tanzanian plate is collapsed (TT760DWG -> T760DWG; T760TTT stays)", normaliseRegistration("TT760DWG") === "T760DWG" && normaliseRegistration("T760TTT") === "T760TTT");
const regional: [string, string][] = [["UAA 123A", "UAA123A"], ["UBH-456B", "UBH456B"], ["KBZ 123A", "KBZ123A"], ["KCA. 987 X", "KCA987X"], ["RAB 123 A", "RAB123A"],
  ["ABC 1234", "ABC1234"], ["AEF-1234", "AEF1234"], ["BT 1234", "BT1234"], ["MZ. 123", "MZ123"], ["AAA-123-MC", "AAA123MC"], ["TT 1234", "TT1234"], ["TTA 123B", "TTA123B"]];
for (const [v, out] of regional) check(`"${v}" -> ${out} (letters and digits kept)`, normaliseRegistration(v) === out, normaliseRegistration(v));
check("different letters stay different (T360AWB vs T360AWE)", normaliseRegistration("T360AWB") !== normaliseRegistration("T360AWE"));
check("different digits stay different (T360AWB vs T361AWB)", normaliseRegistration("T360AWB") !== normaliseRegistration("T361AWB"));
check("empty and punctuation-only values normalise to empty", normaliseRegistration("") === "" && normaliseRegistration(" .-/ ") === "" && normaliseRegistration(null) === "");

// Existing records as they were saved, in their original formats (before this change).
const rec = (no: string, vehicle: string | null, trailer: string | null): TripRecord =>
  ({ transferNumber: no, tripNo: 1, date: "2026-11-08", vehicle, trailer, transferId: no, status: "dispatched" });
const existing = [
  rec("STR-26-00000001", "T. 360 AWB", "T 111 ZZZ"),
  rec("STR-26-00000002", "T 360AWB", null),
  rec("STR-26-00000003", "t-360-awb", ""),
  rec("STR-26-00000004", "T360AWE", null),
  rec("STR-26-00000005", "T 999 XYZ", "T360AWB"),
  rec("STR-26-00000006", "", ""),
];
for (const v of variants) {
  const m = matchRecentTrucks({ vehicle: v }, existing).map((x) => x.transferNumber).sort().join(",");
  check(`new truck "${v.replace(/ /g, "<nbsp>").replace(/\t/g, "<tab>")}" matches the four earlier T360AWB trips (incl. one as trailer)`,
    m === "STR-26-00000001,STR-26-00000002,STR-26-00000003,STR-26-00000005", m);
}
check("T360AWE does not match T360AWB records", matchRecentTrucks({ vehicle: "T360AWE" }, existing).map((x) => x.transferNumber).join(",") === "STR-26-00000004");
check("an empty entry matches nothing (no warning)", matchRecentTrucks({ vehicle: "  ", trailer: "-" }, existing).length === 0);
check("a record with empty registrations never matches", !matchRecentTrucks({ vehicle: "T360AWB" }, existing).some((x) => x.transferNumber === "STR-26-00000006"));
const why = matchRecentTrucks({ vehicle: "t-360-awb" }, [existing[0]])[0]?.reasons[0] ?? "";
check("the reason shows both registrations as entered", why.includes("t-360-awb") && why.includes('"T. 360 AWB"'), why);
const trl = matchRecentTrucks({ vehicle: "T 1 AAA", trailer: "T 111-ZZZ" }, existing);
check("a trailer is checked too", trl.length === 1 && trl[0].transferNumber === "STR-26-00000001" && trl[0].reasons[0].startsWith("Trailer"));

console.log(`\n${passed} registration checks passed.`);
if (failed) { console.error(`${failed} failed.`); process.exit(1); }
