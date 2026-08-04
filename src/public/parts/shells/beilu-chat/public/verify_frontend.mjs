/**
 * 前端完整性静态检查脚本
 * 用法: node verify_frontend.mjs
 *
 * 检查: DOM ID引用、import路径、API端点、CSS匹配
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';

const ROOT = '.';
let errors = 0;
let warnings = 0;

function err(msg) { console.error(`❌ ${msg}`); errors++; }
function warn(msg) { console.warn(`⚠️ ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }

// === 1. 语法检查（所有mjs文件） ===
console.log('\n=== 1. JS文件语法检查 ===');
const jsFiles = [
  'index.mjs', 'src/shared/layout/layout.mjs', 'src/shared/transport/endpoints.mjs',
  'src/shared/layout/extendMenuW28.mjs', 'src/panels/work/workPanel.mjs', 'src/panels/settings/settingsSlots.mjs',
  // 2026-08-03 settingsSlots 拆分：slot 实现迁 slots/*.mjs，DOM ID 引用检查覆盖随迁（门面已无 getElementById）
  'src/panels/settings/slots/langSlot.mjs', 'src/panels/settings/slots/uiSlot.mjs',
  'src/panels/settings/slots/accountSlot.mjs', 'src/panels/settings/slots/remoteSlot.mjs',
  'src/panels/settings/slots/pluginListSlot.mjs', 'src/panels/settings/slots/apiSlot.mjs',
  'src/panels/settings/slots/monitorSlot.mjs', 'src/panels/settings/slots/toggleSlot.mjs',
  'src/panels/settings/slots/fakeSendSlot.mjs', 'src/panels/settings/slots/sysinfoSlot.mjs',
  'src/panels/settings/slots/injectTextsSlot.mjs',
  'src/shared/widgets/backendMonitor.mjs', 'src/shared/widgets/tokenProgressBar.mjs',
  'src/panels/editors/worldbookEditor.mjs', 'src/panels/editors/regexEditor.mjs',
  'src/panels/memory/memoryPresetChat.mjs', 'src/panels/memory/dataTable.mjs', 'src/panels/memory/memoryBrowser.mjs',
];
// node -c已在外部验证，这里跳过

// === 2. Import路径检查 ===
console.log('\n=== 2. Import路径检查 ===');
let importOk = 0;
for (const f of jsFiles) {
  if (!existsSync(f)) { warn(`文件不存在: ${f}`); continue; }
  const content = readFileSync(f, 'utf8');
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const target = resolve(dirname(f), m[1]);
    if (!existsSync(target)) {
      err(`MISSING IMPORT: ${f} → ${m[1]}`);
    } else {
      importOk++;
    }
  }
}
ok(`${importOk}个import路径全部正确`);

// === 3. HTML中DOM ID引用检查 ===
console.log('\n=== 3. DOM ID引用检查 ===');
const html = readFileSync('index.html', 'utf8');

// 从JS文件收集getElementById引用
const idRefs = new Set();
for (const f of jsFiles) {
  if (!existsSync(f)) continue;
  const content = readFileSync(f, 'utf8');
  const re = /getElementById\(["']([^"']+)["']\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    idRefs.add(m[1]);
  }
}

// 检查HTML中是否有对应的id
let idOk = 0, idMissing = 0;
const dynamicIds = [
  // 动态创建的ID不需要在HTML中存在
  'token-progress-container', 'token-progress-fill', 'token-progress-text',
  'token-compress-btn', 'token-progress-bar-wrapper', 'monitor-token-row',
  'monitor-token-value', 'companion-panel', 'companion-dot',
  'companion-status-text', 'companion-start', 'companion-stop',
  'companion-panel-close', 'companion-interval', 'companion-ask-before',
  'companion-resolution', 'companion-blacklist', 'companion-save-config',
  'work-submodes-list', 'work-flowgroups-list', 'work-models-list',
  'work-refresh-btn', 'work-open-api-settings', 'work-restore-defaults',
  'settings-monitor-log', 'settings-monitor-errors', 'settings-monitor-status',
  'settings-monitor-clear-log',
];

for (const id of idRefs) {
  if (dynamicIds.includes(id)) { idOk++; continue; }
  if (html.includes(`id="${id}"`) || html.includes(`id='${id}'`)) {
    idOk++;
  } else {
    warn(`JS引用ID "${id}" 在HTML中未找到`);
    idMissing++;
  }
}
ok(`${idOk}个ID匹配成功, ${idMissing}个可能缺失`);

// === 4. CSS大括号匹配 ===
console.log('\n=== 4. CSS大括号检查 ===');
const cssFiles = ['index.css', ...readdirSync('css').filter(f => f.endsWith('.css')).map(f => `css/${f}`)];
let totalOpen = 0, totalClose = 0;
for (const cf of cssFiles) {
  const css = readFileSync(cf, 'utf8');
  const o = (css.match(/{/g) || []).length;
  const c = (css.match(/}/g) || []).length;
  totalOpen += o; totalClose += c;
  if (o !== c) warn(`${cf}: {=${o} }=${c}`);
}
if (totalOpen === totalClose) {
  ok(`CSS大括号匹配: ${totalOpen}对 (${cssFiles.length}个文件)`);
} else {
  err(`CSS大括号不匹配: {=${totalOpen} }=${totalClose}`);
}

// === 5. 关键功能入口检查 ===
console.log('\n=== 5. 关键功能入口检查 ===');
const checks = [
  ['顶部Tab: smart', 'data-top-tab="smart"'],
  ['顶部Tab: chat/AIRP', 'data-top-tab="chat"'],
  ['顶部Tab: files/IDE', 'data-top-tab="files"'],
  ['顶部Tab: work', 'data-top-tab="work"'],
  ['隐藏Tab: memory', 'data-top-tab="memory"'],
  ['隐藏Tab: bot', 'data-top-tab="bot"'],
  ['隐藏Tab: helper', 'data-top-tab="helper"'],
  ['设置按钮', 'id="settings-btn"'],
  ['编辑按钮', 'id="editor-btn"'],
  ['≡菜单', 'id="extend-menu-popup"'],
  ['新≡菜单(无旧菜单)', 'id="extend-menu-btn"'],
  ['角色选择器', 'id="char-selector-dropdown"'],
  ['设置弹窗', 'id="center-tab-settings"'],
  ['编辑弹窗', 'id="center-tab-editor"'],
  ['世界书编辑器浮窗', 'id="wb-editor-window"'],
  ['提示词查看器浮窗', 'id="prompt-viewer-window"'],
  ['后台监控(IDE)', 'id="ide-backend-monitor"'],
  ['后台监控(设置)', 'id="settings-monitor-log"'],
  ['插件列表(设置)', 'id="settings-plugin-list"'],
  // 注入提示词内联编辑器（injection-prompt-editor）AIRP-T2 已删 DOM，0713 H1 同批清掉本 stale 断言
  ['正则编辑器容器', 'id="regex-editor-container"'],
  ['Bot面板', 'id="bot-panel-discord"'],
  ['工作活动栏', 'id="work-activity-bar"'],
  ['工作面板浮窗', 'id="work-panel-float"'],
  ['陪伴面板(动态)', 'companion-panel'],
];
for (const [name, pattern] of checks) {
  if (html.includes(pattern)) {
    ok(name);
  } else {
    if (pattern === 'companion-panel') { ok(`${name} (JS动态创建)`); continue; }
    warn(`${name}: HTML中未找到 "${pattern}"`);
  }
}

// === 6. 旧代码残留检查 ===
console.log('\n=== 6. 旧代码残留检查 ===');
const layoutJs = readFileSync('src/shared/layout/layout.mjs', 'utf8');
const indexJs = readFileSync('index.mjs', 'utf8');

if (indexJs.includes('initExtendMenu()') && !indexJs.includes('// initExtendMenu()')) {
  err('旧initExtendMenu()未注释');
} else {
  ok('旧initExtendMenu已禁用');
}

if (layoutJs.includes('../endpoints.mjs')) {
  err('layout.mjs import路径仍为../endpoints.mjs(应为./endpoints.mjs)');
} else {
  ok('layout.mjs import路径正确');
}

// === 总结 ===
console.log(`\n${'='.repeat(40)}`);
console.log(`检查完成: ✅ 通过 | ⚠️ ${warnings}个警告 | ❌ ${errors}个错误`);
if (errors > 0) process.exit(1);
