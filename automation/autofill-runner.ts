// GovSchemeOS autofill runner — deploy to any Node host with a display.
// Modes:
//   - "recorder"  : uses pre-recorded field_map_json from form_field_mappings.
//   - "url_paste" : opens the portal URL, extracts the DOM, asks the AI mapper
//                   for a field map, then fills using that map.
//
// SUBMIT POLICY (owner-authorised, 2026-08-20): the runner fills, uploads,
// advances wizard steps, verifies every required field/credential is populated,
// then ACTIVATES the final Submit control and confirms the success screen.
// It only stops for genuine human-only blockers (OTP, captcha, login, fee),
// which are escalated to 3 email IDs + 2 WhatsApp numbers immediately.

import { chromium, type Page } from "playwright";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Self-healing base URL. A workspace move (or a rename) can leave APP_BASE_URL
// pointing at a host that now answers 3xx instead of serving the API — the
// runner then polls forever and claims nothing. So we probe every known base
// at boot and adopt the first one that actually serves the API.
const BASE_CANDIDATES = [
  process.env.APP_BASE_URL,
  "https://grantmonsy.innovexsis.com",
  "https://grant-wizardry-26.lovable.app",
  "https://project--4c40a0f5-5a99-4ee7-ae1f-360884387fc6.lovable.app",
].filter((u): u is string => Boolean(u)).map((u) => u.replace(/\/+$/, ""));

let APP = BASE_CANDIDATES[0] ?? "";
const SECRET = process.env.RUNNER_SHARED_SECRET!;
const RUNNER_ID = process.env.RUNNER_ID ?? `runner-${randomUUID().slice(0, 8)}`;
const RESUME_TPL = process.env.RESUME_URL_TEMPLATE ?? "";
const HEADLESS = process.env.RUNNER_HEADLESS === "1";

if (!APP || !SECRET) {
  console.error("APP_BASE_URL and RUNNER_SHARED_SECRET must be set");
  process.exit(1);
}

/** Pick a base URL that serves the API directly (no redirect, no auth wall). */
async function resolveBase(): Promise<void> {
  for (const base of BASE_CANDIDATES) {
    try {
      const res = await fetch(`${base}/api/public/portal/version`, {
        redirect: "manual",
        headers: { "x-runner-secret": SECRET },
      });
      if (res.status >= 200 && res.status < 300) {
        if (base !== APP) console.warn(`[runner] base self-heal: ${APP} -> ${base}`);
        APP = base;
        return;
      }
      console.warn(`[runner] base ${base} unusable (HTTP ${res.status})`);
    } catch (e) {
      console.warn(`[runner] base ${base} unreachable:`, (e as Error).message);
    }
  }
  console.error("[runner] no usable base URL found; keeping", APP);
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

interface JobPosting {
  id: string;
  portal: string | null;
  post_name: string;
  apply_url: string | null;
  fee_inr: number | null;
  required_docs: string[];
  required_fields: string[];
}
interface JobRecipe {
  portal_key: string;
  login_url: string | null;
  field_map: unknown;
  doc_map: unknown;
  fee_ceiling_inr: number;
  needs_captcha: boolean;
  needs_otp: boolean;
  submit_selector: string | null;
}
interface JobClaimResp {
  type: "job_application";
  session_id: string;
  application_id: string;
  user_id: string;
  posting: JobPosting;
  recipe: JobRecipe | null;
  application: { id: string; status: string } | null;
  applicant_facts: Record<string, string>;
  login: { username: string; password: string } | null;
  documents: { doc_type: string; file_name: string; url: string | null }[];
}

type RunnerJob = ({ type: "autofill" } & ClaimResp) | FreelancerGigClaimResp | JobClaimResp;

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
  if (res.status === 204) {
    const job = await claimJobApplication();
    if (job) return job;
    return await claimFreelancerGig();
  }
  if (!res.ok) { console.error("claim failed", res.status, await res.text()); return null; }
  const job = await res.json() as ClaimResp;
  return { type: "autofill", ...job };
}

