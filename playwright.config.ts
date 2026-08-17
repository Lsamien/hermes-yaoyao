import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18801',
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node tests/fixtures/fake-hermes.mjs',
      port: 19119,
      reuseExistingServer: true,
      timeout: 15_000,
    },
    {
      command: 'cross-env NODE_ENV=production HERMES_YAOYAO_HOST=127.0.0.1 HERMES_YAOYAO_PORT=18801 HERMES_YAOYAO_UPSTREAM=http://127.0.0.1:19119 node dist-server/server/index.js',
      url: 'http://127.0.0.1:18801/healthz',
      reuseExistingServer: true,
      timeout: 15_000,
    },
  ],
})
