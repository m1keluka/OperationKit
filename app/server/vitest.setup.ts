// Server test bootstrap — make the suite hermetic / CI-safe.
//
// design-context.ts reads the design registry from <PROJECTS_DIR>/.design-registry.json
// (default /home/operator/projects/...), which does NOT exist on a CI runner. Point it at a
// committed fixture (a copy of the real registry) so registry-dependent suites
// (design-arena, design-context, gate-runtime-config, reviewer-prompt-dormancy) run
// identically locally and in CI without depending on a real /home/mike checkout.
// Only set it if a caller hasn't already chosen a registry explicitly.
import path from 'node:path'
import os from 'node:os'

// HARD DB ISOLATION (incident 2026-06-30 — a test run wiped the entire objectives table).
// Production exports DB_PATH=/app/data/command-center.db into the environment, so a
// `vitest run` that inherits it makes initDb() open the LIVE database — and suite
// teardowns (`DELETE FROM objectives`, …) then wipe production. Force every test run onto
// a throwaway temp DB BEFORE any test file imports the db module. Test files that set
// their own DB_PATH (the `process.env.DB_PATH = TMP_DB` pattern) still override this at
// their own import time — they just get a different throwaway. initDb() additionally
// hard-refuses the production path under a test runner as a second layer (db/index.ts).
process.env.DB_PATH = path.join(os.tmpdir(), `cc-test-suite-${process.pid}.db`)

// JWT_SECRET has no git-committed fallback. Specs that sign cookies set their
// own value; this default keeps imports of middleware/auth.ts from throwing.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-vitest-setup-xx'
}

if (!process.env.DESIGN_REGISTRY_FILE) {
  process.env.DESIGN_REGISTRY_FILE = path.join(
    __dirname,
    'src',
    'services',
    '__fixtures__',
    'design-registry.json',
  )
}