async function claimJobApplication(): Promise<JobClaimResp | null> {
  const res = await fetch(`${APP}/api/public/jobs/runner-claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": SECRET },
    body: JSON.stringify({ runnerId: RUNNER_ID }),
  });
  if (res.status === 204) return null;
  if (!res.ok) { console.error("jobs claim failed", res.status, await res.text()); return null; }
  return await res.json() as JobClaimResp;
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

async function updateJob(sessionId: string, body: Record<string, unknown>) {
  const res = await fetch(`${APP}/api/public/jobs/runner-update/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error("job update failed", res.status, await res.text());
}

// How long to wait for an OTP (mailbox auto-read or human paste) before we
// treat it as a genuine blocker and escalate.
const OTP_WAIT_MS = Number(process.env.RUNNER_OTP_WAIT_MS ?? 4 * 60 * 1000);

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

// ---------------- SAFE FORM-DRIVE CORE ----------------

export type Blocker =
  | "otp_required"
  | "captcha_unsolved"
  | "login_required"
  | "fee_payment"
  | "awaiting_submit"
  | "incomplete_fields"
  | "submit_rejected"
  | "unknown_blocker";


/** Detect a paid-fee gate above the auto-pay ceiling (default ₹1000). */
const FEE_CEILING_INR = Number(process.env.AUTO_PAY_CEILING_INR ?? 1000);

async function detectFeeGate(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const text = document.body.innerText.slice(0, 8000);
    if (!/pay(ment)?\s*(now|fee)?|application fee|proceed to pay/i.test(text)) return null;
    const m = text.match(/(?:₹|rs\.?|inr)\s*([\d,]+)/i);
    return m ? Number(m[1].replace(/,/g, "")) : 0;
  }).catch(() => null);
}

/** Any visible captcha image still unanswered on the page. */
async function detectCaptcha(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Boolean(document.querySelector("img[src*='captcha' i], img[id*='captcha' i], img[alt*='captcha' i], iframe[src*='recaptcha' i], div.g-recaptcha, div[class*='hcaptcha' i]")),
  ).catch(() => false);
}

/** Pull a submission/reference/ARN number off a success page. */
async function extractReference(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const patterns = [
      /(?:reference|acknowledg(?:e)?ment|application|registration|arn|ack)\s*(?:number|no\.?|id|#)?\s*[:#-]\s*([A-Z0-9][A-Z0-9\/-]{5,30})/i,
      /\b(ARN[A-Z0-9-]{6,})\b/i,
      /\b([A-Z]{2,5}\d{8,18})\b/,
    ];
    for (const rx of patterns) {
      const m = text.match(rx);
      if (m?.[1]) return m[1].trim();
    }
    return null;
  }).catch(() => null);
}

/** Tick every mandatory declaration/consent checkbox before submitting. */
async function acceptDeclarations(page: Page): Promise<number> {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    let n = 0;
    for (const b of boxes) {
      const hay = `${b.name} ${b.id} ${b.closest("label")?.textContent ?? ""} ${b.parentElement?.textContent?.slice(0, 200) ?? ""}`.toLowerCase();
      if (b.checked) continue;
      if (/declar|agree|consent|terms|undertak|certif|true and correct|i hereby/.test(hay)) {
        b.click();
        n++;
      }
    }
    return n;
  }).catch(() => 0);
}

/** Detect the real final Submit control without activating it. */
async function hasFinalSubmitControl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const wanted = /^(submit|submit application|final submit|apply now|confirm(\s+and\s+submit)?|save\s*&?\s*submit|send application)$/i;
    const loose = /submit|final\s*submit|confirm\s*&?\s*submit/i;
    const deny = /reset|cancel|back|logout|search|save\s*as\s*draft/i;
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]')) as HTMLElement[];
    const label = (b: HTMLElement) => ((b.textContent ?? (b as HTMLInputElement).value ?? "").trim());
    const visible = btns.filter((b) => {
      const r = b.getBoundingClientRect();
      const t = label(b);
      return t && r.width > 0 && r.height > 0 && !(b as HTMLButtonElement).disabled && !deny.test(t);
    });
    const target = visible.find((b) => wanted.test(label(b))) ?? visible.find((b) => loose.test(label(b)));
    return Boolean(target);
  }).catch(() => false);
}

/**
 * Owner-authorised (2026-08-20): the runner completes the final Submit itself.
 * Returns the list of still-empty required fields so we never submit a form
 * the portal would reject.
 */
