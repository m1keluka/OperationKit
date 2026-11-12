/**
 * kb-access-prompt (obj 900204) — the knowledge-base paragraph of a spawn
 * prompt, told the truth about what THIS session can actually reach.
 *
 * In `tmux` mode a session runs inside the app container and `~/second-brain`
 * is right there, so the text is byte-identical to what it always was.
 *
 * In `docker` mode (`SESSION_ISOLATION=docker`) the session is a sibling
 * container with only its worktree and its own HOME mounted — `~/second-brain`
 * does not exist, and neither does any host vault path it could guess. Telling
 * it to look there is what made cards report "Connections.csv is not in the
 * KB" for a file that was plainly there. In that mode the prompt points at the
 * permission-checked HTTP interface the session CAN reach: the control plane on
 * its loopback forwarder, authenticated with `$CC_SESSION_TOKEN`, scoped by the
 * server to this card's own workspace.
 */
import type { Objective } from '@operationkit/shared'
import { jailEnabled } from './session-jail.js'
import { resolveWriteWorkspace } from './workspaces.js'

export const CC_API = 'http://localhost:3002'

/** Workspace-relative decisions folder, used by both modes. */
function decisionsRel(workspace: string | null | undefined): string {
  return !workspace || workspace === 'personal' ? 'personal/decisions' : `workspaces/${workspace}/decisions`
}

/** The vault path a NON-jailed session writes decision docs to (unchanged). */
export function vaultDecisionsPath(workspace: string | null | undefined): string {
  return `~/second-brain/${decisionsRel(workspace)}/`
}

/**
 * The "where is the knowledge base" block.
 * @param jailed pass the resolved isolation mode; defaults to this process's env.
 */
export function buildKbAccessBlock(
  objective: Pick<Objective, 'id' | 'workspace'>,
  jailed: boolean = jailEnabled(),
): string[] {
  const ws = resolveWriteWorkspace(objective.workspace)
  if (!jailed) {
    return ['', 'Knowledge base is at ~/second-brain/ for reference.']
  }
  return [
    '',
    '## Knowledge base (READ THIS BEFORE LOOKING FOR A FILE)',
    '',
    `This session is sandboxed: the ONLY paths on disk are your worktree (\`/workspace\`) and your own HOME (\`/home/jailuser\`). **There is no \`~/second-brain\`, no \`/home/operator\`, and no vault mount — do not look for one, and never guess a host path.**`,
    '',
    `The knowledge base reaches you over the control plane instead, already scoped to your workspace (\`${ws}\`). Authenticate every call with \`$CC_SESSION_TOKEN\`; you cannot see any other workspace, and you do not need to pass a workspace parameter.`,
    '',
    '```bash',
    'H="X-CC-Session-Token: $CC_SESSION_TOKEN"',
    '',
    '# 1. Find a NON-markdown file (csv, xlsx, pdf, pptx, images):',
    `curl -sG "${CC_API}/api/files/search" -H "$H" --data-urlencode 'q=connections' --data-urlencode 'ext=csv'`,
    '',
    '# 2. Check it before you pull it (size, mtime, mime):',
    `curl -sG "${CC_API}/api/files/stat" -H "$H" --data-urlencode 'path=<absolute path from the search hit>'`,
    '',
    '# 3. Download it into your workspace (Range works, so do a head first on big files):',
    `curl -s "${CC_API}/api/files/download?path=<path>" -H "$H" -o /workspace/local-copy.csv`,
    `curl -s "${CC_API}/api/files/download?path=<path>" -H "$H" -H 'Range: bytes=0-20000' -o /workspace/head.csv`,
    '',
    '# 4. Markdown notes — search, read, list:',
    `curl -sG "${CC_API}/api/docs/search" -H "$H" --data-urlencode 'q=linkedin export'`,
    `curl -sG "${CC_API}/api/docs/file" -H "$H" --data-urlencode 'path=<absolute .md path>'`,
    `curl -s "${CC_API}/api/docs/tree" -H "$H"`,
    '```',
    '',
    'Reading the error correctly matters:',
    '- **404** — the path is inside your workspace and genuinely does not exist. Stop looking; it is not there.',
    '- **403** — the path exists outside what this card may see (another workspace, a system file, a denied path). It is NOT evidence about whether the file exists. Never report "not in the knowledge base" on a 403 — say it is out of scope for this card.',
    '- **401** — your token is missing or stale. `echo "${CC_SESSION_TOKEN:+set}"`; if it is empty, say so rather than guessing paths.',
    '',
    'A file you pulled is a COPY in your sandbox. Editing it changes nothing in the knowledge base.',
  ]
}

/**
 * The vault-capture instruction, likewise mode-aware. A jailed session writes
 * its decision doc through `PUT /api/docs/file` — the same permission-checked
 * surface — instead of a path it cannot see.
 */
export function buildVaultCaptureBlock(
  objective: Pick<Objective, 'id' | 'workspace'>,
  jailed: boolean = jailEnabled(),
): string[] {
  const ws = objective.workspace
  const rel = decisionsRel(ws)
  const head = [
    '',
    '## Vault Capture (MANDATORY before you finish)',
    '',
    'If this session produced any architectural decision, evaluation outcome, research finding,',
    'tradeoff resolved, or non-obvious learning that future sessions would benefit from, you MUST',
  ]
  const tail = [
    '',
    'If nothing in this session qualifies (e.g. routine bug fix, mechanical cleanup, no choices',
    'made), explicitly state in your final response: "No vault capture: <one-line reason>".',
    'Do NOT silently skip — the orchestrator now flags `capture-gap` when decisions are claimed',
    'in the summary but no `/decisions/*.md` write occurred.',
  ]
  if (!jailed) {
    return [
      ...head,
      `write a decision doc to ${vaultDecisionsPath(ws)}YYYY-MM-DD-<slug>.md before ending the session.`,
      '',
      'Use the template at ~/ai-workspace/protocols/vault-capture.md (frontmatter + Decision /',
      'Context / Rationale / Alternatives / Implications sections).',
      ...tail,
    ]
  }
  return [
    ...head,
    `write a decision doc before ending the session. You are sandboxed, so write it through the`,
    `control plane — there is no \`~/second-brain\` on this filesystem. Ask the API where your`,
    `workspace's knowledge folder is, then PUT the file into its \`${rel.split('/').pop()}/\` subfolder:`,
    '',
    '```bash',
    'H="X-CC-Session-Token: $CC_SESSION_TOKEN"',
    `KB=$(curl -s "${CC_API}/api/docs/tree" -H "$H" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).root')`,
    `curl -s -X PUT "${CC_API}/api/docs/file" -H "$H" -H 'Content-Type: application/json' \\`,
    `  -d "$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({path:process.argv[1]+"/decisions/"+process.argv[2],content:fs.readFileSync(process.argv[3],"utf8"),create_dirs:true}))' "$KB" "$(date -u +%F)-<slug>.md" /workspace/decision.md)"`,
    '```',
    '',
    'Write the doc body to `/workspace/decision.md` first (frontmatter + Decision / Context /',
    'Rationale / Alternatives / Implications sections), then PUT it as above. A `{"ok":true,...}`',
    'response is your evidence that the capture landed; anything else means it did NOT.',
    ...tail,
  ]
}
