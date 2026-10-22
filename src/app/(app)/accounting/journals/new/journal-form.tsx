"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { saveManualJournalDraft, postManualJournal, type ManualJournalInput } from "@/lib/accounting/actions";
import { formatMoney, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface AccountOpt { id: string; code: string; name: string; is_control: boolean }
interface Line { key: string; account_id: string; debit: string; credit: string; description: string }
const nl = (): Line => ({ key: Math.random().toString(36).slice(2), account_id: "", debit: "", credit: "", description: "" });
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function ManualJournalForm({ accounts, canPost, canControl }: { accounts: AccountOpt[]; canPost: boolean; canControl: boolean }) {
  const router = useRouter();
  const [date, setDate] = React.useState(todayISO());
  const [reference, setReference] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>([nl(), nl()]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const accMap = new Map(accounts.map((a) => [a.id, a]));

  const td = round2(lines.reduce((s, l) => s + Number(l.debit || 0), 0));
  const tc = round2(lines.reduce((s, l) => s + Number(l.credit || 0), 0));
  const balanced = td === tc && td > 0;
  const hitsControl = lines.some((l) => l.account_id && accMap.get(l.account_id)?.is_control);

  async function submit(post: boolean) {
    setError(null);
    const input: ManualJournalInput = {
      journalDate: date, reference, description,
      lines: lines.filter((l) => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0))
        .map((l) => ({ account_id: l.account_id, debit: Number(l.debit || 0), credit: Number(l.credit || 0), description: l.description })),
    };
    if (input.lines.length < 2) { setError("A journal needs at least two lines."); return; }
    if (!balanced) { setError("Debits must equal credits."); return; }
    setPending(true);
    const res = await saveManualJournalDraft(input);
    if (!res.ok || !res.id) { setError(res.error ?? "Failed."); setPending(false); return; }
    if (post) { const pr = await postManualJournal(res.id); if (!pr.ok) { setError(pr.error ?? "Draft saved but posting failed."); setPending(false); return; } toast.success("Journal posted."); }
    else toast.success("Draft saved.");
    router.push(`/accounting/journals/${res.id}`);
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        <div className="space-y-1.5"><Label>Journal date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </CardContent></Card>

      <Card><CardContent className="p-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr><th className="px-2 py-2 text-left">Account</th><th className="px-2 py-2 text-left">Description</th><th className="px-2 py-2 text-right">Debit</th><th className="px-2 py-2 text-right">Credit</th><th /></tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const acc = l.account_id ? accMap.get(l.account_id) : null;
                return (
                  <tr key={l.key} className="border-t border-border">
                    <td className="px-1 py-1 min-w-[220px]">
                      <Select value={l.account_id} onValueChange={(v) => setLines(lines.map((x) => x.key === l.key ? { ...x, account_id: v } : x))}>
                        <SelectTrigger className="h-8"><SelectValue placeholder="Account" /></SelectTrigger>
                        <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}{a.is_control ? " (control)" : ""}</SelectItem>)}</SelectContent>
                      </Select>
                      {acc?.is_control && <span className="text-[11px] text-warning-foreground">control account</span>}
                    </td>
                    <td className="px-1 py-1"><Input className="h-8" value={l.description} onChange={(e) => setLines(lines.map((x) => x.key === l.key ? { ...x, description: e.target.value } : x))} /></td>
                    <td className="px-1 py-1"><Input className="h-8 w-28 text-right tabular-nums" type="number" min="0" step="0.01" value={l.debit} onChange={(e) => setLines(lines.map((x) => x.key === l.key ? { ...x, debit: e.target.value, credit: "" } : x))} /></td>
                    <td className="px-1 py-1"><Input className="h-8 w-28 text-right tabular-nums" type="number" min="0" step="0.01" value={l.credit} onChange={(e) => setLines(lines.map((x) => x.key === l.key ? { ...x, credit: e.target.value, debit: "" } : x))} /></td>
                    <td className="px-1 py-1 text-center"><button type="button" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr className="border-t border-border font-semibold">
              <td className="px-2 py-2" colSpan={2}>Totals</td>
              <td className="px-2 py-2 text-right tabular-nums">{formatMoney(td)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{formatMoney(tc)}</td><td />
            </tr></tfoot>
          </table>
        </div>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setLines([...lines, nl()])}><Plus className="h-4 w-4" /> Add line</Button>
      </CardContent></Card>

      {hitsControl && (
        <div className="flex items-center gap-2 rounded-md bg-warning/15 px-3 py-2 text-sm text-warning-foreground">
          <AlertTriangle className="h-4 w-4" /> This journal posts to a control account. {canControl ? "It will be recorded as a control-account adjustment." : "Only the Owner may post it."}
        </div>
      )}
      {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => submit(false)} disabled={pending}>Save draft</Button>
        {canPost && <Button onClick={() => submit(true)} disabled={pending || !balanced}>{pending ? "Working..." : "Post journal"}</Button>}
      </div>
    </div>
  );
}
