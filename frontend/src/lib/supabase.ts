// Server-only Supabase client. The `server-only` import makes the build FAIL if
// this module is ever pulled into a Client Component, so the key can never leak
// into the browser bundle (all DB access already goes through /api/* routes).
import "server-only";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

// Prefer the service_role key: it bypasses Row-Level Security, so we can turn RLS
// ON for the tables (defense in depth) and the API routes keep working. Falls
// back to the anon key only until SUPABASE_SERVICE_ROLE_KEY is set in the deploy
// env — so shipping this change can't break saves before that dashboard step.
// NOTE: once RLS is enabled, the anon key has no table access, so the fallback
// path will fail loudly (a safe failure) rather than leak or silently misbehave.
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  // This is a stateless server client — never persist or refresh a user session.
  auth: { persistSession: false, autoRefreshToken: false },
});
