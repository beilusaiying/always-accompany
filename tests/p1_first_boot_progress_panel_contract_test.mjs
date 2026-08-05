import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panel = fs.readFileSync(
  path.join(repoRoot, "src/public/parts/shells/beilu-chat/public/src/panels/memory/p1panel.mjs"),
  "utf8",
);

Deno.test("P1 panel renders first-boot progress and only escalates after ready disconnect", () => {
  assert.match(panel, /function _p1WarmupProgressMarkup/);
  assert.match(panel, /function _p1WarmupFailureMarkup/);
  assert.match(panel, /data-p1-warmup-progress/);
  assert.match(panel, /<progress class="progress progress-warning/);
  assert.match(panel, /function _p1ScheduleWarmupRefresh/);
  assert.match(panel, /P1 资源准备已完成，但服务仍无法连接/);
  assert.match(panel, /首启资源准备失败/);
  assert.match(panel, /polls >= 180/);
});
