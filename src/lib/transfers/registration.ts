/**
 * Vehicle registrations compared without their formatting: "T 360 AWB",
 * "T. 360 AWB", "t-360-awb" and "T360AWB" are the same truck. Only
 * formatting is ignored (case, spaces of any kind, punctuation and
 * separators); different letters or digits stay different. Registrations
 * are saved in this form (database trigger, migration 0059).
 */
export function normaliseRegistration(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    // Works for plates of any country (letters and digits kept). Only a doubled T on a
    // Tanzanian plate (T + 3 digits + 3 letters, "T. T 760 DWG") is collapsed.
    .replace(/^T+([0-9]{3}[A-Z]{3})$/, "T$1");
}

export interface TripRecord {
  transferNumber: string | null; tripNo: number | null; date: string;
  vehicle: string | null; trailer: string | null; transferId: string; status: string;
}
export interface RecentMatch extends TripRecord { reasons: string[] }

/**
 * Previous trips that used the same truck or trailer (as truck or trailer).
 * Empty normalised values never match.
 */
export function matchRecentTrucks(entry: { vehicle?: string | null; trailer?: string | null }, records: TripRecord[]): RecentMatch[] {
  const mine = [
    { label: "Truck", raw: entry.vehicle ?? "", key: normaliseRegistration(entry.vehicle) },
    { label: "Trailer", raw: entry.trailer ?? "", key: normaliseRegistration(entry.trailer) },
  ].filter((x) => x.key);
  if (!mine.length) return [];
  const out: RecentMatch[] = [];
  for (const r of records) {
    const theirs = [
      { label: "truck", raw: r.vehicle ?? "", key: normaliseRegistration(r.vehicle) },
      { label: "trailer", raw: r.trailer ?? "", key: normaliseRegistration(r.trailer) },
    ].filter((x) => x.key);
    const reasons: string[] = [];
    for (const m of mine) for (const t of theirs) {
      if (m.key === t.key) reasons.push(`${m.label} ${m.raw.trim()} is the same registration as the ${t.label} entered as "${t.raw.trim()}"`);
    }
    if (reasons.length) out.push({ ...r, reasons });
  }
  return out;
}
