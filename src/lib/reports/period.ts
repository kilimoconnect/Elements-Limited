import { todayISO } from "@/lib/format";

export type SP = Record<string, string | string[] | undefined>;

function today(): string {
  return todayISO();
}
function yearStart(): string {
  return `${today().slice(0, 4)}-01-01`;
}

export function resolvePeriod(sp: SP): { start: string; end: string } {
  const start = typeof sp.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.start) ? sp.start : yearStart();
  const end = typeof sp.end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.end) ? sp.end : today();
  return { start, end };
}

export function resolveAsOf(sp: SP): string {
  return typeof sp.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : today();
}
