import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'workspace-chat.spec.ts',
  workers: 1,
  timeout: 45_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18802',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'WORKSPACE_FIXTURE_PORT=18802 WORKSPACE_FIXTURE_UPSTREAM_PORT=19120 node --import tsx tests/fixtures/workspace-server.ts',
    url: 'http://127.0.0.1:18802/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
})
