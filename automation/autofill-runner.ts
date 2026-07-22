// GovSchemeOS autofill runner — deploy to any Node host with a display.
// Modes:
//   - "recorder"  : uses pre-recorded field_map_json from form_field_mappings.
//   - "url_paste" : opens the portal URL, extracts the DOM, asks the AI mapper
//                   for a field map, then fills using that map.
//
// Never clicks the final submit. WILL click intermediate "Verify OTP" / "Next"
// buttons after receiving an OTP from the user's phone.
import { chromium, type Page } from "playwright";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const APP = process.env.APP_BASE_URL!;
const SECRET = process.env.RUNNER_SHARED_SECRET!;
const RUNNER_ID = process.env.RUNNER_ID ?? `runner-${randomUUID().slice(0, 8)}`;
const RESUME_TPL = process.env.RESUME_URL_TEMPLATE ?? "";
const HEADLESS = process.env.RUNNER_HEADLESS === "1";

if (!APP || !SECRET) {
  console.error("APP_BASE_URL and RUNNER_SHARED_SECRET must be set");
  process.exit(1);
}

interface FieldEntry { selector: string; source: string; type: string }
interface FileEntry { selector: string; doc_type: string }

interface ClaimResp {
  session_id: string;
  application_id: string;
  mode: "recorder" | "url_paste";
  portal_url: string | null;
  mapping: {
    portal_url: string | null;
    field_map_json: FieldEntry[] | null;
    file_upload_map_json: FileEntry[] | null;
    submit_button_selector: string | null;
  } | null;
  entity: Record<string, unknown> | null;
  brand: Record<string, unknown> | null;
  documents: { doc_type: string; file_name: string; url: string | null }[];
}

interface GigDraftPayload {
  platform: "upwork" | "fiverr" | "freelancer";
  platformLabel: string;
  targetUrl: string;
  publicUrl: string;
  title: string;
  shortDescription: string;
  description: string;
  tags: string[];
  category: string;
  packages: { name: string; price_usd: number; price_inr: number; delivery_days: number; scope: string[] }[];
  faq: { q: string; a: string }[];
  cta: string;
}

interface FreelancerGigClaimResp {
  type: "freelancer_gig";
  id: string;
  platform: "upwork" | "fiverr" | "freelancer";
  service_slug: string;
  service_name: string;
  target_url: string;
  public_url: string;
  claim_payload: GigDraftPayload;
  retry_count: number;
  max_retries: number;
}

type RunnerJob = ({ type: "autofill" } & ClaimResp) | FreelancerGigClaimResp;

function resolve(source: string, entity: Record<string, unknown> | null, brand: Record<string, unknown> | null): string {
  const [table, col] = source.split(".");
  const row = table === "entity_profile" ? entity : brand;
  const v = row?.[col];
  return v == null ? "" : String(v);
}

async function fillField(page: Page, entry: FieldEntry, value: string) {
  if (!value) return;
  switch (entry.type) {
    case "text":
    case "email":
    case "tel":
    case "number":
    case "url":
    case "date":
    case "textarea":
      await page.fill(entry.selector, value);
      break;
    case "select":
      await page.selectOption(entry.selector, value).catch(async () => {
        // try by label
        await page.selectOption(entry.selector, { label: value });
      });
      break;
    case "checkbox":
      if (["true", "1", "yes", "on"].includes(value.toLowerCase())) await page.check(entry.selector);
      break;
    case "radio":
      await page.check(`${entry.selector}[value="${value}"]`);
      break;
    default:
      await page.fill(entry.selector, value).catch(() => {});
  }
}

async function claim(): Promise<RunnerJob | null> {
  const res = await fetch(`${APP}/api/public/runner/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": SECRET },
    body: JSON.stringify({ runnerId: RUNNER_ID }),
  });
  if (res.status === 204) return await claimFreelancerGig();
  if (!res.ok) { console.error("claim failed", res.status, await res.text()); return null; }
  const job = await res.json() as ClaimResp;
  return { type: "autofill", ...job };
}

async function claimFreelancerGig(): Promise<FreelancerGigClaimResp | null> {
  const res = await fetch(`${APP}/api/public/freelancer/runner/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": SECRET },
    body: JSON.stringify({ runnerId: RUNNER_ID }),
  });
  if (res.status === 204) return null;
  if (!res.ok) { console.error("freelancer claim failed", res.status, await res.text()); return null; }
  return await res.json() as FreelancerGigClaimResp;
}

