#!/usr/bin/env bash
# session-jail-proof.sh — LIVE fail-closed proof for the per-session sibling jail.
#
# obj 709072 (parent 708982). Runs two real sibling containers (jail A and jail B)
# and asserts the 7-row isolation matrix. This is evidence, not a mock: every row
# is the exit code of a command executed INSIDE a jail. Nothing here is stubbed —
# if docker is unreachable the script fails LOUDLY at PRECHECK and prints the raw
# daemon error rather than reporting a pass.
#
#   usage: bash scripts/session-jail-proof.sh [IMAGE]
#   default IMAGE: debian:bookworm-slim
#
# It deliberately uses a stock base image so the result is about mounts and caps,
# not about our application image.

set -uo pipefail

IMAGE="${1:-debian:bookworm-slim}"
A_DIR=/tmp/ok-jail-proof-a
B_DIR=/tmp/ok-jail-proof-b
A=ok-jail-w8a
B=ok-jail-w8b
PASS=0; FAIL=0

row()  { printf '\n--- ROW %s: %s ---\n' "$1" "$2"; }
ok()   { PASS=$((PASS+1)); printf 'RESULT: PASS (%s)\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'RESULT: FAIL (%s)\n' "$1"; }

cleanup() { docker rm -f "$A" "$B" >/dev/null 2>&1 || true; }

echo "=== PRECHECK: docker reachable? ==="
if ! docker version --format '{{.Server.Version}}' 2>&1; then
  echo
  echo "BLOCKED: the docker daemon is not reachable from this account. Raw error above."
  echo "id: $(id)"
  ls -ln /var/run/docker.sock 2>&1 || true
  echo "This is a hard blocker for the live proof. Do NOT report the matrix as passing."
  exit 2
fi

trap cleanup EXIT
cleanup

echo
echo "=== SETUP: host stand-in worktrees ==="
rm -rf "$A_DIR" "$B_DIR"; mkdir -p "$A_DIR" "$B_DIR"
echo "secret-A-$(date -u +%s)" > "$A_DIR/A.txt"
echo "secret-B-$(date -u +%s)" > "$B_DIR/B.txt"
chmod -R 0777 "$A_DIR" "$B_DIR"
ls -la "$A_DIR" "$B_DIR"

echo
echo "=== IMAGE: $IMAGE ==="
docker pull "$IMAGE"
docker image inspect "$IMAGE" --format 'RepoDigests: {{join .RepoDigests ","}}{{"\n"}}Id: {{.Id}}'

run_jail() {  # $1=name $2=hostdir
  set -x
  docker run -d \
    --name "$1" \
    --user 1000:1000 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    -v "$2:/workspace:rw" \
    -w /workspace \
    "$IMAGE" sleep infinity
  set +x
}

echo
echo "=== CREATE JAILS ==="
run_jail "$A" "$A_DIR" || { echo "jail A failed to start"; exit 3; }
run_jail "$B" "$B_DIR" || { echo "jail B failed to start"; exit 3; }
docker ps --filter "name=ok-jail-" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

jexec() { docker exec "$1" sh -lc "$2"; }

row 1 'test -e /var/run/docker.sock inside jail A must FAIL'
jexec "$A" 'test -e /var/run/docker.sock; echo "exit=$?"'
jexec "$A" 'test -e /var/run/docker.sock'; rc=$?
echo "exit code: $rc"
[ "$rc" -ne 0 ] && ok "docker.sock absent" || bad "docker.sock VISIBLE inside jail"

row 2 'docker ps inside jail A must not list host containers'
jexec "$A" 'docker ps 2>&1; echo "exit=$?"'
jexec "$A" 'docker ps' >/dev/null 2>&1; rc=$?
echo "exit code: $rc"
[ "$rc" -ne 0 ] && ok "no docker client / no daemon access" || bad "jail listed host containers"

row 3 '/home/mike must not exist inside jail A (incl DECOY-ok-jail.txt)'
jexec "$A" 'ls -la /home/mike 2>&1; echo "exit=$?"'
jexec "$A" 'test -e /home/mike'; rc=$?
echo "exit code (test -e /home/mike): $rc"
jexec "$A" 'cat /home/operator/DECOY-ok-jail.txt 2>&1; echo "exit=$?"'
jexec "$A" 'cat /home/operator/DECOY-ok-jail.txt' >/dev/null 2>&1; rc2=$?
echo "exit code (cat DECOY): $rc2"
[ "$rc" -ne 0 ] && [ "$rc2" -ne 0 ] && ok "operator home unmounted (dir absent + decoy inaccessible)" || bad "operator home VISIBLE or decoy leaked"

row 4 'jail A can read its own /workspace/A.txt'
jexec "$A" 'cat /workspace/A.txt; echo "exit=$?"'
jexec "$A" 'cat /workspace/A.txt' >/dev/null 2>&1; rc=$?
echo "exit code: $rc"
[ "$rc" -eq 0 ] && ok "own worktree readable" || bad "own worktree NOT readable"

row 5 'jail A can write /workspace/from-jail.txt and the host sees it'
jexec "$A" 'echo jailed > /workspace/from-jail.txt; echo "exit=$?"'
echo "host view:"; cat "$A_DIR/from-jail.txt" 2>&1; rc=$?
echo "exit code: $rc"
[ "$rc" -eq 0 ] && ok "own worktree writable, visible on host" || bad "write did not reach host"

row 6 "jail A must NOT read jail B's worktree ($B_DIR / B.txt)"
jexec "$A" "cat $B_DIR/B.txt 2>&1; echo exit=\$?"
jexec "$A" "cat $B_DIR/B.txt" >/dev/null 2>&1; rc1=$?
jexec "$A" "ls -la $B_DIR 2>&1; echo exit=\$?"
jexec "$A" "ls $B_DIR" >/dev/null 2>&1; rc2=$?
jexec "$A" 'ls -la /workspace; echo "--- B.txt in own mount? ---"; test -e /workspace/B.txt; echo "exit=$?"'
jexec "$A" 'test -e /workspace/B.txt' >/dev/null 2>&1; rc3=$?
echo "exit codes: cat=$rc1 ls=$rc2 own-mount-has-B=$rc3"
if [ "$rc1" -ne 0 ] && [ "$rc2" -ne 0 ] && [ "$rc3" -ne 0 ]; then
  ok "cross-jail read denied"
else
  bad "jail A could see jail B"
fi
echo "control: jail B CAN read its own B.txt ->"
jexec "$B" 'cat /workspace/B.txt; echo "exit=$?"'

row 7 'teardown leaves no ok-jail-* containers'
cleanup
docker ps -a --filter 'name=ok-jail-' --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}'
LEFT=$(docker ps -a --filter 'name=ok-jail-' --quiet | wc -l)
echo "leftover count: $LEFT"
[ "$LEFT" -eq 0 ] && ok "no leftovers" || bad "$LEFT leftover container(s)"

echo
echo "==================== SUMMARY ===================="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