async function missingRequiredFields(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const els = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input[required], select[required], textarea[required], input[aria-required='true'], select[aria-required='true'], textarea[aria-required='true']",
    ));
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const group = el.name
          ? Array.from(document.getElementsByName(el.name)) as HTMLInputElement[]
          : [el];
        if (!group.some((g) => g.checked)) out.push(el.name || el.id || "checkbox");
        continue;
      }
      if (el instanceof HTMLInputElement && el.type === "file") continue;
      if (!String(el.value ?? "").trim()) out.push(el.name || el.id || el.getAttribute("aria-label") || "field");
    }
    return Array.from(new Set(out)).slice(0, 25);
  }).catch(() => []);
}

/** Activate the final Submit control and wait for the portal to settle. */
async function clickFinalSubmit(page: Page): Promise<boolean> {
  const clicked = await page.evaluate(() => {
    const wanted = /^(submit|submit application|final submit|apply now|confirm(\s+and\s+submit)?|save\s*&?\s*submit|send application)$/i;
    const loose = /submit|final\s*submit|confirm\s*&?\s*submit/i;
    const deny = /reset|cancel|back|logout|search|save\s*as\s*draft/i;
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]')) as HTMLElement[];
    const label = (b: HTMLElement) => ((b.textContent ?? (b as HTMLInputElement).value ?? "").trim());
    const visible = btns.filter((b) => {
      const r = b.getBoundingClientRect();
      const t = label(b);
      return t && r.width > 0 && r.height > 0 && !(b as HTMLButtonElement).disabled && !deny.test(t);
    });
    const target = visible.find((b) => wanted.test(label(b))) ?? visible.find((b) => loose.test(label(b)));
    if (!target) return false;
    target.click();
    return true;
  }).catch(() => false);
  if (clicked) {
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
    // Some portals raise a "Confirm / Yes / OK" modal after Submit.
    await page.evaluate(() => {
      const ok = /^(yes|ok|confirm|proceed|submit)$/i;
      const btns = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']")) as HTMLElement[];
      const modalBtn = btns.find((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && ok.test(((b.textContent ?? (b as HTMLInputElement).value ?? "").trim()));
      });
      modalBtn?.click();
    }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  }
  return clicked;
}

/**
 * Drive every step INCLUDING the final Submit, retrying the submit action
 * with self-heal until the portal shows a success/reference screen.
 */
