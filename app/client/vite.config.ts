import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@command-center/shared': path.resolve(__dirname, '../shared/types.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3002',
      '/ws': {
        target: 'ws://localhost:3002',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Split the stable React runtime into its own vendor chunk (obj 700585)
        // so it caches across deploys independently of app code — a deploy that
        // only touches app code leaves this chunk's hash (and the browser's cached
        // copy) untouched. Scoped to react/react-dom/scheduler because those are
        // the only framework deps actually in the initial bundle: react-router-dom
        // is a dependency but is not imported anywhere in src (routing is a
        // pathname switch), and @mantine/@blocknote/mermaid are reached only through
        // lazy dynamic imports, so they must stay in their own on-demand chunks
        // rather than being pulled forward into an eager vendor chunk. Matched by
        // resolved path (robust against the symlink-farm node_modules used to build
        // inside the container).
        manualChunks(id) {
          if (
            /[\\/]node_modules[\\/](react-dom|scheduler)[\\/]/.test(id) ||
            /[\\/]node_modules[\\/]react[\\/]/.test(id)
          ) {
            return 'react-vendor'
          }
        },
      },
    },
  },
})
