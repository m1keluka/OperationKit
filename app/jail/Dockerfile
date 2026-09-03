# ─────────────────────────────────────────────────────────────────────────────
# ok-jail — the per-session sandbox image (PRD §6.4).
#
# Built and run ONLY when SESSION_ISOLATION=docker. Mike's live droplet leaves
# that flag unset, so nothing here is on the production path today.
#
# Deliberately does NOT inherit from app/Dockerfile: the control-plane image
# carries the docker CLI, root-owned paths and operator tooling, none of which
# may exist inside a jail. This file starts from a clean base for that reason.
#
# Build:  docker build -t ok-jail:local -f app/jail/Dockerfile app/jail
# Pin:    tag by digest and set SESSION_JAIL_IMAGE=ok-jail@sha256:… in any real
#         deployment. There is no registry push — publishing to ghcr.io is a
#         Mike-reserved open question (PRD §9), so the default tag is local.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# bash + tmux (session persistence lives INSIDE the jail — PRD §6.3),
# git + gh (the worker's only integration path is a PR),
# ca-certificates/curl for outbound HTTPS. Node comes from the base image.
#
# NOT installed, on purpose: docker.io / docker-ce-cli / containerd. A jail that
# can talk to a socket it should never see is not a jail; keeping the client out
# of the image is defence in depth behind "the socket is not mounted".
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      tmux \
      git \
      curl \
      ca-certificates \
      less \
      procps \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# The Claude CLI the session actually runs.
RUN npm install -g @anthropic-ai/claude-code tsx && npm cache clean --force

# Non-root jail user, UID >= 1000, no sudo, not in any docker group.
# The node base image already owns uid 1000, so jailuser takes 1001 and the
# control plane passes --user explicitly (SESSION_JAIL_USER / default 1000:1000
# is overridable per deployment).
RUN groupadd --gid 1001 jailuser \
    && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash jailuser \
    && mkdir -p /workspace && chown jailuser:jailuser /workspace

# Assert at build time that no docker client leaked in via a transitive dep.
RUN if command -v docker >/dev/null 2>&1; then echo "FATAL: docker CLI present in jail image" >&2; exit 1; fi

USER jailuser
WORKDIR /workspace

# The control plane passes an explicit command (tmux new-session + a wait loop).
# This default keeps a hand-run container alive for inspection.
CMD ["bash", "-lc", "sleep infinity"]
