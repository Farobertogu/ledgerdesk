import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/reading/browser', fullyParallel: false, workers: 1,
  timeout: 20000, retries: 0, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3180', browserName: 'chromium',
    channel: process.env.READING_BROWSER_CHANNEL || undefined,
    viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure', trace: 'off' },
  webServer: {
    command: 'node ci/reading_start.mjs 3180', url: 'http://127.0.0.1:3180/material',
    reuseExistingServer: false, timeout: 60000,
    env: { LEDGERDESK_READING_TRIAL: '1', LEDGERDESK_READING_ENVIRONMENT: 'local-synthetic',
      LEDGERDESK_READING_SUBJECT: 'synthetic-browser', LEDGERDESK_READING_GENERATION: 'browser-test',
      LEDGERDESK_DEV_IDENTITY: '0', NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_unused' },
  },
});
