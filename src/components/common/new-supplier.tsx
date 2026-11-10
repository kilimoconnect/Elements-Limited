"use client";

import * as React from "react";
import { toast } from "sonner";
import { Truck } from "lucide-react";
import { createSupplierQuick } from "@/lib/suppliers/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PhoneInput } from "@/components/common/phone-input";

const EMPTY = { name: "", contact: "", phone: "", email: "", tin: "", vat: "", terms: "0", address: "" };

/** Adds a supplier that is not in the list. Same name, phone, TIN or email as an existing supplier is refused. */
export function NewSupplierButton({ branchId, existing, onCreated, size = "sm" }: {
  branchId: string; existing: { id: string; code: string; name: string }[];
  onCreated: (s: { id: string; code: string; name: string }) => void; size?: "sm" | "default";
}) {
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState(EMPTY);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const similar = f.name.trim().length >= 3 ? existing.filter((c) => key(c.name).includes(key(f.name)) || key(f.name).includes(key(c.name))).slice(0, 3) : [];

  async function save() {
    if (!f.name.trim()) { setError("Enter the supplier name."); return; }
    setPending(true); setError(null);
    const r = await createSupplierQuick({ branchId, ...f, terms: Number(f.terms || 0) });
    setPending(false);
    if (!r.ok || !r.supplier) { setError(r.error ?? "Failed."); return; }
    toast.success(`Supplier ${r.supplier.code} created.`);
    onCreated(r.supplier);
    setOpen(false); setF(EMPTY);
  }

  return (
    <>
      <Button type="button" variant="outline" size={size} onClick={() => setOpen(true)}><Truck className="h-4 w-4" /> New supplier</Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New supplier</DialogTitle>
            <DialogDescription>Only add a supplier that is not in the list. One with the same name, phone, TIN or email as an existing supplier is refused.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2"><Label>Name <span className="text-destructive">*</span></Label><Input value={f.name} onChange={set("name")} /></div>
            {similar.length > 0 && (
              <p className="rounded-md bg-warning/15 px-3 py-2 text-xs sm:col-span-2">Similar existing suppliers: {similar.map((c) => `${c.code} — ${c.name}`).join("; ")}. Check it is not one of these.</p>
            )}
            <div className="space-y-1"><Label>Contact person</Label><Input value={f.contact} onChange={set("contact")} /></div>
            <div className="space-y-1"><Label>Phone</Label><PhoneInput value={f.phone} onChange={set("phone")} /></div>
            <div className="space-y-1"><Label>Email</Label><Input value={f.email} onChange={set("email")} type="email" /></div>
            <div className="space-y-1"><Label>Payment terms (days)</Label><Input value={f.terms} onChange={set("terms")} type="number" min="0" /></div>
            <div className="space-y-1"><Label>TIN</Label><Input value={f.tin} onChange={set("tin")} /></div>
            <div className="space-y-1"><Label>VAT registration no.</Label><Input value={f.vat} onChange={set("vat")} /></div>
            <div className="space-y-1 sm:col-span-2"><Label>Address</Label><Textarea rows={2} value={f.address} onChange={set("address")} /></div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button onClick={save} disabled={pending}>{pending ? "Working..." : "Create supplier"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
