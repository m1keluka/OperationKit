import { defineConfig, configDefaults } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@operationkit/shared': path.resolve(__dirname, '../shared/types.ts'),
    },
  },
  test: {
    globals: true,
    // OOM guard (incident 2026-08-16): with no cap, `vitest run` sizes its fork
    // pool to the CPU count. On the VPS (nproc=32) a full suite run inside the
    // command-center container spawns ~30 forks (~2GB each), exhausting the
    // host's 62GB RAM + swap and starving the live backend -> site-wide 502.
    // Cap to 2 concurrent forks so a hung/orphaned run leaves 2 workers, not 32.
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    minWorkers: 1,
    maxWorkers: 2,
    // obj-2376: the canary fixtures under fixtures/canaries/ are KNOWN-BAD
    // artifacts (incl. a deliberately-named *.test.mjs anti-signal file). They are
    // run by the harness via runFloor, NOT by vitest — exclude them from collection
    // so the default glob doesn't try to load a fixture as a real suite.
    exclude: [...configDefaults.exclude, '**/fixtures/**'],
    // Points DESIGN_REGISTRY_FILE at a committed fixture so registry-dependent
    // suites don't need a real /home/operator/projects checkout (CI-hermetic).
    setupFiles: ['./vitest.setup.ts'],
    // Fail a hung async test/hook fast instead of pinning CI to the job's
    // wall-clock cap. (A *synchronous* blocking syscall — e.g. mkdirSync on a
    // pathological path — can't be interrupted by these; the workflow's
    // timeout-minutes is the backstop for that class.)
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 15000,
  },
})
