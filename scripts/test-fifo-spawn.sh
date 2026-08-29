#!/bin/bash
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY
export HOME=/home/ccuser-c
export USER=ccuser
export TERM=dumb
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd "${HOME:-/home/operator}"

FIFO=/tmp/test-fifo6
PROMPT=/tmp/test-prompt6.json
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"say hello"}]}}' > "$PROMPT"
chmod 666 "$PROMPT"

rm -f "$FIFO"
mkfifo "$FIFO"
chmod 666 "$FIFO"

claude --print --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions --max-budget-usd 50 < "$FIFO" > /tmp/test6.jsonl 2> /tmp/test6.stderr &
CPID=$!
exec 3>"$FIFO"
cat "$PROMPT" >&3
rm -f "$PROMPT"
echo "PID=$CPID" > /tmp/test6.log
wait $CPID
echo "EXIT=$?" >> /tmp/test6.log
exec 3>&-
rm -f "$FIFO"
