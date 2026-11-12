// Seat-management E2E (obj 720330). Run through run.sh, which boots the scratch
// server + stub and exports E2E_BASE_URL. Not part of CI (see CLAUDE.md "Testing").
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: process.env.E2E_OUTPUT_DIR || '/tmp/pw-seat-management',
  use: { baseURL: process.env.E2E_BASE_URL, trace: 'off' },
  projects: [
    { name: 'light', use: { colorScheme: 'light', viewport: { width: 1440, height: 1000 } } },
    { name: 'dark', use: { colorScheme: 'dark', viewport: { width: 1440, height: 1000 } } },
  ],
})
