# GovSchemeOS — Autofill Runner

External Playwright runner that pairs with the GovSchemeOS app.

## Why this lives outside the app

Playwright needs a real Chromium binary and a long-lived process — neither
exists on Cloudflare Workers (where the app runs). This folder is deployed
independently to any Node host: your Oracle Cloud ARM VM, a laptop, a
DigitalOcean droplet, or even a Raspberry Pi with a display.

## What it does

1. Polls `POST /api/public/runner/claim` on your app every 15 seconds.
2. When a queued autofill session is returned, launches a **headed** Chromium
   window with `--remote-debugging-port=9222`.
3. Fills every field per the recorded `field_map_json`.
4. Attaches every current document (downloaded from short-lived signed URLs).
5. Screenshots the fully-filled form, uploads it back, and marks the session
   `awaiting_human_action`.
6. The app sends you email/WhatsApp/push. You open the browser via
   Tailscale + noVNC (or physically), tap OTP / plug in DSC, click Submit.
7. The runner never touches `submit_button_selector`. Hard-coded, not a
   config toggle.

## Install

```bash
cd automation
bun install
bunx playwright install chromium
```

## Configure

Create `automation/.env`:

```env
APP_BASE_URL=https://project--4c40a0f5-5a99-4ee7-ae1f-360884387fc6.lovable.app
RUNNER_SHARED_SECRET=<same value stored in Cloud secrets as RUNNER_SHARED_SECRET>
RUNNER_ID=oracle-arm-1
# Optional: public URL where noVNC exposes the runner display, one placeholder
# per session id if you want per-session resume links.
RESUME_URL_TEMPLATE=https://vnc.yourdomain.com/session/{session_id}
```

The shared secret lives in Cloud → Secrets. Retrieve it once and paste into
this .env; both sides must match.

## Run

```bash
bun run runner
```

Or as a systemd service (see `systemd-runner.service`):

```bash
sudo cp systemd-runner.service /etc/systemd/system/govschemeos-runner.service
sudo systemctl enable --now govschemeos-runner
sudo journalctl -u govschemeos-runner -f
```

## Handoff pattern

The runner keeps the Chromium instance alive with remote debugging on port
9222. Two ways to complete the manual step:

- **noVNC + Tailscale**: expose the VM's display over a private mesh; open
  the same browser tab from your phone. This is the setup the spec
  presumes.
- **Physical machine**: if the runner is on your laptop, the browser window
  is already on your screen — just switch to it.

The `RESUME_URL_TEMPLATE` you set in `.env` becomes the "Open runner
browser" button in the app.
