FROM node:26-bookworm-slim AS base

# Install system deps: tmux for session management, build tools for node-pty
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    python3 \
    make \
    g++ \
    git \
    curl \
    ca-certificates \
    openssh-client \
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

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

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
# `npx @playwright/mcp@latest` is a no-download invocation at runtime.
# `--with-deps chromium` apt-installs the X11/font/audio libs Chromium needs.
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright
RUN npm install -g playwright @playwright/mcp \
  && npx playwright install --with-deps chromium \
  && chmod -R a+rX /usr/local/share/playwright \
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
ENV DB_PATH=/app/data/command-center.db

CMD ["tsx", "server/src/index.ts"]