async function driveToSubmission(
  page: Page,
  onOtp: () => Promise<string | null>,
  maxRounds = 14,
): Promise<{ ok: true; reference: string | null } | { ok: false; blocker: Blocker; detail: string }> {
  let submitAttempts = 0;
  const MAX_SUBMIT_ATTEMPTS = Number(process.env.MAX_SUBMIT_ATTEMPTS ?? 4);

  for (let round = 0; round < maxRounds; round++) {
    if (await detectSuccess(page)) {
      return { ok: true, reference: await extractReference(page) };
    }

    // Real blockers first.
    if (await detectOtpPrompt(page)) {
      const otp = await onOtp();
      if (!otp) return { ok: false, blocker: "otp_required", detail: "OTP not received within the wait window" };
      const otpSel = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
        const el = inputs.find(i => /otp|verification.?code|one.?time/i.test(`${i.name} ${i.id} ${i.placeholder}`));
        return el ? (el.id ? `#${el.id}` : `input[name="${el.name}"]`) : null;
      });
      if (otpSel) await page.fill(otpSel, otp).catch(() => {});
      await clickNext(page);
      continue;
    }

    if (await detectCaptcha(page)) {
      const solved = await solveCaptcha(page);
      if (!solved) return { ok: false, blocker: "captcha_unsolved", detail: "Captcha present and AI solve failed" };
      await fillFirstAvailable(page, [/captcha|verification.?text|security.?code/], solved).catch(() => null);
    }

    const fee = await detectFeeGate(page);
    if (fee !== null && fee > FEE_CEILING_INR) {
      return { ok: false, blocker: "fee_payment", detail: `Portal asks for ₹${fee} (auto-pay ceiling ₹${FEE_CEILING_INR})` };
    }

    if (await loginRequired(page)) {
      return { ok: false, blocker: "login_required", detail: "Portal shows a login wall" };
    }

    await acceptDeclarations(page);

    if (await hasFinalSubmitControl(page)) {
      const missing = await missingRequiredFields(page);
      if (missing.length > 0) {
        return {
          ok: false,
          blocker: "incomplete_fields",
          detail: `Cannot submit — ${missing.length} mandatory field(s) still empty: ${missing.join(", ")}`,
        };
      }
      submitAttempts++;
      const clicked = await clickFinalSubmit(page);
      if (await detectSuccess(page)) {
        return { ok: true, reference: await extractReference(page) };
      }
      if (!clicked || submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
        return {
          ok: false,
          blocker: "submit_rejected",
          detail: `Final Submit activated ${submitAttempts}x but no success/reference screen appeared`,
        };
      }
      // Portal likely raised a validation error — loop re-heals and retries.
      continue;
    }
    const advanced = await clickNext(page);
    if (!advanced) {
      return { ok: false, blocker: "unknown_blocker", detail: "No final Submit or reversible Next control found on the page" };
    }
  }

  if (await detectSuccess(page)) return { ok: true, reference: await extractReference(page) };
  return { ok: false, blocker: "submit_rejected", detail: `No success screen after ${maxRounds} rounds` };
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

    // 4. Advance every wizard step AND complete the final Submit.
    await update(job.session_id, {
      current_step: "driving_to_submission",
      fields_filled: filled,
      documents_attached: attached,
    });


    const outcome = await driveToSubmission(page, async () => {
      const prompt = (await detectOtpPrompt(page)) ?? "Enter the OTP sent to your registered mobile/email";
      console.log(`[${job.session_id}] OTP required — waiting (auto-read from mailbox)`);
      await update(job.session_id, { awaiting_otp: true, otp_prompt: prompt, current_step: "awaiting_otp" });
      const otp = await waitForOtp(job.session_id, OTP_WAIT_MS);
      await update(job.session_id, { otp_value: null, awaiting_otp: false, current_step: "verifying_otp" });
      return otp;
    });

    const shot = await page.screenshot({ fullPage: true });
    if (outcome.ok) {
      await update(job.session_id, {
        status: "completed",
        current_step: "completed",
        success_detected_at: new Date().toISOString(),
        screenshot_base64: shot.toString("base64"),
        next_action: "Application submitted automatically by the runner.",
        ...(outcome.reference ? { submission_reference: outcome.reference } : {}),
      });
      console.log(`[${job.session_id}] SUBMITTED ref=${outcome.reference ?? "n/a"}`);
    } else {
      // Genuine human blocker — the backend fans this out to 3 emails + 2
      // WhatsApp numbers with portal + resume deep links.
      await update(job.session_id, {
        status: "awaiting_human_action",
        current_step: `blocked_${outcome.blocker}`,
        blocker: outcome.blocker,
        portal_url: portalUrl ?? undefined,
        screenshot_base64: shot.toString("base64"),
        next_action: `${outcome.blocker}: ${outcome.detail}. Clear it on the portal — the runner resumes and submits automatically.`,
        ...(resumeUrl ? { resume_url: resumeUrl } : {}),
      });
      console.log(`[${job.session_id}] BLOCKED ${outcome.blocker} — escalated`);
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
// 7 min budget leaves 60s slack under the 8 min workflow cap and gives the
// 5-min OTP wait room to complete after navigation/mapping/fill.
const PER_JOB_TIMEOUT_MS = 7 * 60 * 1000;

// Fetch current session so we don't clobber a legitimate awaiting_otp /
// awaiting_human_action / completed state with a misleading "runner timeout"
// message. Returns null on error so the caller falls back to overwriting.
async function fetchSessionStatus(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`${APP}/api/public/runner/otp/${sessionId}`, {
      headers: { "x-runner-secret": SECRET },
    });
    if (!res.ok) return null;
    const j = await res.json() as { status?: string | null };
    return j.status ?? null;
  } catch { return null; }
}

// -------------------- JOB APPLICATION BRANCH --------------------
// Government job portals (UPSC/SSC/IBPS/etc.). Full lifecycle:
//  1. Navigate to apply_url.
//  2. If login page detected, fill credentials + solve captcha via AI.
//  3. Extract form fields → AI mapper (reuses the grants /runner/map endpoint
//     is scheme-only; we use a lightweight source resolver against
//     applicant_facts + posting.required_fields directly).
//  4. Upload documents matching required_docs by doc_type.
//  5. OTP loop with 5-min wait per attempt.
//  6. Screenshot + hand off to human for the final Submit click. Per project
//     rule: the runner NEVER clicks Submit on government portals.

