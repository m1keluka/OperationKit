<!-- Keep this short. The "What's shipping" section feeds the stakeholder changelog. -->

## What's shipping

<!-- 1-3 plain-English sentences for non-technical stakeholders: what changed and who benefits. No code or jargon. Leave blank only for pure internal/infra changes. -->



## Details

<!-- Engineering notes, context, how to test. -->



## Checklist

- [ ] Add a category label so this lands in the right changelog bucket: `changelog:feature` / `changelog:fix` / `changelog:improvement` / `changelog:infra` (or `skip-changelog` for internal-only changes)
- [ ] Tests / verification done
- [ ] **Spawn-env key set change?** If `buildSpawnEnv()` / `secrets-store.ts` adds or removes keys, regenerate `~/ai-workspace/scripts/spawn-env-keys.json` (`python3 scripts/gen-spawn-env-manifest.py`) and update any `auth.secrets[].source` claims in the affected TOOL.md files. Run `okit probe-check` to verify — it blocks commits via pre-commit hook in ai-workspace.
