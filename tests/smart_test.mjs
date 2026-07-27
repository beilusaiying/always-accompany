import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', error => errors.push(`[PageError] ${error.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`[ConsoleError] ${msg.text()}`);
  });

  const screenshotDir = 'D:\\project\\beilu-与你之诗\\tests\\screenshots';
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  console.log('访问 http://localhost:1314...');
  await page.goto('http://localhost:1314');
  await page.waitForTimeout(2000);

  // 登录
  const loginBtn = page.locator('button', { hasText: '登录' }).first();
  if (await loginBtn.isVisible()) {
      await loginBtn.click();
      await page.waitForTimeout(2000);
  }

  const results = {
      smartLayout: null,
      inputAvailable: false,
      botWidthFull: false,
      jsErrors: []
  };

  // 1. 切到全智能Tab
  console.log('查找全智能Tab...');
  const smartTab = page.locator('text=全智能').first();
  if (await smartTab.isVisible()) {
      await smartTab.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(screenshotDir, 'smart_layout.png') });
      console.log('已截图: smart_layout.png');
      
      // 检查布局：是否居中单栏，侧栏是否折叠
      results.smartLayout = await page.evaluate(() => {
          const sidebars = Array.from(document.querySelectorAll('aside, .sidebar, [class*="sidebar"]'));
          const visibleSidebars = sidebars.filter(el => window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).width !== '0px');
          
          return {
              visibleSidebars: visibleSidebars.length,
              hasThreeColumns: document.querySelectorAll('.grid-cols-3, [class*="grid-cols-3"]').length > 0,
              isCentered: !!document.querySelector('.mx-auto, [class*="mx-auto"]')
          };
      });

      // 检查输入框
      const input = page.locator('textarea, input[type="text"]').last();
      results.inputAvailable = await input.isVisible() && await input.isEnabled();
  } else {
      console.log('未找到全智能Tab');
  }

  // 2. 切到AIRP
  console.log('查找AIRP Tab...');
  const airpTab = page.locator('text=AIRP').first();
  if (await airpTab.isVisible()) {
      await airpTab.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(screenshotDir, 'smart_airp_layout.png') });
      console.log('已截图: smart_airp_layout.png');
  }

  // 3. 切Bot Tab
  console.log('查找Bot Tab...');
  const botTab = page.locator('text=Bot').first();
  if (await botTab.isVisible()) {
      await botTab.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(screenshotDir, 'smart_bot_layout.png') });
      console.log('已截图: smart_bot_layout.png');
      
      // 检查宽度是否填满 (不再max-w-2xl)
      results.botWidthFull = await page.evaluate(() => {
          const container = document.querySelector('.max-w-2xl');
          return !container; 
      });
  }

  // 4. 切回全智能，测试侧栏展开
  if (await smartTab.isVisible()) {
      await smartTab.click();
      await page.waitForTimeout(1000);
      
      const toggleBtn = page.locator('button[title*="侧栏"], button[title*="sidebar"], .toggle-sidebar').first();
      if (await toggleBtn.isVisible()) {
          await toggleBtn.click();
          await page.waitForTimeout(1000);
          await page.screenshot({ path: path.join(screenshotDir, 'smart_sidebar_toggled.png') });
          console.log('已截图: smart_sidebar_toggled.png');
      } else {
          // 备用：尝试点击左上角的菜单/折叠图标
          const svgBtn = page.locator('button svg').first();
          if (await svgBtn.isVisible()) {
              await svgBtn.click();
              await page.waitForTimeout(1000);
              await page.screenshot({ path: path.join(screenshotDir, 'smart_sidebar_toggled.png') });
              console.log('已截图: smart_sidebar_toggled.png (使用备用按钮)');
          }
      }
  }

  results.jsErrors = errors;
  console.log('---TEST_RESULTS---');
  console.log(JSON.stringify(results, null, 2));

  await browser.close();
})();