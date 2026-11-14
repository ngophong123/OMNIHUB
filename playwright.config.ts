import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',
  fullyParallel: false,
  workers: 1,
  timeout: process.env.E2E_WEB_ORIGIN ? 180_000 : 120_000,
  use: {
    baseURL: process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Trust only this rehearsal certificate's public key, never all certificates.
    launchOptions: { args: process.env.E2E_TLS_SPKI ? [`--ignore-certificate-errors-spki-list=${process.env.E2E_TLS_SPKI}`] : [] },
  },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
});
