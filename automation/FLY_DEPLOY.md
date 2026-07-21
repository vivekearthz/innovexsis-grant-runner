# Deploying the runner to Fly.io

The autofill runner is a long-lived polling worker. Fly.io runs it as a
background machine — no public HTTP, no exposed port.

## One-time setup

1. **Install Fly CLI** on your laptop
   - macOS: `brew install flyctl`
   - Linux/WSL: `curl -L https://fly.io/install.sh | sh`
   - Windows: `iwr https://fly.io/install.ps1 -useb | iex`

2. **Sign up / log in** (free, credit card required for verification but the
   free allowance covers this worker)
   - Sign up: <https://fly.io/app/sign-up>
   - Then in your terminal: `fly auth login`

3. **Clone your repo** locally
   ```bash
   git clone https://github.com/vivekearthz/grant-wizardry-26.git
   cd grant-wizardry-26/automation
   ```

4. **Create the Fly app** (only the first time)
   ```bash
   fly launch --no-deploy --copy-config --name govschemeos-runner
   ```
   Pick a region close to India: `bom` (Mumbai), `sin` (Singapore), or `fra`
   (Frankfurt). If prompted about Postgres/Redis, say **No** to both.

5. **Set secrets** — get `RUNNER_SHARED_SECRET` from your Lovable Cloud
   secrets page, then run:
   ```bash
   fly secrets set \
     APP_BASE_URL=https://grant-wizardry-26.lovable.app \
     RUNNER_SHARED_SECRET='<paste-here>' \
     RUNNER_ID=fly-bom-1
   ```
   Secrets are encrypted at rest and injected as env vars at runtime.

6. **Deploy**
   ```bash
   fly deploy
   ```

## Verify it's running

```bash
fly logs             # tail the runner's stdout
fly status           # machine health
fly ssh console      # shell into the machine
```

You should see log lines like `[runner] polling for jobs...` every 15s.

## Trigger a test job

1. In the app, sign in as `vivekearthz@gmail.com`
2. Go to **Applications → New**, pick **Udyam Registration**, submit
3. The Fly runner claims the job within 15s, fills the mock portal, and pauses
   at OTP
4. Open `/applications/{id}/otp` on your phone, enter `424242`
5. Runner completes and marks the session done

## Updating

Any push to `main` doesn't auto-deploy. To ship runner changes:

```bash
cd automation
fly deploy
```

## Cost

- 1 × `shared-cpu-1x` (512MB): ~$3.19/mo if outside free allowance
- Fly's free allowance: 3 shared-cpu-1x machines + 3GB storage
- Egress: free up to 100GB/mo (this runner uses <1GB)

**Effective cost: $0/mo** for a single runner.

## Troubleshooting

- **Chromium OOM killed**: bump memory in `fly.toml` to `1024mb`, then
  `fly deploy`
- **401 from claim endpoint**: `RUNNER_SHARED_SECRET` mismatch — re-check
  with `fly secrets list` and Lovable Cloud secrets page
- **Machine stopped**: `fly machine start <machine-id>` (get id from
  `fly status`)
