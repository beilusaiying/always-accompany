import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 880, height: 900 } });
try {
  await p.goto('http://127.0.0.1:8787', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: 'C:/tmp/console2.png' });
  console.log('OK');
} catch (e) { console.log('ERR', e.message); }
await b.close();
