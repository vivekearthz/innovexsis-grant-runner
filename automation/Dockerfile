# GovSchemeOS Autofill Runner — Fly.io headless deployment
# Uses Playwright's official image which ships Chromium + all system deps.
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

# Install Bun
RUN apt-get update && apt-get install -y curl unzip \
  && curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy runner source
COPY . .

# Headless mode is mandatory on Fly (no display)
ENV RUNNER_HEADLESS=1 \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Runner is a long-lived poller — no exposed port needed
CMD ["bun", "run", "autofill-runner.ts"]
