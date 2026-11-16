"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Download, FileCheck2, Loader2, Truck, Upload } from "lucide-react";
import { checkTransferImport, createImportedOrders, type CheckResult, type CreateResult } from "@/lib/transfers/import-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatQuantity } from "@/lib/format";

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-req`);

export function ImportForm({ branches, defaultBranch }: { branches: { id: string; name: string }[]; defaultBranch: string }) {
  const [source, setSource] = React.useState(defaultBranch);
  const [file, setFile] = React.useState<File | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [result, setResult] = React.useState<CheckResult | null>(null);
  const [done, setDone] = React.useState<CreateResult | null>(null);
  const [requestId, setRequestId] = React.useState(rid);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const reset = () => { setResult(null); setDone(null); setRequestId(rid()); };
  async function check() {
    if (!file) return;
    setChecking(true); reset();
    const fd = new FormData();
    fd.set("file", file); fd.set("sourceBranchId", source);
    const r = await checkTransferImport(fd);
    setChecking(false);
    setResult(r);
    if (!r.ok) toast.error(r.error);
  }
  async function create() {
    if (!result?.ok || result.check.errors.length) return;
    setCreating(true);
    const r = await createImportedOrders(source, result.check.orders, requestId);
    setCreating(false);
    setDone(r);
    if (r.ok) toast.success(`${r.created.length} transfer order(s) created.`);
    else toast.error(r.error ?? `${r.failed.length} truck(s) could not be created.`);
  }

  const c = result?.ok ? result.check : null;
  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-4 p-5">
        <h3 className="font-semibold">1. Sending branch and template</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-72 space-y-1.5"><Label>From branch</Label>
            <Select value={source} onValueChange={(v) => { setSource(v); reset(); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button variant="outline" asChild><a href={`/api/transfers/import-template?from=${source}`}><Download className="h-4 w-4" /> Download Excel template</a></Button>
        </div>
        <p className="text-xs text-muted-foreground">The template lists the branches and the products this branch holds as drop-downs. Columns: To branch, Truck registration, Trailer registration, Driver name, Driver phone, Driver licence, Transporter, Transporter contact, Product, Quantity. A CSV with the same columns also works.</p>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-5">
        <h3 className="font-semibold">2. Upload and check</h3>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={inputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }} />
          <Button variant="outline" onClick={() => inputRef.current?.click()}><Upload className="h-4 w-4" /> Choose file</Button>
          <span className="text-sm">{file ? file.name : "No file chosen"}</span>
          <Button onClick={check} disabled={!file || checking}>{checking ? <><Loader2 className="h-4 w-4 animate-spin" /> Checking…</> : <><FileCheck2 className="h-4 w-4" /> Check file</>}</Button>
        </div>
        {result && !result.ok && <p className="text-sm text-destructive">{result.error}</p>}
      </CardContent></Card>

      {c && (
        <Card><CardContent className="space-y-3 p-5">
          <h3 className="font-semibold">3. Review and create</h3>
          <p className="text-sm">{c.orders.length} truck(s), {formatQuantity(result!.ok ? result!.totals.quantity : 0)} in total.
            {c.errors.length ? <span className="text-destructive"> Fix {c.errors.length} problem(s) in the file and check it again; nothing is created until the file is clean.</span> : " No problems found."}</p>
          {c.errors.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              {c.errors.map((e, i) => <p key={i}><span className="font-medium">Row {e.row}:</span> {e.message}</p>)}
            </div>
          )}
          {c.warnings.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/30">
              {c.warnings.map((w, i) => <p key={i}><span className="font-medium">Row {w.row}:</span> {w.message}</p>)}
            </div>
          )}
          {c.orders.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader><TableRow><TableHead>Rows</TableHead><TableHead>To</TableHead><TableHead>Truck / trailer</TableHead><TableHead>Driver</TableHead><TableHead>Cargo</TableHead><TableHead className="text-right">Quantity</TableHead></TableRow></TableHeader>
                <TableBody>{c.orders.map((o) => (
                  <TableRow key={o.key}>
                    <TableCell className="text-xs text-muted-foreground">{o.rows.join(", ")}</TableCell>
                    <TableCell className="text-sm">{o.toBranch}</TableCell>
                    <TableCell className="text-sm font-medium">{o.vehicle}{o.trailer && <span className="block text-xs font-normal text-muted-foreground">Trailer {o.trailer}</span>}</TableCell>
                    <TableCell className="text-xs">{o.driverName || "—"}{o.driverPhone && <span className="block text-muted-foreground">{o.driverPhone}</span>}</TableCell>
                    <TableCell className="text-xs">{o.lines.map((l, i) => <span key={i} className="block">{l.product}</span>)}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{o.lines.map((l, i) => <span key={i} className="block">{formatQuantity(l.qty)}</span>)}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          )}
          {!done && (
            <Button onClick={create} disabled={creating || c.errors.length > 0 || c.orders.length === 0}>
              {creating ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating {c.orders.length} order(s)…</> : <><Truck className="h-4 w-4" /> Create {c.orders.length} transfer order(s)</>}
            </Button>
          )}
          {done && (
            <div className="space-y-2 text-sm">
              {done.created.length > 0 && <p className="font-medium text-green-700 dark:text-green-400">{done.created.length} transfer order(s) created. They now wait for the store keeper to confirm loading.</p>}
              {done.failed.map((f, i) => <p key={i} className="text-destructive">{f.vehicle} → {f.toBranch}: {f.error}</p>)}
              {done.error && <p className="text-destructive">{done.error}</p>}
              <div className="flex flex-wrap gap-2">
                <Button asChild><Link href="/inventory/transfers">Open Transfer orders</Link></Button>
                {done.failed.length > 0 && <Button variant="outline" onClick={create} disabled={creating}>Try the failed trucks again</Button>}
              </div>
            </div>
          )}
        </CardContent></Card>
      )}
    </div>
  );
}
