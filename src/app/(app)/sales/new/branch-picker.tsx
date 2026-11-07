"use client";

import { useRouter } from "next/navigation";
import { startNavigation } from "@/components/layout/navigation-progress";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** For users assigned to several branches: the branch this request sells from (stock, accounts, approvers). */
export function BranchPicker({ value, branches, path }: { value: string; branches: { id: string; name: string }[]; path: string }) {
  const router = useRouter();
  return (
    <Card className="mb-4">
      <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4">
        <Label className="shrink-0">Branch</Label>
        <Select value={value} onValueChange={(v) => { if (v !== value) { startNavigation(); router.push(`${path}?branch=${v}`); } }}>
          <SelectTrigger className="sm:w-72"><SelectValue /></SelectTrigger>
          <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Stock, payment accounts and the approving managers follow this branch.</p>
      </CardContent>
    </Card>
  );
}
