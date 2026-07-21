/**
 * DRY-RUN against the real Udyam portal.
 *
 * This does NOT submit anything — the runner refuses to click any button
 * matching /submit|apply|finish/. It only proves that:
 *   1. The AI mapper produces a usable field map for the live DOM
 *   2. Every mapped selector still exists and accepts the profile value
 *   3. A screenshot of the fully-filled form is uploaded to storage
 *
 * Run: bun run automation/tests/udyam-dry-run.ts
 *
 * Requires the same env as the runner itself, plus TEST_USER_ID whose
 * entity_profile is populated (Udyam needs at least: legal_name, pan, and
 * authorized_signatory_phone).
 */
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";

const APP = process.env.APP_BASE_URL!;
const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TEST_USER_ID = process.env.TEST_USER_ID!;

if (!APP || !SB_URL || !SB_KEY || !TEST_USER_ID) {
  console.error("Set APP_BASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_USER_ID");
  process.exit(1);
}

const UDYAM_URL = process.env.UDYAM_URL ?? "https://udyamregistration.gov.in/UdyamRegistration.aspx";

(async () => {
  const admin = createClient(SB_URL, SB_KEY);

  const { data: scheme } = await admin.from("schemes").insert({
    scheme_name: "Udyam — dry run",
    portal_url: UDYAM_URL,
    category: "dry-run",
  }).select("id").single();

  const { data: app } = await admin.from("applications").insert({
    user_id: TEST_USER_ID,
    scheme_id: scheme!.id,
    status: "queued",
  }).select("id").single();

  const { data: session } = await admin.from("autofill_sessions").insert({
    user_id: TEST_USER_ID,
    application_id: app!.id,
    status: "queued",
    mode: "url_paste",
    portal_url: UDYAM_URL,
  }).select("id").single();

  console.log(`Queued dry-run session ${session!.id} — starting runner (headed)`);

  const runner = spawn("bun", ["run", "autofill-runner.ts"], {
    env: { ...process.env, RUNNER_HEADLESS: "0" },
    stdio: "inherit",
  });

  process.on("SIGINT", () => { runner.kill("SIGKILL"); process.exit(0); });
})();