async function update(sessionId: string, body: Record<string, unknown>) {
  const res = await fetch(`${APP}/api/public/runner/update/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error("update failed", res.status, await res.text());
}

async function updateGig(claimId: string, body: Record<string, unknown>) {
  const res = await fetch(`${APP}/api/public/freelancer/runner/update/${claimId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error("gig update failed", res.status, await res.text());
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${APP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

async function extractFormFields(page: Page) {
  return page.$$eval("input, select, textarea", (nodes) => {
    function cssPathFor(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const nameAttr = el.getAttribute("name");
      if (nameAttr) return `${el.tagName.toLowerCase()}[name="${nameAttr}"]`;
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        let sel = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter(c => c.tagName === cur!.tagName);
          if (same.length > 1) sel += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
        parts.unshift(sel);
        cur = parent;
      }
      return parts.join(" > ");
    }
    function labelFor(el: HTMLElement): string {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l?.textContent) return l.textContent.trim();
      }
      const wrap = el.closest("label");
      if (wrap?.textContent) return wrap.textContent.trim();
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const prev = el.previousElementSibling;
      if (prev && ["LABEL","SPAN","DIV"].includes(prev.tagName)) return (prev.textContent ?? "").trim();
      return "";
    }
    return nodes
      .filter((n) => {
        const el = n as HTMLInputElement;
        const t = (el.getAttribute("type") ?? "").toLowerCase();
        return !["hidden","submit","button","image","reset"].includes(t);
      })
      .map((n) => {
        const el = n as HTMLInputElement;
        const options = el.tagName === "SELECT"
          ? Array.from((el as unknown as HTMLSelectElement).options).map(o => o.value).filter(Boolean)
          : undefined;
        return {
          selector: cssPathFor(el),
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute("type") ?? el.tagName.toLowerCase()).toLowerCase(),
          name: el.getAttribute("name") ?? undefined,
          id: el.id || undefined,
          label: labelFor(el) || undefined,
          placeholder: el.getAttribute("placeholder") ?? undefined,
          options,
          required: el.hasAttribute("required"),
        };
      });
  });
}

async function findSubmitCandidate(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const submit = buttons.find(b => /submit|apply|finish/i.test(b.textContent ?? (b as HTMLInputElement).value ?? ""));
    if (!submit) return null;
    return submit.id ? `#${submit.id}` : submit.tagName.toLowerCase();
  });
}

async function detectOtpPrompt(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    const otp = inputs.find(i =>
      /otp|verification.?code|one.?time/i.test(`${i.name} ${i.id} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`)
    );
    if (!otp) return null;
    // Return a human prompt from surrounding text
    const label = document.querySelector(`label[for="${otp.id}"]`);
    return (label?.textContent ?? otp.placeholder ?? "Enter OTP sent to your phone").trim();
  });
}

async function detectSuccess(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    return /application (successful|submitted|received)|thank.?you|reference (number|id|no)|arn\s*[:#]/i.test(text);
  });
}

async function clickNext(page: Page): Promise<boolean> {
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
    const next = btns.find(b => /^(next|continue|verify|proceed|save.?and.?next)$/i.test((b.textContent ?? (b as HTMLInputElement).value ?? "").trim()));
    if (!next) return false;
    (next as HTMLElement).click();
    return true;
  });
  if (clicked) await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return clicked;
}

