import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@operationkit/shared': path.resolve(__dirname, '../shared/types.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // obj 900685: uncapped, vitest sizes its pool to the CPU count — 31
    // workers per run on the 32-core host, from every session that runs the
    // client suite. Same cap as app/server/vitest.config.ts.
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    minWorkers: 1,
    maxWorkers: 2,
  },
})
