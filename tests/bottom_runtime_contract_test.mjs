import assert from "node:assert/strict";

import { dispatch } from "../src/yonban/core/dispatch/dispatcher.mjs";
import { registry } from "../src/yonban/core/dispatch/registry.mjs";
import {
  broadcastAllChatUi,
  broadcastCrossChatEvent,
  chatUiSockets,
  registerChatUiSocket,
} from "../src/public/parts/shells/beilu-chat/src/lib/broadcast.mjs";
import {
  gameCompanionUserAction,
  getGameCompanionStatus,
  startGameCompanion,
  stopGameCompanion,
} from "../src/public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs";
import {
  broadcastBotError,
} from "../src/public/parts/shells/botErrorBroadcast.mjs";

Deno.test("dispatcher import self-bootstraps the four built-in exits", async () => {
  for (
    const target of [
      "bus:broadcast",
      "bus:feed",
      "bus:activate",
      "store:persist",
    ]
  ) {
    assert.equal(registry.has(target), true, `${target} was not bootstrapped`);
  }

  const result = await dispatch({
    verb: "missing",
    target: "bus:broadcast",
    source: "test",
    payload: {},
    scope: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "E_NODE");
  assert.match(result.error?.msg || "", /missing/);
});

function fakeSocket() {
  const handlers = new Map();
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    on(type, handler) {
      handlers.set(type, handler);
    },
  };
}

Deno.test("cross-window broadcasts never fan out beyond their resolved user", async () => {
  const suffix = crypto.randomUUID();
  const a1 = `audit-a1-${suffix}`;
  const a2 = `audit-a2-${suffix}`;
  const b1 = `audit-b1-${suffix}`;
  const sockets = {
    a1: fakeSocket(),
    a2: fakeSocket(),
    b1: fakeSocket(),
  };
  const metas = new Map([
    [a1, { username: "audit-user-a" }],
    [a2, { username: "audit-user-a" }],
    [b1, { username: "audit-user-b" }],
  ]);
  const deps = {
    getChatMetadatas: () => metas,
    saveChat: async () => {},
  };

  try {
    registerChatUiSocket(a1, sockets.a1, deps, "audit-user-a");
    registerChatUiSocket(a2, sockets.a2, deps, "audit-user-a");
    registerChatUiSocket(b1, sockets.b1, deps, "audit-user-b");
    for (const ws of Object.values(sockets)) ws.sent.length = 0;

    assert.equal(
      broadcastCrossChatEvent(a1, { type: "from_source" }),
      true,
    );
    assert.deepEqual(sockets.a1.sent, []);
    assert.equal(sockets.a2.sent.at(-1)?.type, "from_source");
    assert.deepEqual(sockets.b1.sent, []);

    for (const ws of Object.values(sockets)) ws.sent.length = 0;
    assert.equal(
      broadcastCrossChatEvent(
        null,
        { type: "owner_only" },
        "audit-user-a",
      ),
      true,
    );
    assert.equal(sockets.a1.sent.at(-1)?.type, "owner_only");
    assert.equal(sockets.a2.sent.at(-1)?.type, "owner_only");
    assert.deepEqual(sockets.b1.sent, []);

    for (const ws of Object.values(sockets)) ws.sent.length = 0;
    assert.equal(
      broadcastCrossChatEvent(null, { type: "must_drop" }),
      false,
    );
    assert.equal(
      Object.values(sockets).flatMap((ws) => ws.sent).length,
      0,
    );

    assert.equal(
      broadcastAllChatUi({ type: "all_owner_scoped" }, "audit-user-b"),
      true,
    );
    assert.deepEqual(sockets.a1.sent, []);
    assert.deepEqual(sockets.a2.sent, []);
    assert.equal(sockets.b1.sent.at(-1)?.type, "all_owner_scoped");

    for (const ws of Object.values(sockets)) ws.sent.length = 0;
    assert.equal(
      broadcastBotError({
        username: "audit-user-a",
        platform: "audit-platform",
        botname: "private-bot",
        phase: "runtime",
        error: new Error("owner-only-error"),
      }),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sockets.a1.sent.at(-1)?.type, "bot_error");
    assert.equal(sockets.a2.sent.at(-1)?.payload?.botname, "private-bot");
    assert.deepEqual(sockets.b1.sent, []);

    for (const ws of Object.values(sockets)) ws.sent.length = 0;
    assert.equal(
      broadcastBotError({
        platform: "audit-platform",
        botname: "must-not-leak",
        phase: "runtime",
        error: "missing owner",
      }),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      Object.values(sockets).flatMap((ws) => ws.sent).length,
      0,
    );
  } finally {
    chatUiSockets.delete(a1);
    chatUiSockets.delete(a2);
    chatUiSockets.delete(b1);
  }
});

Deno.test("game companion runtime remains addressable after current role changes", () => {
  const username = `runtime-audit-${crypto.randomUUID()}`;
  const firstChar = "role-a";
  const secondChar = "role-b";

  try {
    const started = startGameCompanion(username, firstChar, {
      chatid: "companion-audit-chat",
      interval: 60 * 60 * 1000,
    });
    assert.equal(started.success, true);

    const statusFromOtherRole = getGameCompanionStatus(
      username,
      secondChar,
    );
    assert.equal(statusFromOtherRole.running, true);
    assert.equal(statusFromOtherRole.charName, firstChar);
    assert.equal(statusFromOtherRole.chatid, "companion-audit-chat");

    const duplicate = startGameCompanion(username, secondChar, {
      chatid: "should-not-start",
      interval: 60 * 60 * 1000,
    });
    assert.equal(duplicate.success, false);

    gameCompanionUserAction(username, secondChar, "pause");
    assert.equal(
      getGameCompanionStatus(username, firstChar).paused,
      true,
    );

    const stopped = stopGameCompanion(username, secondChar);
    assert.equal(stopped.success, true);
    assert.deepEqual(getGameCompanionStatus(username, firstChar), {
      running: false,
    });
  } finally {
    stopGameCompanion(username, firstChar);
  }
});

Deno.test("Bot settings are embedded and role binding has no auto-follow listener", async () => {
  const html = await Deno.readTextFile(
    new URL(
      "../src/public/parts/shells/beilu-chat/public/index.html",
      import.meta.url,
    ),
  );
  const panel = await Deno.readTextFile(
    new URL(
      "../src/public/parts/shells/beilu-chat/public/src/panels/bot/discordBotPanel.mjs",
      import.meta.url,
    ),
  );

  assert.match(html, /id="dc-bot-feature-settings"/);
  for (
    const id of [
      "dc-inj-section",
      "dc-cf-section",
      "dc-bsm-section",
      "dc-cmd-section",
      "dc-hist-section",
    ]
  ) {
    assert.match(html, new RegExp(`<details id="${id}"`));
  }
  assert.doesNotMatch(
    html,
    /<dialog id="dc-(inj|cf|bsm|cmd|hist)-dialog"/,
  );
  assert.doesNotMatch(panel, /showModal\(\)/);
  assert.doesNotMatch(panel, /addEventListener\("beilu:char-changed"/);
  assert.match(panel, /dc-bind-current/);

  const botErrorSource = await Deno.readTextFile(
    new URL(
      "../src/public/parts/shells/botErrorBroadcast.mjs",
      import.meta.url,
    ),
  );
  assert.match(botErrorSource, /sendEventToUser\(username/);
  assert.doesNotMatch(botErrorSource, /sendEventToAll\(/);
});
