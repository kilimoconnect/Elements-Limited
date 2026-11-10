"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { TableRow } from "@/components/ui/table";
import { startNavigation } from "@/components/layout/navigation-progress";
import { cn } from "@/lib/utils";

/**
 * A table row that opens `href` when clicked anywhere (or with Enter), and
 * dims while the next page loads. Links and buttons inside it keep their own
 * behaviour.
 */
export function ClickableRow({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const go = () => { startNavigation(); startTransition(() => router.push(href)); };
  return (
    <TableRow
      role="link" tabIndex={0} aria-busy={pending || undefined}
      className={cn("cursor-pointer hover:bg-muted/60", pending && "pointer-events-none animate-pulse bg-muted/60 opacity-70", className)}
      onMouseEnter={() => router.prefetch(href)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, input, select, textarea, [role=button]")) return;
        if (e.metaKey || e.ctrlKey) { window.open(href, "_blank"); return; }
        go();
      }}
      onKeyDown={(e) => { if (e.key === "Enter") go(); }}
    >
      {children}
    </TableRow>
  );
}

/** A ClickableRow when there is somewhere to go, otherwise a plain row. */
export function MaybeClickableRow({ href, className, children }: { href: string | null; className?: string; children: React.ReactNode }) {
  return href ? <ClickableRow href={href} className={className}>{children}</ClickableRow> : <TableRow className={className}>{children}</TableRow>;
}
