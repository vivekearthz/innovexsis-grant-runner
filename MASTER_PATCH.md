# MASTER PATCH v59 — Repo Name Policy + IMSP JSON Channel

Master: MARTECH (marcomm) · canonical registry repo: `vivekearthz/martech-fleet-registry`
Master host: https://martech.innovexsis.com
Audience: the master portal, every sub-portal and every slave portal owned by
vivekearthz (vivekearthz@gmail.com). Master wins on every conflict. Supersedes
v58 and every earlier patch (all earlier rules still apply).

## 0. Single canonical master pointer (new in this rollout)

1. `.guardian/identity.json` MUST carry `masterRepo: "vivekearthz/martech-fleet-registry"` and
   `masterHost: "https://martech.innovexsis.com"`. Any other master repository pointer is STALE and
   is overwritten automatically.
2. `patchVersion` MUST equal `v59`. Lower values are force-upgraded
   by the 24-hourly fleet repoint guard with retry + backoff.
3. The public `/api/public/portal/version` handshake MUST report the same
   `patchVersion` as `.guardian/identity.json` — drift there is a defect.

## 1. GitHub repository naming policy (zero human intervention)

1. A repository name MUST equal the Lovable project name, slugified
   (lowercase, non-alphanumeric -> "-", max 90 chars). Random Lovable shells
   such as `my-secret-automagic-0ad5a80b` are NON-COMPLIANT.
2. Non-compliant repos are RENAMED in place via `PATCH /repos/{owner}/{repo}`.
   Never create a duplicate repo, never ask a human to rename anything.
3. If the canonical name is occupied by a different repository, the incumbent is
   RETIRED FIRST by renaming it to `old-DDMMYY-<name>` (UTC date).
4. Orphan random-named repos that no active portal claims are retired the same way.
5. `portal_registry.github_repo` is repaired after every rename; legacy links are
   archived to `audit_logs` / `audit_events` and the admin ledger shows CURRENT repos only.
6. Enforcement runs every 24 hours plus inside the daily fleet orchestrator, then
   triggers a fleet republish.

## 2. IMSP — Inter-Master Slave Protocol (JSON)

Master serves IMSP JSON on:

- `POST /api/portal-sync`
- `POST /api/public/portal-sync`
- `POST /api/imsp/{action}`
- `POST /api/public/imsp/{action}`

Actions: `sync` (default), `instructions`, `patch`, `report`, `ack`,
`heartbeat`, `capabilities`, `ping` (unauthenticated health probe).

Auth: `X-Sync-Signature: hmac_sha256(MASTER_SYNC_SECRET, rawBody)`.
Body: `{ "portal_key": "<slave key>", "action": "sync", "patch_version": "v59" }`.
Every authenticated call updates `last_event_at` + `sync_status`, so a sync is
also a heartbeat. Slaves MUST treat any HTML response as a transport failure and
retry against the next alias with exponential backoff.

## 3. Slave requirements

- Keep the born-wired `/api/public/portal/sync-now` receiver.
- Report code inventory and command acks to the master IMSP `report` / `ack`
  actions; never assume pull-only sync.
- Do not rename your own GitHub repo; the master owns naming.
- Do not depend on Lovable credits: the free-first AI ladder of v57 stays in force.

<!-- applied-by: MARTECH master | version: v59 | channel: fleet-repoint-guard -->
