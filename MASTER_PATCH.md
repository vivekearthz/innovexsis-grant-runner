# MASTER PATCH v70 — Version Convergence + Shared Email/WhatsApp Capacity

Mandatory for the master portal, every sub-portal and every slave portal owned by
vivekearthz (vivekearthz@gmail.com). Master wins on every conflict. This bundle
supersedes v59 and folds in everything authored between v60 and v70.

## 1. ONE version constant (root cause of the "stuck at v59" drift)

1. No portal may hard-code a patch/policy version string anywhere. The single
   source of truth is `src/lib/fleet-version.ts`
   (`FLEET_PATCH_VERSION`, `FLEET_VERSION_NUMBER`).
2. `/api/public/portal/version` MUST report that constant, never a literal.
3. Version comparison is NUMERIC. A portal already ahead of the master is never
   downgraded; only portals strictly behind are re-patched.
4. The daily orchestrator re-dispatches the current bundle to every portal whose
   reported version is behind, with retry + backoff, and re-verifies by loopback
   against the live deployment (not just the GitHub commit).

## 2. Inherited mandates v60 - v69 (unchanged, restated for slaves)

- v60/v61 Shared fleet model registry + weekly free-LLM catalogue refresh.
- v62 Permissive-license service inheritance (interview copilot family).
- v63 Fleet service cross-reference: internal-first reuse is enforced in the UI.
- v64 Autonomous YouTube Shorts automation agent.
- v65 Master workspace / repo / host identity re-announcement.
- v66 Commerce + customer-journey parity (pricing, checkout, post-payment
  hand-off, logout) on every portal.
- v67 Continuous parity + 3-strike escalation with weekly deep sweep.
- v68 Total Lovable independence (AI **and** Cloud lanes).
- v69 Shared fleet email authority: master-owned provider keys only.

## 3. Email capacity is POOLED, never single-provider

1. Slaves hold NO email provider keys. They relay through the master.
2. Daily email capacity reported anywhere (dashboards, digests, pre-flight
   reports) MUST be the POOLED free allowance across every configured provider
   — Brevo, SendPulse, Mailjet, MailerSend, SendGrid, Elastic Email, SMTP2GO —
   not the first provider's 300/day.
3. Rotation stays quota-aware: providers at their daily allowance are skipped,
   the rest are ordered by load ratio.

## 4. WhatsApp reinstatement ramp target = 750/day

1. The post-reinstatement ramp ends at the configured target
   (`WA_MARKETING_DAILY_TARGET`, default **750**) instead of stalling at an
   intermediate ladder rung.
2. Once the ramp days exceed the ladder, the target cap applies permanently
   while quality stays green.
3. Hourly pacing must be able to deliver the target inside the send window;
   the hourly cap default rises with the target.
4. OTP / auth / service replies are never throttled by these caps.

## 5. Self-healing

- Version drift, capacity drift and email-key drift are all repaired by the
  daily 02:30 IST orchestrator with retry + backoff and owner escalation after
  3 consecutive failures. No human step is ever required.


<!-- applied-by: MARTECH master | version: v70 | reason: cron:fleet-identity-drift | at: 2026-08-26T02:29:07.317Z -->
