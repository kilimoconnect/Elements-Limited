"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/** Search by truck, trailer, driver, customer, order, invoice or delivery note. */
export function SearchBox({ value }: { value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = React.useState(value);
  const [loading, start] = React.useTransition();
  const apply = () => { const p = new URLSearchParams(sp.toString()); if (q.trim()) p.set("q", q.trim()); else p.delete("q"); start(() => router.push(`${pathname}?${p.toString()}`)); };
  return (
    <form className="flex items-center gap-1.5 print-hide" onSubmit={(e) => { e.preventDefault(); apply(); }}>
      <Input className="h-8 w-56" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Truck, driver, customer, invoice…" />
      <Button type="submit" size="sm" variant="outline" disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}</Button>
    </form>
  );
}
