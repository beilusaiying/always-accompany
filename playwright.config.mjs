import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = fileURLToPath(new URL('./tests', import.meta.url));
const ARTIFACT_DIR = process.env.BEILU_PLAYWRIGHT_ARTIFACT_DIR
  ? path.resolve(process.env.BEILU_PLAYWRIGHT_ARTIFACT_DIR)
  : path.join(os.tmpdir(), 'beilu-playwright');

export default defineConfig({
  testDir: TEST_DIR,
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(ARTIFACT_DIR, 'report'), open: 'never' }],
  ],
  outputDir: path.join(ARTIFACT_DIR, 'test-results'),
  use: {
    baseURL: 'http://localhost:1314',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
      animations: 'disabled',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  snapshotDir: path.join(TEST_DIR, 'screenshots-baseline'),
  // 本版本 Playwright 仅支持 {arg}{ext}{projectName}{snapshotDir}{testFileDir}{testFileName}，无 {testFileStem}
  snapshotPathTemplate: '{snapshotDir}/{testFileName}/{arg}{ext}',
});
