import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chatPublic = resolve(
  projectRoot,
  "src/public/parts/shells/beilu-chat/public",
);

const read = (relativePath) =>
  readFileSync(resolve(chatPublic, relativePath), "utf8");

const templates = [
  "src/shared/render/templates/message_view.html",
  "src/shared/render/templates/message_generating_view.html",
  "src/shared/render/templates/message_edit_view.html",
];

for (const templatePath of templates) {
  const source = read(templatePath);
  assert.match(
    source,
    /class="message-avatar\b/,
    `${templatePath} must expose the left avatar column`,
  );
  assert.match(
    source,
    /class="message-main\b/,
    `${templatePath} must expose the right message column`,
  );
  assert.ok(
    source.indexOf('class="message-avatar') <
      source.indexOf('class="message-main'),
    `${templatePath} must place avatar before the message main column`,
  );
  assert.doesNotMatch(
    source,
    /\bml-10\b|\bmb-3\b/,
    `${templatePath} must not recreate avatar/message spacing with utility margins`,
  );
  if (templatePath !== "src/shared/render/templates/message_edit_view.html") {
    assert.match(
      source,
      /class="chat-message chat-message-layout\b/,
      `${templatePath} must opt into the standard two-column layout`,
    );
  }
}

const indexCss = read("index.css");
assert.match(
  indexCss,
  /\.chat-message\.chat-message-layout\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*50px minmax\(0,\s*1fr\)/s,
  "chat messages must use a fixed avatar column plus a shrinkable content column",
);
assert.match(
  indexCss,
  /\.chat-message \.swipe-nav\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*pointer-events:\s*none;/s,
  "swipe navigation must float over the message instead of consuming height",
);
assert.match(
  indexCss,
  /\.message-avatar-preview\s*\{[^}]*position:\s*fixed;/s,
  "avatar preview must be a non-flow floating surface",
);

const messageList = read("src/shared/render/messageList.mjs");
assert.doesNotMatch(
  messageList,
  /wrapper\.className = "chat-message(?:\s|")/,
  "nested frontend-card hosts must not inherit the outer avatar/content grid",
);
assert.match(
  messageList,
  /wrapper\.className = "segment-iframe-host"/,
  "mixed frontend-card segments must have a dedicated host",
);
assert.match(
  messageList,
  /function _showAvatarFloatingPreview\(sourceImage\)/,
  "avatar click path must have a real preview creator",
);
assert.match(
  messageList,
  /querySelectorAll\(":scope > \.message-avatar"\)/,
  "avatar behavior must stay scoped to the direct chat-message avatar",
);
assert.match(
  messageList,
  /avatar\.addEventListener\("click", openPreview\)/,
  "avatar preview must be bound to click",
);
assert.match(
  messageList,
  /const needsKeyboardPolyfill = avatar\.tagName !== "BUTTON"/,
  "non-button legacy avatars must retain keyboard access without double-firing native buttons",
);

const virtualQueue = read("src/shared/render/virtualQueue.mjs");
assert.match(
  virtualQueue,
  /document\.createElement\("button"\)[\s\S]*leftArrow\.type = "button"/,
  "left timeline control must be a semantic button",
);
assert.match(
  virtualQueue,
  /document\.createElement\("button"\)[\s\S]*rightArrow\.type = "button"/,
  "right timeline control must be a semantic button",
);

const iframeRenderer = read("src/shared/render/iframeRenderer.mjs");
assert.match(
  iframeRenderer,
  /function getChatViewportHeight\(\)[\s\S]*getElementById\("chat-messages"\)/,
  "frontend-card viewport height must come from the real chat viewport",
);
assert.match(
  iframeRenderer,
  /function bindChatViewportResizeObserver\(\)[\s\S]*chatViewportResizeObserver\.observe\(observedChatViewport\)/,
  "frontend cards must rebind resize tracking to the active chat window",
);
assert.match(
  iframeRenderer,
  /iframe\.style\.height = "100px";/,
  "frontend-card iframe must start with a compact fallback height",
);
assert.doesNotMatch(
  iframeRenderer,
  /iframe\.style\.height = "600px";/,
  "the old 600px blank placeholder must not return",
);

const featureControls = read("src/panels/feature/featureControls.mjs");
assert.match(
  featureControls,
  /setProperty\("--beilu-chat-width", val \+ "%"\)/,
  "chat width must remain on the existing CSS-variable single source",
);

console.log("chat UI layout contracts: PASS");
