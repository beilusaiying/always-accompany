import { defineConfig, devices } from '@playwright/test';

const TEST_DIR = '../beilu的工作日志和项目日志/新项目图和框架wiki/框架与测试预案';

export default defineConfig({
  testDir: TEST_DIR,
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${TEST_DIR}/playwright-report`, open: 'never' }],
  ],
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
  snapshotDir: `${TEST_DIR}/screenshots-baseline`,
  // 本版本 Playwright 仅支持 {arg}{ext}{projectName}{snapshotDir}{testFileDir}{testFileName}，无 {testFileStem}
  snapshotPathTemplate: '{snapshotDir}/{testFileName}/{arg}{ext}',
});
