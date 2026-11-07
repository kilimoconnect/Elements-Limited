"use client";

import { useFormStatus } from "react-dom";
import { Loader2, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";

/** Shows a spinner and "Signing out…" until the sign-out finishes. */
function MenuSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive outline-none transition-colors hover:bg-destructive/10 focus:bg-destructive/10 disabled:cursor-wait disabled:opacity-80"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

export function SignOutMenuItem() {
  return (
    <form action={signOut} className="w-full">
      <MenuSubmit />
    </form>
  );
}

function ButtonSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" className="w-full" disabled={pending} aria-busy={pending}>
      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}

/** Stand-alone sign-out button (e.g. the Access denied page). */
export function SignOutButton() {
  return (
    <form action={signOut}>
      <ButtonSubmit />
    </form>
  );
}
