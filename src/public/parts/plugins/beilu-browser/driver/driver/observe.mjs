import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { state } from '../state.mjs';
import { cdp, evaluate } from '../cdp.mjs';
import { pageInfo } from './nav.mjs';
import { ensureSession, drainBrowserEvents, pendingDialog, snapshotRefsToRefMap } from '../transport.mjs';
import { resolveElementCenter } from '../element-resolver.mjs';
import { browserRefMap, ensureRefMapForRef, registerSnapshotForRefRefresh } from '../ref-state.mjs';

export async function drainEvents() {
  return drainBrowserEvents();
}

export async function snapshotRaw(options = {}) {
  await ensureSession();
  const scope = options.scope ?? 'full_page';
  const tree = await cdp('Accessibility.getFullAXTree', {});
  const nodes = tree.nodes || [];

  const refs = [];
  const lines = [];

  function extractValue(prop) {
    if (!prop) return '';
    const raw = prop.value;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    return '';
  }

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = extractValue(node.role);
    const name = extractValue(node.name);
    const value = extractValue(node.value);
    if (!role || role === 'none' || role === 'GenericContainer') continue;

    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId === undefined || backendNodeId === null) continue;

    const refTag = `@${backendNodeId}`;
    refs.push({ backendNodeId, role, name });

    let line = `${refTag} ${role}`;
    if (name) line += ` "${name}"`;
    if (value) line += ` value="${value}"`;

    const focused = node.properties?.find(p => p.name === 'focused')?.value?.value;
    if (focused) line += ' [focused]';

    const checked = node.properties?.find(p => p.name === 'checked')?.value?.value;
    if (checked === 'true' || checked === true) line += ' [checked]';

    const disabled = node.properties?.find(p => p.name === 'disabled')?.value?.value;
    if (disabled === 'true' || disabled === true) line += ' [disabled]';

    lines.push(line);
  }

  snapshotRefsToRefMap(browserRefMap, refs);

  return {
    content: lines.join('\n'),
    refs,
  };
}

registerSnapshotForRefRefresh(() => snapshotRaw());

export async function snapshot(options = {}) {
  const result = await snapshotRaw({
    scope: options.scope ?? 'full_page',
  });
  return result.content || '';
}

export async function elementCenter(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveElementCenter(
    { sendRaw: cdp },
    undefined,
    browserRefMap,
    selectorOrRef,
  );
}

let screenshotSeq = 0;

export async function screenshot(options = {}) {
  const path = options.path ?? join(tmpdir(), `browser-driver-shot-${process.pid}-${++screenshotSeq}.png`);
  const full = options.fullPage ?? false;
  const raw = options.raw ?? false;
  const params = { format: 'png', captureBeyondViewport: full };

  if (raw) {
    if (options.clip) params.clip = { ...options.clip };
  } else {
    await ensureSession();
    if (!pendingDialog()) {
      const dpr = Number(await evaluate('window.devicePixelRatio')) || 1;
      const cssScale = 1 / dpr;
      if (options.clip) {
        params.clip = { scale: cssScale, ...options.clip };
      } else {
        const info = await pageInfo();
        if ('dialog' in info) {
          return screenshot({ ...options, path, raw: true });
        }
        params.clip = {
          x: 0, y: 0,
          width: full ? info.pw : info.w,
          height: full ? info.ph : info.h,
          scale: cssScale,
        };
      }
    }
  }

  const result = await cdp('Page.captureScreenshot', params);
  await state.writeFile(path, Buffer.from(result.data, 'base64'));
  return path;
}
