"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";

const schema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
  redirectTo: z.string().optional(),
});

export interface SignInState {
  error?: string;
}

export async function signIn(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    redirectTo: formData.get("redirectTo") ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { email, password, redirectTo } = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    // Wrong credentials keep the generic message; anything else (bad key,
    // rate limit, network) is shown so a misconfiguration is not mistaken for a typo.
    if (!error || error.code === "invalid_credentials") {
      return { error: "Invalid email or password." };
    }
    console.error("sign-in failed", { status: error.status, code: error.code, message: error.message });
    return { error: `Sign-in failed: ${error.message}${error.code ? ` (${error.code})` : ""}` };
  }

  // Enforce that the user has an active application profile.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles")
    .select("id, is_active, default_company_id, default_branch_id")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile) {
    await supabase.auth.signOut();
    return {
      error: "This account has no application profile. Contact the Owner.",
    };
  }

  if (!profile.is_active) {
    await supabase.auth.signOut();
    return { error: "This account is inactive. Contact the Owner." };
  }

  await admin
    .from("user_profiles")
    .update({ last_sign_in_at: new Date().toISOString() })
    .eq("id", data.user.id);

  await writeAuditLog({
    userId: data.user.id,
    companyId: profile.default_company_id,
    branchId: profile.default_branch_id,
    action: "auth.sign_in",
    resourceType: "user_profiles",
    resourceId: data.user.id,
  });

  const dest =
    redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("//")
      ? redirectTo
      : "/dashboard";
  redirect(dest);
}