async function fillFirstAvailable(page: Page, patterns: RegExp[], value: string): Promise<string | null> {
  if (!value) return null;
  const selector = await page.evaluate((sources) => {
    const regexes = sources.map((s) => new RegExp(s, "i"));
    function labelText(el: Element): string {
      const input = el as HTMLInputElement;
      const bits = [input.name, input.id, input.placeholder, input.getAttribute("aria-label"), input.getAttribute("data-testid")];
      if (input.id) bits.push(document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ?? "");
      bits.push(input.closest("label")?.textContent ?? "");
      bits.push(input.parentElement?.textContent?.slice(0, 160) ?? "");
      return bits.filter(Boolean).join(" ");
    }
    const fields = Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea"));
    const match = fields.find((el) => regexes.some((rx) => rx.test(labelText(el))));
    if (!match) return null;
    if ((match as HTMLElement).id) return `#${CSS.escape((match as HTMLElement).id)}`;
    const name = match.getAttribute("name");
    if (name) return `${match.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    const all = Array.from(document.querySelectorAll(match.tagName.toLowerCase()));
    return `${match.tagName.toLowerCase()}:nth-of-type(${all.indexOf(match) + 1})`;
  }, patterns.map((rx) => rx.source));
  if (!selector) return null;
  await page.fill(selector, value).catch(async () => {
    await page.locator(selector).first().click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(value);
  });
  return selector;
}

async function clickDraftSafeProgress(page: Page): Promise<boolean> {
  const clicked = await page.evaluate(() => {
    const unsafe = /submit|publish|post\s+gig|place\s+bid|send\s+proposal|create\s+project|order\s+now/i;
    const safe = /save|continue|next|draft|skip|later|start|create\s+profile/i;
    const buttons = Array.from(document.querySelectorAll('button, input[type="button"], a')) as HTMLElement[];
    const btn = buttons.find((b) => {
      const text = (b.textContent ?? (b as HTMLInputElement).value ?? "").trim();
      return text && safe.test(text) && !unsafe.test(text);
    });
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (clicked) await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return clicked;
}

async function loginRequired(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    const password = Boolean(document.querySelector('input[type="password"]'));
    return password || /log in|login|sign in|continue with google|forgot password/.test(text);
  });
}

async function processFreelancerGig(job: FreelancerGigClaimResp) {
  console.log(`[gig:${job.id}] drafting ${job.platform} / ${job.service_slug}`);
  const resumeUrl = RESUME_TPL ? RESUME_TPL.replace("{session_id}", job.id) : undefined;
  await updateGig(job.id, { status: "drafting", ...(resumeUrl ? { resume_url: resumeUrl } : {}) });

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: HEADLESS ? [] : ["--remote-debugging-port=9222", "--no-sandbox"],
  });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(job.target_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});


    if (await loginRequired(page)) {
      const shot = await page.screenshot({ fullPage: true });
      await updateGig(job.id, {
        status: "awaiting_login",
        screenshot_base64: shot.toString("base64"),
        next_action: `Open ${job.target_url}, log in to ${job.platform}, then leave the browser/profile page ready. Runner will retry automatically.`,
        ...(resumeUrl ? { resume_url: resumeUrl } : {}),
      });
      return;
    }

    const p = job.claim_payload;
    const drafted: Record<string, string> = {};
    const fields: Array<[string, RegExp[], string]> = [
      ["title", [/title|headline|gig\s*title|profile\s*title|service\s*title/], p.title],
      ["shortDescription", [/short|summary|overview|brief|tagline/], p.shortDescription],
      ["description", [/description|about|bio|proposal|service\s*details|what\s+you\s+will\s+get/], p.description],
      ["tags", [/tag|skill|keyword|search/], p.tags.join(", ")],
      ["category", [/category|industry|speciality|specialty/], p.category],
      ["basicPrice", [/basic.*price|starter.*price|price|budget|amount|rate/], String(p.packages[0]?.price_usd ?? "")],
      ["standardPrice", [/standard.*price/], String(p.packages[1]?.price_usd ?? "")],
      ["premiumPrice", [/premium.*price/], String(p.packages[2]?.price_usd ?? "")],
      ["delivery", [/delivery|duration|days|timeline/], String(p.packages[0]?.delivery_days ?? "")],
      ["website", [/website|portfolio|url|link/], p.publicUrl],
    ];

    for (const [key, patterns, value] of fields) {
      const selector = await fillFirstAvailable(page, patterns, value).catch(() => null);
      if (selector) drafted[key] = value;
    }

    for (let i = 0; i < 3; i++) {
      const progressed = await clickDraftSafeProgress(page);
      if (!progressed || await loginRequired(page)) break;
      await fillFirstAvailable(page, [/description|about|bio|service\s*details/], p.description).then((sel) => {
        if (sel) drafted[`description_step_${i + 1}`] = p.description;
      }).catch(() => {});
      await fillFirstAvailable(page, [/website|portfolio|url|link/], p.publicUrl).then((sel) => {
        if (sel) drafted[`website_step_${i + 1}`] = p.publicUrl;
      }).catch(() => {});
    }

    const shot = await page.screenshot({ fullPage: true });
    await updateGig(job.id, {
      status: "awaiting_submit",
      drafted_fields: drafted,
      screenshot_base64: shot.toString("base64"),
      next_action: `Draft prepared for ${job.platform}. Review the fields and click Submit/Publish manually only after approval. Direct service link: ${p.publicUrl}`,
      ...(resumeUrl ? { resume_url: resumeUrl } : {}),
    });
  } catch (e) {
    console.error(`[gig:${job.id}] error`, e);
    await updateGig(job.id, { status: "failed", error_log: String(e) });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function processJob(job: ClaimResp) {
  console.log(`[${job.session_id}] processing (mode=${job.mode})`);
  const resumeUrl = RESUME_TPL ? RESUME_TPL.replace("{session_id}", job.session_id) : undefined;
  await update(job.session_id, { status: "filling", ...(resumeUrl ? { resume_url: resumeUrl } : {}) });

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: HEADLESS ? [] : ["--remote-debugging-port=9222", "--no-sandbox"],
  });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    // 1. Determine mapping (either recorded or AI-generated)
    let fieldMap: FieldEntry[] | null = null;
    let fileMap: FileEntry[] | null = null;
    let portalUrl: string | null = null;

    if (job.mode === "recorder") {
      if (!job.mapping?.field_map_json?.length || !job.mapping.portal_url) {
        await update(job.session_id, { status: "failed", error_log: "Missing portal_url or empty field_map" });
        return;
      }
      fieldMap = job.mapping.field_map_json;
      fileMap = job.mapping.file_upload_map_json ?? [];
      portalUrl = job.mapping.portal_url;
    } else {
      portalUrl = job.portal_url;
      if (!portalUrl) {
        await update(job.session_id, { status: "failed", error_log: "url_paste mode with no portal_url" });
        return;
      }
      await update(job.session_id, { current_step: "analysing" });
      await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});

      const fields = await extractFormFields(page);
      const submitSel = await findSubmitCandidate(page);
      const map = await postJson<{ field_map: FieldEntry[]; file_uploads: FileEntry[] }>(
        `/api/public/runner/map/${job.session_id}`,
        {
          portal_url: portalUrl,
          page_title: await page.title(),
          fields,
          submit_button_selector: submitSel ?? undefined,
        },
      );
      fieldMap = map.field_map;
      fileMap = map.file_uploads;
    }

    // 2. Fill fields
    await update(job.session_id, { current_step: "filling" });
    if (job.mode === "recorder") {
      await page.goto(portalUrl!, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    }


    const filled: Record<string, string> = {};
    for (const entry of fieldMap ?? []) {
      const v = resolve(entry.source, job.entity, job.brand);
      try {
        await fillField(page, entry, v);
        filled[entry.selector] = v;
      } catch (e) {
        console.warn(`skip ${entry.selector}:`, (e as Error).message);
      }
    }

    // 3. Attach docs
    const attached: string[] = [];
    for (const item of fileMap ?? []) {
      const doc = job.documents.find(d => d.doc_type === item.doc_type);
      if (!doc?.url) continue;
      const res = await fetch(doc.url);
      if (!res.ok) continue;
      const dir = join(tmpdir(), "govschemeos");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${randomUUID()}-${doc.file_name}`);
      await writeFile(path, Buffer.from(await res.arrayBuffer()));
      try {
        await page.setInputFiles(item.selector, path);
        attached.push(doc.file_name);
      } finally {
        unlink(path).catch(() => {});
      }
    }

    // 4. Click Next (safe — this is not the final Submit)
    await update(job.session_id, {
      current_step: "advancing",
      fields_filled: filled,
      documents_attached: attached,
    });
    await clickNext(page);

    // 5. OTP loop — if page has an OTP input, ask the user
    let iterations = 0;
    while (iterations < 5) {
      iterations++;
      const otpPrompt = await detectOtpPrompt(page);
      if (!otpPrompt) break;

      console.log(`[${job.session_id}] OTP required — waiting for user`);
      await update(job.session_id, {
        awaiting_otp: true,
        otp_prompt: otpPrompt,
        current_step: "awaiting_otp",
      });

      const otp = await waitForOtp(job.session_id, 5 * 60 * 1000); // 5 min
      if (!otp) {
        await update(job.session_id, { status: "failed", error_log: "OTP timeout (5 min)" });
        return;
      }

      // Fill OTP into first OTP-ish field, click next
      const otpSel = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
        const el = inputs.find(i => /otp|verification.?code|one.?time/i.test(`${i.name} ${i.id} ${i.placeholder}`));
        if (!el) return null;
        return el.id ? `#${el.id}` : `input[name="${el.name}"]`;
      });
      if (otpSel) await page.fill(otpSel, otp);
      await update(job.session_id, { otp_value: null, current_step: "verifying_otp" });
      await clickNext(page);
    }

    // 6. Success detection
    if (await detectSuccess(page)) {
      const shot = await page.screenshot({ fullPage: true });
      await update(job.session_id, {
        status: "completed",
        current_step: "completed",
        success_detected_at: new Date().toISOString(),
        screenshot_base64: shot.toString("base64"),
        next_action: "Application submitted successfully.",
      });
      console.log(`[${job.session_id}] SUCCESS`);
    } else {
      // Fell through OTP loop but no success page. Hand off to human.
      const shot = await page.screenshot({ fullPage: true });
      await update(job.session_id, {
        status: "awaiting_human_action",
        screenshot_base64: shot.toString("base64"),
        next_action: "Autofill reached a step it couldn't complete. Review the browser and finish manually.",
        ...(resumeUrl ? { resume_url: resumeUrl } : {}),
      });
    }
  } catch (e) {
    console.error(`[${job.session_id}] error`, e);
    await update(job.session_id, { status: "failed", error_log: String(e) });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function waitForOtp(sessionId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const res = await fetch(`${APP}/api/public/runner/otp/${sessionId}`, {
        headers: { "x-runner-secret": SECRET },
      });
      if (!res.ok) continue;
      const j = await res.json() as { awaiting_otp: boolean; otp: string | null };
      if (j.otp) return j.otp;
    } catch { /* keep polling */ }
  }
  return null;
}

