"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Printer, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PeriodFilter({ start, end }: { start: string; end: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [s, setS] = React.useState(start);
  const [e, setE] = React.useState(end);
  function apply() {
    const p = new URLSearchParams(sp.toString());
    p.set("start", s); p.set("end", e);
    router.push(`${pathname}?${p.toString()}`);
  }
  return (
    <div className="flex flex-wrap items-end gap-2 print-hide">
      <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" className="h-8 w-40" value={s} onChange={(ev) => setS(ev.target.value)} /></div>
      <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" className="h-8 w-40" value={e} onChange={(ev) => setE(ev.target.value)} /></div>
      <Button size="sm" onClick={apply}>Apply</Button>
    </div>
  );
}

export function AsOfFilter({ asOf }: { asOf: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [d, setD] = React.useState(asOf);
  function apply() {
    const p = new URLSearchParams(sp.toString());
    p.set("asOf", d);
    router.push(`${pathname}?${p.toString()}`);
  }
  return (
    <div className="flex items-end gap-2 print-hide">
      <div className="space-y-1"><Label className="text-xs">As of</Label><Input type="date" className="h-8 w-40" value={d} onChange={(ev) => setD(ev.target.value)} /></div>
      <Button size="sm" onClick={apply}>Apply</Button>
    </div>
  );
}

export function AccountPicker({ accounts, value }: { accounts: { id: string; code: string; name: string }[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  function onChange(id: string) {
    const p = new URLSearchParams(sp.toString());
    p.set("account", id);
    router.push(`${pathname}?${p.toString()}`);
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-input bg-card px-2 text-sm print-hide">
      <option value="">Select account…</option>
      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
    </select>
  );
}

export function ParamSelect({ param, value, options, placeholder }: { param: string; value: string; options: { id: string; label: string }[]; placeholder: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  function onChange(id: string) {
    const p = new URLSearchParams(sp.toString());
    p.set(param, id);
    router.push(`${pathname}?${p.toString()}`);
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-input bg-card px-2 text-sm print-hide">
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

export function PrintButton() {
  return (
    <Button variant="outline" size="sm" className="print-hide" onClick={() => window.print()}>
      <Printer className="h-4 w-4" /> Print
    </Button>
  );
}

export function ExportCsvButton({ filename, header, rows }: { filename: string; header: string[]; rows: (string | number)[][] }) {
  function download() {
    const esc = (v: string | number) => {
      const s = String(v ?? "");
      // Phone numbers and codes ("0687322677", "+254712345678", long references) stay text in
      // Excel, which would otherwise drop the leading 0 or round them.
      if (typeof v === "string" && (/^0\d+$/.test(s) || /^\+\d+$/.test(s) || /^\d{16,}$/.test(s))) return `="${s}"`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Button variant="outline" size="sm" className="print-hide" onClick={download}>
      <Download className="h-4 w-4" /> CSV
    </Button>
  );
}