async function solveCaptcha(page: Page): Promise<string | null> {
  // Common captcha image selectors on Indian gov portals.
  const selectors = ["img[src*='captcha' i]", "img[id*='captcha' i]", "img[alt*='captcha' i]"];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (!el) continue;
    try {
      const buf = await el.screenshot();
      const b64 = buf.toString("base64");
      const res = await fetch(`${APP}/api/public/jobs/captcha-solve`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-runner-secret": SECRET },
        body: JSON.stringify({ image_b64: b64 }),
      });
      if (!res.ok) continue;
      const j = await res.json() as { ok?: boolean; text?: string };
      if (j.ok && j.text) return j.text;
    } catch { /* try next */ }
  }
  return null;
}

async function attemptLogin(page: Page, login: { username: string; password: string }): Promise<boolean> {
  const filledUser = await fillFirstAvailable(page, [/user.?name|user.?id|login.?id|email|registration.?no/], login.username);
  const filledPw = await fillFirstAvailable(page, [/password|passwd|pwd/], login.password);
  if (!filledUser || !filledPw) return false;

  const captchaText = await solveCaptcha(page);
  if (captchaText) {
    await fillFirstAvailable(page, [/captcha|verification.?text|security.?code/], captchaText);
  }

  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
    const login = btns.find(b => /log\s*in|sign\s*in|submit/i.test((b.textContent ?? (b as HTMLInputElement).value ?? "").trim()));
    if (!login) return false;
    (login as HTMLElement).click();
    return true;
  });
  if (clicked) await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return true;
}

async function resolveJobValue(field: { name?: string; id?: string; label?: string; placeholder?: string }, facts: Record<string, string>): Promise<string | null> {
  const hay = `${field.name ?? ""} ${field.id ?? ""} ${field.label ?? ""} ${field.placeholder ?? ""}`.toLowerCase();
  const rules: Array<[RegExp, string[]]> = [
    [/full.?name|candidate.?name|applicant.?name/, ["founder_full_name", "founder_name", "applicant_full_name"]],
    [/first.?name/, ["founder_first_name", "applicant_first_name"]],
    [/last.?name|surname/, ["founder_last_name", "applicant_last_name"]],
    [/father/, ["founder_father_name", "applicant_father_name"]],
    [/mother/, ["founder_mother_name", "applicant_mother_name"]],
    [/dob|date.?of.?birth|birth.?date/, ["founder_dob", "applicant_dob"]],
    [/gender/, ["founder_gender", "applicant_gender"]],
    [/email/, ["founder_email", "applicant_email"]],
    [/mobile|phone|contact.?no/, ["founder_mobile", "applicant_mobile", "founder_phone"]],
    [/aadhaar|aadhar|uid/, ["founder_aadhaar", "applicant_aadhaar"]],
    [/pan/, ["founder_pan", "applicant_pan"]],
    [/category|caste/, ["applicant_category", "founder_category"]],
    [/address|residence/, ["founder_address", "applicant_address"]],
    [/pincode|pin.?code|zip/, ["founder_pincode", "applicant_pincode"]],
    [/state/, ["founder_state", "applicant_state"]],
    [/district|city/, ["founder_city", "founder_district", "applicant_city"]],
    [/nationality/, ["founder_nationality", "applicant_nationality"]],
    [/qualification|education/, ["founder_qualification", "applicant_qualification"]],
  ];
  for (const [rx, keys] of rules) {
    if (!rx.test(hay)) continue;
    for (const k of keys) if (facts[k]) return facts[k];
  }
  return null;
}

