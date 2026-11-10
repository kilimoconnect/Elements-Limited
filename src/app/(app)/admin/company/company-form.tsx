"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import { updateCompany, type CompanyState } from "@/lib/admin/company-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { PhoneInput } from "@/components/common/phone-input";

export interface CompanyValues {
  code: string;
  name: string;
  legal_name: string | null;
  base_currency: string;
  timezone: string;
  date_format: string;
  phone: string | null;
  email: string | null;
  address: string | null;
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Save changes"}
    </Button>
  );
}

export function CompanyForm({ company }: { company: CompanyValues }) {
  const [state, formAction] = useActionState<CompanyState, FormData>(updateCompany, {});
  const shown = useRef(false);

  useEffect(() => {
    if (state.ok && !shown.current) {
      shown.current = true;
      toast.success("Company updated.");
    }
    if (state.ok) shown.current = true;
    else shown.current = false;
  }, [state]);

  return (
    <Card className="max-w-2xl">
      <CardContent className="p-6">
        <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Company Code</Label>
            <Input value={company.code} disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="name">Company Name *</Label>
            <Input id="name" name="name" defaultValue={company.name} required />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="legal_name">Legal Name</Label>
            <Input id="legal_name" name="legal_name" defaultValue={company.legal_name ?? ""} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="base_currency">Base Currency *</Label>
            <Input id="base_currency" name="base_currency" defaultValue={company.base_currency} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Time Zone *</Label>
            <Input id="timezone" name="timezone" defaultValue={company.timezone} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="date_format">Date Format *</Label>
            <Input id="date_format" name="date_format" defaultValue={company.date_format} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone">Phone</Label>
            <PhoneInput id="phone" name="phone" defaultValue={company.phone ?? ""} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" defaultValue={company.email ?? ""} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="address">Address</Label>
            <Textarea id="address" name="address" defaultValue={company.address ?? ""} />
          </div>

          {state.error && (
            <p className="sm:col-span-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.error}
            </p>
          )}

          <div className="sm:col-span-2 flex justify-end">
            <SaveButton />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
