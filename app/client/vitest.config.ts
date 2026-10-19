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
  },
})
