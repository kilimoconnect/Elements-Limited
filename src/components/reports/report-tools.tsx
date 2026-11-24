"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Printer, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PeriodFilter({ start, end }: { start: string; end: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [loading, startLoading] = React.useTransition();
  const [s, setS] = React.useState(start);
  const [e, setE] = React.useState(end);
  function apply() {
    const p = new URLSearchParams(sp.toString());
    p.set("start", s); p.set("end", e);
    startLoading(() => router.push(`${pathname}?${p.toString()}`));
  }
  return (
    <div className="flex flex-wrap items-end gap-2 print-hide">
      <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" className="h-8 w-40" value={s} onChange={(ev) => setS(ev.target.value)} /></div>
      <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" className="h-8 w-40" value={e} onChange={(ev) => setE(ev.target.value)} /></div>
      <Button size="sm" onClick={apply} disabled={loading}>{loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</> : "Apply"}</Button>
    </div>
  );
}

export function AsOfFilter({ asOf }: { asOf: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [loading, startLoading] = React.useTransition();
  const [d, setD] = React.useState(asOf);
  function apply() {
    const p = new URLSearchParams(sp.toString());
    p.set("asOf", d);
    startLoading(() => router.push(`${pathname}?${p.toString()}`));
  }
  return (
    <div className="flex items-end gap-2 print-hide">
      <div className="space-y-1"><Label className="text-xs">As of</Label><Input type="date" className="h-8 w-40" value={d} onChange={(ev) => setD(ev.target.value)} /></div>
      <Button size="sm" onClick={apply} disabled={loading}>{loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</> : "Apply"}</Button>
    </div>
  );
}

export function AccountPicker({ accounts, value }: { accounts: { id: string; code: string; name: string }[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [loading, startLoading] = React.useTransition();
  function onChange(id: string) {
    const p = new URLSearchParams(sp.toString());
    p.set("account", id);
    startLoading(() => router.push(`${pathname}?${p.toString()}`));
  }
  return (
    <span className="inline-flex items-center gap-1.5 print-hide">
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={loading}
        className="h-8 rounded-md border border-input bg-card px-2 text-sm">
        <option value="">Select account…</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
      </select>
      {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />}
    </span>
  );
}

export function ParamSelect({ param, value, options, placeholder }: { param: string; value: string; options: { id: string; label: string }[]; placeholder: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [loading, startLoading] = React.useTransition();
  function onChange(id: string) {
    const p = new URLSearchParams(sp.toString());
    p.set(param, id);
    startLoading(() => router.push(`${pathname}?${p.toString()}`));
  }
  return (
    <span className="inline-flex items-center gap-1.5 print-hide">
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={loading}
        className="h-8 rounded-md border border-input bg-card px-2 text-sm">
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />}
    </span>
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

/**
 * Excel and PDF downloads of a report, with the filters currently in the page's URL.
 * `api` is the export route (it reads ?format=xlsx|pdf and the same filters as the page).
 */
export function ExportButtons({ api }: { api: string }) {
  const sp = useSearchParams();
  const [busy, setBusy] = React.useState<"" | "xlsx" | "pdf">("");
  const link = (format: "xlsx" | "pdf") => { const p = new URLSearchParams(sp.toString()); p.delete("page"); p.set("format", format); return `${api}?${p.toString()}`; };
  const go = (format: "xlsx" | "pdf") => {
    setBusy(format);
    window.location.assign(link(format));
    window.setTimeout(() => setBusy(""), 4000);
  };
  return (
    <div className="flex gap-2 print-hide">
      <Button variant="outline" size="sm" onClick={() => go("xlsx")} disabled={!!busy}>
        {busy === "xlsx" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Excel
      </Button>
      <Button variant="outline" size="sm" onClick={() => go("pdf")} disabled={!!busy}>
        {busy === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} PDF
      </Button>
    </div>
  );
}
