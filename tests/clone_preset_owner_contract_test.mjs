import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const bridge = read("src/yonban/core/functions/memory/ai/presetBridge.mjs");
const runner = read("src/yonban/core/functions/memory/ai/cloneTaskRunner.mjs");
const reply = read("src/yonban/core/functions/memory/handler/replyHandler.mjs");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const body = source.indexOf(") {", start) + 2;
  let depth = 0;
  for (let index = body; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

const orderedSource = extractFunction(bridge, "function _orderedFilePresetPrompts");
const resolveSource = extractFunction(bridge, "export function resolvePresetForMemoryAI").replace("export ", "");
const registry = { "分身_A": { file: "clone-a.json" }, escape: { file: "../outside.json" } };
const files = {
  "clone-a.json": {
    preset_json: {
      prompts: [
        { identifier: "a", role: "system", content: "A" },
        { identifier: "b", role: "assistant", content: "B" },
        { identifier: "off", role: "system", content: "OFF" },
      ],
      prompt_order: [{ order: [{ identifier: "b", enabled: true }, { identifier: "off", enabled: false }, { identifier: "a", enabled: true }] }],
    },
  },
};
const resolve = new Function("path", "getRegistry", "_userPresetDir", "loadJsonFileIfExists", `
  ${orderedSource}
  ${resolveSource}
  return resolvePresetForMemoryAI;
`)(path, () => registry, () => "USER_PRESETS", (filepath, fallback) => files[path.basename(filepath)] || fallback);

const memory = { id: "P1", name: "记忆预设", prompts: [{ role: "system", content: "memory" }] };
assert.equal(resolve("002", "P1", [memory]), memory, "memory preset keeps its existing owner shape");
const filePreset = resolve("002", "分身_A", []);
assert.equal(filePreset.id, "filePreset:分身_A");
assert.deepEqual(filePreset.prompts.map((prompt) => [prompt.role, prompt.content]), [["assistant", "B"], ["system", "A"]]);
assert.equal(resolve("002", "missing", []), null);
assert.equal(resolve("002", "escape", []), null, "registry path traversal must not escape the user preset pool");

assert.match(runner, /resolvePresetForMemoryAI/);
assert.match(reply, /resolvePresetForMemoryAI/);
assert.doesNotMatch(runner, /registry\.json|beilu-preset[\\/]+presets|_loadPresetFile|_orderedPresetPrompts/);
assert.doesNotMatch(reply, /function _resolvePresetForSubMode|getPresetRegistry/);

console.log("clone preset owner contract test passed: memory/per-user file presets share one resolver and ordered prompt shape");
