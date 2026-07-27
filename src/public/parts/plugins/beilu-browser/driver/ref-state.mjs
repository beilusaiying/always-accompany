import { parseRef, RefMap } from './ref-map.mjs';

export const browserRefMap = new RefMap();

let ensuring = false;
let snapshotImpl = null;

export function registerSnapshotForRefRefresh(fn) {
  snapshotImpl = fn;
}

export async function ensureRefMapForRef(selectorOrRef) {
  if (ensuring) return;
  if (typeof selectorOrRef !== 'string') return;
  if (!parseRef(selectorOrRef)) return;
  if (browserRefMap.map.size > 0) return;
  if (!snapshotImpl) return;
  ensuring = true;
  try {
    await snapshotImpl();
  } finally {
    ensuring = false;
  }
}
