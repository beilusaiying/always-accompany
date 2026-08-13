import assert from "node:assert/strict";
import {
  CLONE_CONFIG_DEFAULTS,
  createDefaultCloneConfigs,
  normalizeCloneConfig,
  normalizeCloneConfigs,
  resolveCloneConfig,
  resolveCloneMaxWorkRounds,
} from "../src/yonban/core/functions/memory/ai/cloneContract.mjs";

const defaults = createDefaultCloneConfigs();
assert.equal(defaults.length, 6);
assert.deepEqual(defaults.filter((clone) => clone.enabled).map((clone) => clone.id), [1]);
assert.equal(defaults[0].maxRounds, 50);
assert.equal(defaults[2].permissions.write_code, true);
assert.equal(defaults[0].permissions.web_search, true);
assert.equal(defaults[0].permissions.web_download, true);
assert.equal(Object.hasOwn(defaults[0].permissions, "fuzzy_edit"), false);

const old = normalizeCloneConfig({
  id: 7,
  label: "  自定义分身  ",
  enabled: true,
  maxRounds: 0,
  prefillEnabled: false,
  claudePrefillMode: "",
  futureField: { keep: true },
  permissions: { read_file: true, future_permission: "keep" },
});
assert.equal(old.label, "自定义分身");
assert.equal(old.maxRounds, 0);
assert.equal(old.prefillEnabled, false);
assert.equal(old.claudePrefillMode, "");
assert.deepEqual(old.futureField, { keep: true });
assert.equal(old.permissions.future_permission, "keep");
assert.equal(old.permissions.web_search, true, "旧配置缺键时由唯一模板补齐显式联网默认");
assert.equal(old.maxContext, CLONE_CONFIG_DEFAULTS.maxContext);
assert.equal(old.maxTokens, 60000);

const merged = normalizeCloneConfigs([
  { id: 7, label: "自定义分身", enabled: true, permissions: { read_file: false } },
], [old])[0];
assert.equal(merged.maxRounds, 0, "前端遗漏字段时保留已存值");
assert.equal(merged.prefillEnabled, false);
assert.deepEqual(merged.futureField, { keep: true });
assert.equal(merged.permissions.read_file, false);
assert.equal(merged.permissions.future_permission, "keep");

for (const maxRounds of [49, 50, 200, 0]) {
  assert.equal(normalizeCloneConfig({ id: maxRounds + 10, label: `r${maxRounds}`, maxRounds }).maxRounds, maxRounds);
}
assert.throws(() => normalizeCloneConfigs([{ id: 1, label: "A" }, { id: "1", label: "B" }]), /id 重复/);
assert.throws(() => normalizeCloneConfigs([{ id: 1, label: " A " }, { id: 2, label: "A" }]), /名称重复/);
assert.throws(() => normalizeCloneConfig({ id: 1, label: "A", maxRounds: 10001 }), /0-10000/);
assert.throws(() => normalizeCloneConfig({ id: 1, label: "A", temperature: Number.NaN }), /temperature/);
assert.throws(() => normalizeCloneConfig({ id: 1, label: "A", enabled: "true" }), /enabled/);
assert.throws(() => normalizeCloneConfig({ id: 1, label: "A", permissions: [] }), /permissions/);

const snapshot = { clones: [{ id: 1, label: "关闭", enabled: false }, { id: 2, label: "启用", enabled: true }] };
assert.equal(resolveCloneConfig(snapshot, {}, 1).label, "关闭", "inspect 默认允许读取关闭配置");
assert.throws(() => resolveCloneConfig(snapshot, {}, 1, { requireEnabled: true }), /已关闭/);
assert.throws(() => resolveCloneConfig(snapshot, { cloneName: "关闭" }, undefined, { requireEnabled: true }), /已关闭/);
assert.equal(resolveCloneConfig(snapshot, {}, undefined, { requireEnabled: true }).label, "启用");
assert.equal(resolveCloneMaxWorkRounds(50, 0), 0);
assert.throws(() => resolveCloneMaxWorkRounds(10001), /0-10000/);

console.log("clone config contract test passed: defaults, merge preservation, uniqueness, ranges, enabled execution gate");
