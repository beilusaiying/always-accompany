import { writeFile } from 'node:fs/promises';

export const state = {
  send: null,
  cdpOverride: null,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
  writeFile,
  sessionId: null,
  sessionTargetId: null,
  sessionAt: 0,
  sessionInflight: null,
  preferredTargetId: null,
  defaultTimeout: 10000,
  networkDomainEnabled: false,
  debugPort: 9222,
};

export async function send(req) {
  if (!state.send) throw new Error('CDP transport not initialized. Call connect() first.');
  return state.send(req);
}
