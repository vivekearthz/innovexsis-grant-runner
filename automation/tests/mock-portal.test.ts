/**
 * End-to-end test against the local mock portal.
 *
 * What this test proves:
 *   1. Runner picks up an `url_paste` session from /api/public/runner/claim
 *   2. Opens the portal, extracts fields, gets an AI field-map
 *   3. Fills every field, clicks Next
 *   4. Hits the mock OTP page → posts `awaiting_otp: true`
 *   5. Simulated user posts OTP `424242` to /api/public/runner/otp/:id
 *   6. Runner types OTP, clicks Verify, lands on success page
 *   7. Runner posts `status: "completed"` — application transitions to submitted
 *
 * Run: bun run test  (from /automation)
 *
 * Requires:
 *   - APP_BASE_URL              e.g. https://<project>.lovable.app  or  http://localhost:8080
 *   - RUNNER_SHARED_SECRET      matches the deployed value
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  for seeding a test session
 */
import { test, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";

const APP = process.env.APP_BASE_URL!;
const SECRET = process.env.RUNNER_SHARED_SECRET!;
const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TEST_USER_ID = process.env.TEST_USER_ID!;

test.skipIf(!APP || !SECRET || !SB_URL || !SB_KEY || !TEST_USER_ID)(
  "mock portal end-to-end",
  { timeout: 5 * 60_000 },
  async () => {
    const admin = createClient(SB_URL, SB_KEY);
    const portalUrl = `${APP}/api/public/test/mock-portal`;

    // 1. Ensure a scheme + application + queued url_paste session exists.
    const { data: scheme } = await admin.from("schemes").insert({
      scheme_name: "MOCK — test portal",
      portal_url: portalUrl,
      category: "test",
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
      portal_url: portalUrl,
    }).select("id").single();

    // 2. Start the runner in headless mode as a subprocess.
    const runner = spawn("bun", ["run", "autofill-runner.ts"], {
      env: { ...process.env, RUNNER_HEADLESS: "1" },
      stdio: "inherit",
    });

    try {
      // 3. Poll for awaiting_otp
      let waitedOtp = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: s } = await admin.from("autofill_sessions").select("awaiting_otp,status").eq("id", session!.id).single();
        if (s?.awaiting_otp) { waitedOtp = true; break; }
        if (s?.status === "failed") throw new Error("runner failed before OTP");
      }
      expect(waitedOtp, "runner never asked for OTP within 2 min").toBe(true);

      // 4. Submit OTP
      await admin.from("autofill_sessions").update({ otp_value: "424242", awaiting_otp: false }).eq("id", session!.id);

      // 5. Poll for completed
      let completed = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: s } = await admin.from("autofill_sessions").select("status,success_detected_at").eq("id", session!.id).single();
        if (s?.status === "completed") { completed = true; break; }
        if (s?.status === "failed") throw new Error("runner failed after OTP");
      }
      expect(completed, "runner never reached completed status within 2 min").toBe(true);

      // 6. Application should be submitted
      const { data: finalApp } = await admin.from("applications").select("status,submitted_at").eq("id", app!.id).single();
      expect(finalApp?.status).toBe("submitted");
      expect(finalApp?.submitted_at).toBeTruthy();
    } finally {
      runner.kill("SIGKILL");
      // cleanup
      await admin.from("autofill_sessions").delete().eq("id", session!.id);
      await admin.from("applications").delete().eq("id", app!.id);
      await admin.from("schemes").delete().eq("id", scheme!.id);
    }
  }
);
