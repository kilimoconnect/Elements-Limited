import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { SignOutButton } from "@/components/layout/sign-out-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "Access denied" };

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Access denied</h1>
            <p className="text-sm text-muted-foreground">
              Your account does not have permission to view this page. If you
              believe this is a mistake, contact the Owner.
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
            <Button asChild variant="outline">
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
            <SignOutButton />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
