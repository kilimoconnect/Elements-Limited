"use client";

import * as React from "react";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { createCustomerQuick } from "@/lib/sales/fulfilment-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PhoneInput } from "@/components/common/phone-input";

const EMPTY = { name: "", phone: "", email: "", tin: "", vat: "", address: "" };

/** Adds a customer that is not in the list. Same name, phone, TIN or email as an existing customer is refused. */
export function NewCustomerButton({ branchId, existing, onCreated }: {
  branchId: string; existing: { id: string; code: string; name: string }[];
  onCreated: (c: { id: string; code: string; name: string }) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState(EMPTY);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  // Early warning while typing; the database makes the final check.
  const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const similar = f.name.trim().length >= 3 ? existing.filter((c) => key(c.name).includes(key(f.name)) || key(f.name).includes(key(c.name))).slice(0, 3) : [];

  async function save() {
    if (!f.name.trim() || !f.phone.trim()) { setError("Name and phone are required."); return; }
    setPending(true); setError(null);
    const r = await createCustomerQuick({ branchId, ...f });
    setPending(false);
    if (!r.ok || !r.customer) { setError(r.error ?? "Failed."); return; }
    toast.success(`Customer ${r.customer.code} created.`);
    onCreated(r.customer);
    setOpen(false); setF(EMPTY);
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" /> New customer</Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New customer</DialogTitle>
            <DialogDescription>Only add a customer that is not in the list. A customer with the same name, phone, TIN or email already exists is refused.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2"><Label>Name <span className="text-destructive">*</span></Label><Input value={f.name} onChange={set("name")} /></div>
            {similar.length > 0 && (
              <p className="rounded-md bg-warning/15 px-3 py-2 text-xs sm:col-span-2">Similar existing customers: {similar.map((c) => `${c.code} — ${c.name}`).join("; ")}. Check it is not one of these.</p>
            )}
            <div className="space-y-1"><Label>Phone <span className="text-destructive">*</span></Label><PhoneInput value={f.phone} onChange={set("phone")} /></div>
            <div className="space-y-1"><Label>Email</Label><Input value={f.email} onChange={set("email")} type="email" /></div>
            <div className="space-y-1"><Label>TIN</Label><Input value={f.tin} onChange={set("tin")} /></div>
            <div className="space-y-1"><Label>VAT registration no.</Label><Input value={f.vat} onChange={set("vat")} /></div>
            <div className="space-y-1 sm:col-span-2"><Label>Address</Label><Textarea rows={2} value={f.address} onChange={set("address")} /></div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button onClick={save} disabled={pending}>{pending ? "Working..." : "Create customer"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
