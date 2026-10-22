// Starts the built app (`next start`) with Supabase pointed at an unused local
// address, so UI smoke checks never reach a real (production) project.
// Usage: npm run build (with the same overrides), then node scripts/start-offline.mjs
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "offline-anon",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service",
  DATABASE_URL: "",
  PORT: process.env.PORT || "3100",
};
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", env.PORT], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
