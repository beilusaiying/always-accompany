import { connect, disconnect } from './transport.mjs';
import { cdp, evaluate } from './cdp.mjs';
import { state } from './state.mjs';
import * as nav from './driver/nav.mjs';
import * as observe from './driver/observe.mjs';
import * as pointer from './driver/pointer.mjs';
import * as keyboard from './driver/keyboard.mjs';
import * as waits from './driver/waits.mjs';

export { connect, disconnect } from './transport.mjs';
export { cdp, evaluate } from './cdp.mjs';

export const page = {
  goto: nav.goto,
  url: async () => (await nav.pageInfo()).url,
  title: async () => (await nav.pageInfo()).title,
  content: async () => evaluate('document.documentElement.outerHTML'),
  evaluate,

  click: pointer.click,
  dblclick: pointer.dblclick,
  hover: pointer.hover,
  drag: pointer.drag,

  fill: keyboard.fill,
  type: keyboard.typeText,
  press: keyboard.press,
  pressSequentially: keyboard.pressSequentially,
  focus: keyboard.focus,
  check: keyboard.check,
  uncheck: keyboard.uncheck,
  selectOption: keyboard.selectOption,
  dispatchEvent: keyboard.dispatchEvent,

  snapshot: observe.snapshot,
  snapshotRaw: observe.snapshotRaw,
  screenshot: observe.screenshot,

  waitForSelector: waits.waitForSelector,
  waitForURL: waits.waitForURL,
  waitForFunction: waits.waitForFunction,
  waitForTimeout: waits.waitForTimeout,
  waitForLoadState: waits.waitForLoadState,
  waitForRequest: waits.waitForRequest,
  waitForResponse: waits.waitForResponse,

  mouse: {
    click: pointer.click,
    dblclick: pointer.dblclick,
    hover: pointer.hover,
    drag: pointer.drag,
    down: pointer.down,
    up: pointer.up,
    wheel: pointer.wheel,
    move: pointer.hover,
  },

  keyboard: {
    press: keyboard.press,
    down: keyboard.down,
    up: keyboard.up,
    type: keyboard.typeText,
    insertText: keyboard.insertText,
  },

  locator: (selector) => createLocator(selector),
  getByRole: (role, options) => createLocator(roleSelector(role, options)),
  getByText: (text, options) => createLocator(`text:${options?.exact ? 'exact:' : ''}${JSON.stringify(text)}`),
  getByLabel: (text, options) => createLocator(`label:${options?.exact ? 'exact:' : ''}${JSON.stringify(text)}`),
  getByPlaceholder: (text, options) => createLocator(`placeholder:${options?.exact ? 'exact:' : ''}${JSON.stringify(text)}`),
  getByAltText: (text, options) => createLocator(`alt:${options?.exact ? 'exact:' : ''}${JSON.stringify(text)}`),
  getByTitle: (text, options) => createLocator(`title:${options?.exact ? 'exact:' : ''}${JSON.stringify(text)}`),
  getByTestId: (id) => createLocator(`testid:${JSON.stringify(id)}`),
};

export const browser = {
  listTabs: nav.listTabs,
  currentTab: nav.currentTab,
  switchTab: nav.switchTab,
  newTab: nav.newTab,
  openOrReuseTab: nav.openOrReuseTab,
  closeTab: nav.closeTab,
  ensureRealTab: nav.ensureRealTab,
  iframeTarget: nav.iframeTarget,
  syncToUserTab: nav.syncToUserTab,
};

function roleSelector(role, options) {
  if (!options?.name) return `role:${role}`;
  return `role:${role}[name=${JSON.stringify(options.name)}]`;
}

function createLocator(selector) {
  const loc = {
    _selector: selector,
    click: (options) => pointer.click(selector, options),
    dblclick: (options) => pointer.dblclick(selector, options),
    hover: (options) => pointer.hover(selector, options),
    fill: (value, options) => keyboard.fill(selector, value, options),
    press: (key, options) => keyboard.pressOnSelector(selector, key, options),
    pressSequentially: (text, options) => keyboard.pressSequentially(selector, text, options),
    type: (text, options) => keyboard.pressSequentially(selector, text, options),
    check: () => keyboard.check(selector),
    uncheck: () => keyboard.uncheck(selector),
    selectOption: (values) => keyboard.selectOption(selector, values),
    dispatchEvent: (type, eventInit) => keyboard.dispatchEvent(selector, type, eventInit),
    focus: () => keyboard.focus(selector),
    scrollIntoViewIfNeeded: () => pointer.scrollIntoViewIfNeeded(selector),
    waitFor: (options) => waits.waitForSelector(selector, options),

    first: () => createLocator(`internal:nth=0;${selector}`),
    last: () => createLocator(`internal:last;${selector}`),
    nth: (index) => createLocator(`internal:nth=${index};${selector}`),
    filter: (options) => {
      const filterSpec = {};
      if (options?.hasText) filterSpec.hasText = typeof options.hasText === 'string'
        ? { text: options.hasText, exact: false } : options.hasText;
      if (options?.hasNotText) filterSpec.hasNotText = typeof options.hasNotText === 'string'
        ? { text: options.hasNotText, exact: false } : options.hasNotText;
      if (options?.has) filterSpec.has = options.has._selector || options.has;
      if (options?.hasNot) filterSpec.hasNot = options.hasNot._selector || options.hasNot;
      return createLocator(
        `internal:filter:${encodeURIComponent(JSON.stringify({ base: selector, ...filterSpec }))}`
      );
    },
    locator: (child) => createLocator(
      `internal:scope:${encodeURIComponent(JSON.stringify({ base: selector, child }))}`
    ),
    getByRole: (role, options) => loc.locator(roleSelector(role, options)),
    getByText: (text, options) => loc.locator(`text:${options?.exact ? 'exact:' : ''}${JSON.stringify(text)}`),
    getByLabel: (text, options) => loc.locator(`label:${options?.exact ? 'exact:' : ''}${JSON.stringify(text)}`),
  };
  return loc;
}

export default { connect, disconnect, page, browser, cdp, evaluate };