// Hard per-job timeout guard. If processJob hangs (portal never idles,
// captcha wall, network blackhole), mark the session as needing human
// action WITH a screenshot instead of leaving it stuck in "filling"
// forever. Runs inside processJob's own try/catch so a timeout still
// closes the browser cleanly.
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Promise<void>): Promise<T | null> {
  return await Promise.race([
    promise.then((v) => v as T | null),
    new Promise<T | null>((resolve) => setTimeout(async () => { await onTimeout().catch(() => {}); resolve(null); }, ms)),
  ]);
}

// ONE JOB PER RUN, then exit. Prevents workflow-timeout from killing a
// job mid-fill and matches the user's "one at a time" processing directive.
// The GitHub Actions cron re-invokes every 5 min, so throughput is unchanged.
const PER_JOB_TIMEOUT_MS = 3 * 60 * 1000; // 3 min, leaves 60s slack under 4 min workflow cap

async function main() {
  console.log(`GovSchemeOS runner ${RUNNER_ID} started (headless=${HEADLESS}), polling ${APP}`);
  try {
    const job = await claim();
    if (!job) { console.log("no job"); return; }
    if (job.type === "freelancer_gig") {
      await withTimeout(
        processFreelancerGig(job),
        PER_JOB_TIMEOUT_MS,
        async () => { await updateGig(job.id, { status: "awaiting_login", error_log: "runner timeout — handoff" }); },
      );
    } else {
      await withTimeout(
        processJob(job),
        PER_JOB_TIMEOUT_MS,
        async () => {
          console.error(`[${job.session_id}] TIMEOUT after ${PER_JOB_TIMEOUT_MS}ms — handing off`);
          await update(job.session_id, {
            status: "awaiting_human_action",
            current_step: "runner_timeout",
            awaiting_human_since: new Date().toISOString(),
            error_log: `Runner hard-timeout at ${PER_JOB_TIMEOUT_MS}ms (portal never became interactive)`,
            next_action: "Portal did not respond in time. Open the resume URL and complete manually.",
          });
        },
      );
    }
  } catch (e) {
    console.error("main error", e);
  }
}

main();

