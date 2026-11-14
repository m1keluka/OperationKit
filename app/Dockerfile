FROM node:22-bookworm-slim AS base

# Install system deps: tmux for session management, build tools for node-pty
# poppler-utils = pdftotext, for better PDF text in knowledge-base file import
# (obj 719936). Optional: the built-in PDF reader is used when it is missing.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    python3 \
    make \
    g++ \
    git \
    curl \
    ca-certificates \
    openssh-client \
    poppler-utils \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI for PR creation from sessions
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Docker CLI — lets sessions run host commands via docker exec
RUN curl -fsSL https://get.docker.com | sh 2>/dev/null || \
  (apt-get update && apt-get install -y docker.io && rm -rf /var/lib/apt/lists/*)

# Doppler CLI is unused at runtime (native secrets store). Left installed so
# this layer does not force an image rebuild. Remove on the next rebuild.
RUN curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sh

# Git identity for session commits
RUN git config --system user.name "Command Center" \
  && git config --system user.email "dev@example.com" \
  && git config --system push.autoSetupRemote true

# Create non-root user for Claude Code sessions
RUN useradd -m -s /bin/bash ccuser

# Install Claude Code CLI globally.
# VERSION FLOOR (2026-09-23, obj 712520): >=2.1.280. Older CLIs reject the current
# model lineup with `400 ... does not support this model; version 2.1.280 or newer
# is required` — and because every spawn carries --fallback-model, that 400 is NOT
# visible as a failure: the session silently runs the whole objective on Sonnet.
# The registry default is claude-opus-5-5, so this floor is load-bearing, not
# cosmetic. Raise it whenever a newer model is promoted in db/schema/models.ts.
RUN npm install -g @anthropic-ai/claude-code@^2.1.280

# OpenAI Codex CLI — alternate engine for objectives with model='codex'.
# Auth is NOT baked in: ~/.codex/auth.json lives in the mounted
# /home/ccuser-codex home dir (ChatGPT subscription OAuth).
RUN npm install -g @openai/codex

# Grok Build CLI — engine for objectives with model grok-4.6.
# Auth is XAI_API_KEY (Doppler/env) and/or `grok login` under GROK_HOME_DIR.
# GROK_BIN_DIR puts the binary on the ccuser PATH used at spawn
# (/usr/local/bin) instead of /root/.grok/bin.
ENV GROK_BIN_DIR=/usr/local/bin
# The installer symlinks /usr/local/bin/grok → /root/.grok/downloads/… which
# ccuser cannot exec (root home is 0700). Flatten to a world-exec copy.
RUN curl -fsSL https://x.ai/cli/install.sh | bash \
  && grok --version \
  && cp -L /usr/local/bin/grok /usr/local/bin/grok.real \
  && chmod 755 /usr/local/bin/grok.real \
  && ln -sfn /usr/local/bin/grok.real /usr/local/bin/grok

# Playwright + Chromium for in-session browser verification.
# Browsers cache to a shared path so all ccuser-* accounts use one install
# (~600MB once vs per-user). The @playwright/mcp package is the MCP server
# that Claude Code sessions speak to; installing it globally means
# `npx @playwright/mcp@<pinned>` is a no-download invocation at runtime.
# `--with-deps chromium` apt-installs the X11/font/audio libs Chromium needs.
#
# PINNED (obj 900024). These two ARGs are the ONLY place the versions are
# written besides app/server/src/lib/browser-pins.ts, and
# `browser-pins.test.ts` fails the gate if the two disagree — so an update is
# one deliberate edit in two files, never a silent drift at `npm install` time.
# To update: see "Updating the card browser" in docs/wiki/Card-Browser-Lockdown.md.
ARG PLAYWRIGHT_VERSION=1.65.0
ARG PLAYWRIGHT_MCP_VERSION=0.0.85
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
  && npx "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
  && chmod -R a+rX /usr/local/share/playwright \
  # Chromium's setuid sandbox helper. The card browser runs as a non-root
  # `ccuser-*` account, and WITH the sandbox on (obj 900024) — so chrome_sandbox
  # has to be root-owned and setuid, which `playwright install` does not do.
  # Without this, a sandboxed Chromium fails to launch rather than falling back,
  # which is the correct direction to fail but a confusing one to debug.
  # Belt and braces: where unprivileged user namespaces are available Chromium
  # uses those instead and never touches this binary.
  && for s in /usr/local/share/playwright/chromium-*/chrome-linux64/chrome_sandbox \
              /usr/local/share/playwright/chromium-*/chrome-linux/chrome_sandbox; do \
       [ -f "$s" ] && chown root:root "$s" && chmod 4755 "$s" || true; \
     done \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for caching
COPY package.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm install

# Copy source code
COPY . .

# Build frontend
RUN npm run build --workspace=client

# Install tsx globally for running TypeScript server
RUN npm install -g tsx

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3002

ENV NODE_ENV=production
ENV PORT=3002
# Which commit this image was built from (obj 720210): shown by /api/health and
# the Settings footer. install.sh passes it; last so it never busts the cache above.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
ENV DB_PATH=/app/data/command-center.db

CMD ["tsx", "server/src/index.ts"]