async function processJobApplication(job: JobClaimResp) {
  const sid = job.session_id;
  console.log(`[job:${sid}] ${job.posting.portal ?? "unknown"} — ${job.posting.post_name}`);
  const resumeUrl = RESUME_TPL ? RESUME_TPL.replace("{session_id}", sid) : undefined;
  await updateJob(sid, { status: "filling", current_step: "starting", ...(resumeUrl ? { resume_url: resumeUrl } : {}) });

  const applyUrl = job.posting.apply_url ?? job.recipe?.login_url ?? null;
  if (!applyUrl) {
    await updateJob(sid, { status: "failed", error_log: "no apply_url on posting" });
    return;
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: HEADLESS ? [] : ["--remote-debugging-port=9222", "--no-sandbox"],
  });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});

    // Login if required and creds provided.
    if (await loginRequired(page)) {
      if (!job.login) {
        const shot = await page.screenshot({ fullPage: true });
        await updateJob(sid, {
          status: "awaiting_login",
          screenshot_base64: shot.toString("base64"),
          next_action: `Portal ${job.posting.portal ?? ""} requires login but no credentials are stored. Save them via secure form.`,
        });
        return;
      }
      await updateJob(sid, { current_step: "logging_in" });
      const ok = await attemptLogin(page, job.login);
      if (!ok) {
        const shot = await page.screenshot({ fullPage: true });
        await updateJob(sid, {
          status: "awaiting_login",
          screenshot_base64: shot.toString("base64"),
          next_action: "Runner could not find login fields. Complete the login manually and retry.",
        });
        return;
      }
      // OTP after login?
      if (await detectOtpPrompt(page)) {
        const prompt = await detectOtpPrompt(page);
        await updateJob(sid, { awaiting_otp: true, otp_prompt: prompt, current_step: "awaiting_otp_login" });
        const otp = await waitForOtp(sid, 5 * 60 * 1000);
        if (!otp) { await updateJob(sid, { status: "failed", error_log: "login OTP timeout" }); return; }
        const otpSel = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
          const el = inputs.find(i => /otp|verification.?code|one.?time/i.test(`${i.name} ${i.id} ${i.placeholder}`));
          return el ? (el.id ? `#${el.id}` : `input[name="${el.name}"]`) : null;
        });
        if (otpSel) await page.fill(otpSel, otp);
        await updateJob(sid, { otp_value: null, current_step: "verifying_login_otp", awaiting_otp: false });
        await clickNext(page);
      }
    }

    // Fill the application form using applicant_facts + label-matching.
    await updateJob(sid, { current_step: "filling_form" });
    const fields = await extractFormFields(page);
    const filled: Record<string, string> = {};
    for (const f of fields) {
      if (["file"].includes(f.type)) continue;
      const value = await resolveJobValue(f, job.applicant_facts);
      if (!value) continue;
      try {
        await fillField(page, { selector: f.selector, source: "applicant_facts", type: f.type }, value);
        filled[f.selector] = value;
      } catch { /* skip */ }
    }

    // Uploads: match documents by doc_type against posting.required_docs.
    const attached: string[] = [];
    const fileInputs = fields.filter(f => f.type === "file");
    for (const f of fileInputs) {
      const hay = `${f.name ?? ""} ${f.id ?? ""} ${f.label ?? ""} ${f.placeholder ?? ""}`.toLowerCase();
      const wantType = job.posting.required_docs.find(d => hay.includes(d.replace(/_/g, " ")))
        ?? (hay.includes("photo") ? "photo" : hay.includes("sign") ? "signature" : null);
      if (!wantType) continue;
      const doc = job.documents.find(d => d.doc_type === wantType);
      if (!doc?.url) continue;
      try {
        const res = await fetch(doc.url);
        if (!res.ok) continue;
        const dir = join(tmpdir(), "govschemeos-jobs");
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${randomUUID()}-${doc.file_name}`);
        await writeFile(path, Buffer.from(await res.arrayBuffer()));
        try {
          await page.setInputFiles(f.selector, path);
          attached.push(doc.file_name);
        } finally { unlink(path).catch(() => {}); }
      } catch (e) { console.warn("upload failed", (e as Error).message); }
    }

    await updateJob(sid, { fields_filled: filled, documents_attached: attached, current_step: "submitting" });

    const outcome = await driveToSubmission(page, async () => {
      const prompt = (await detectOtpPrompt(page)) ?? "Enter the OTP sent by the portal";
      await updateJob(sid, { awaiting_otp: true, otp_prompt: prompt, current_step: "awaiting_form_otp" });
      const otp = await waitForOtp(sid, OTP_WAIT_MS);
      await updateJob(sid, { otp_value: null, awaiting_otp: false, current_step: "verifying_form_otp" });
      return otp;
    });

    const shot = await page.screenshot({ fullPage: true });
    if (outcome.ok) {
      await updateJob(sid, {
        status: "completed",
        current_step: "completed",
        success_detected_at: new Date().toISOString(),
        screenshot_base64: shot.toString("base64"),
        next_action: "Job application submitted automatically by the runner.",
        ...(outcome.reference ? { submission_reference: outcome.reference } : {}),
      });
      console.log(`[job:${sid}] SUBMITTED ref=${outcome.reference ?? "n/a"}`);
    } else {
      await updateJob(sid, {
        status: outcome.blocker === "fee_payment" ? "awaiting_fee" : "awaiting_human_action",
        current_step: `blocked_${outcome.blocker}`,
        blocker: outcome.blocker,
        portal_url: applyUrl,
        screenshot_base64: shot.toString("base64"),
        next_action: `${outcome.blocker}: ${outcome.detail}. Clear it on ${job.posting.portal ?? "the portal"} — the runner resumes and submits automatically.`,
        ...(resumeUrl ? { resume_url: resumeUrl } : {}),
      });
      console.log(`[job:${sid}] BLOCKED ${outcome.blocker}`);
    }

  } catch (e) {
    console.error(`[job:${sid}] error`, e);
    await updateJob(sid, { status: "failed", error_log: String(e) });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runOneJob(): Promise<boolean> {
  const job = await claim();
  if (!job) { console.log("no job"); return false; }

    if (job.type === "freelancer_gig") {
      await withTimeout(
        processFreelancerGig(job),
        PER_JOB_TIMEOUT_MS,
        async () => { await updateGig(job.id, { status: "awaiting_login", error_log: "runner timeout — handoff" }); },
      );
    } else if (job.type === "job_application") {
      await withTimeout(
        processJobApplication(job),
        PER_JOB_TIMEOUT_MS,
        async () => {
          console.error(`[job:${job.session_id}] TIMEOUT — requeuing`);
          await updateJob(job.session_id, {
            status: "failed",
            error_log: `Runner hard-timeout at ${PER_JOB_TIMEOUT_MS}ms — auto-requeued`,
          });
        },
      );
    } else {
      await withTimeout(
        processJob(job),
        PER_JOB_TIMEOUT_MS,
        async () => {
          const current = await fetchSessionStatus(job.session_id);
          if (current === "awaiting_otp" || current === "awaiting_human_action" || current === "completed") {
            console.log(`[${job.session_id}] timeout reached but session is '${current}' — leaving as-is`);
            return;
          }
          console.error(`[${job.session_id}] TIMEOUT after ${PER_JOB_TIMEOUT_MS}ms — requeuing with backoff`);
          await update(job.session_id, {
            status: "queued",
            current_step: "requeued_after_runner_timeout",
            runner_id: null,
            claimed_at: null,
            next_retry_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            error_log: `Runner hard-timeout at ${PER_JOB_TIMEOUT_MS}ms — auto-requeued`,
          });
        },
      );
    }
  return true;
}

// Continuous worker: keep claiming and finishing sessions until the run
// deadline. A worker never stops mid-session — the deadline is only checked
// between jobs, and PER_JOB_TIMEOUT_MS still guards a hung portal.
const RUN_BUDGET_MS = Number(process.env.RUNNER_RUN_BUDGET_MS ?? 50 * 60 * 1000);
const IDLE_SLEEP_MS = 15_000;

async function main() {
  await resolveBase();
  console.log(`GovSchemeOS runner ${RUNNER_ID} started (headless=${HEADLESS}), polling ${APP}, budget ${RUN_BUDGET_MS}ms`);
  const deadline = Date.now() + RUN_BUDGET_MS;
  let done = 0;
  let idleRounds = 0;

  while (Date.now() + PER_JOB_TIMEOUT_MS < deadline) {
    try {
      const worked = await runOneJob();
      if (worked) { done++; idleRounds = 0; continue; }
      idleRounds++;
      if (idleRounds >= 4) break; // queue drained
      await new Promise((r) => setTimeout(r, IDLE_SLEEP_MS));
    } catch (e) {
      console.error("worker loop error", e);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  console.log(`runner ${RUNNER_ID} finished — ${done} sessions processed`);
}

main();



