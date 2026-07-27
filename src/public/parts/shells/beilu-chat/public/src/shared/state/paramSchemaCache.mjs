/**
 * [paramSchemaCache.mjs] — 后端 PARAM_SCHEMA 的前端会话级缓存（链路2·可操作处禁硬编码）。
 *
 * 功能链：
 *   写入：featureControls.mjs _syncWebSearchFromBackend → GetData 响应带 param_schema
 *     （后端单源=yonban paramSchema.mjs，经 getDataHandler 下发）→ setParamSchema() 缓存
 *   消费：任何"渲染后才存在"的参数控件（子模式表单等 innerHTML 动态构造 DOM）→
 *     构造后调 applyParamSchemaToInputs(map) 覆盖 min/max/step
 *   退化：后端未下发/表单先于同步打开 → 控件保留静态 min/max/step 属性（离线/旧后端零回归），
 *     下次打开表单时若缓存已到则覆盖
 *
 * why：参数控件的值域元数据（min/max/step）此前散落在 index.html 属性与各面板 innerHTML
 *   字面量里（主面板 step0.01 vs 子模式表单 step0.1 各写各的），违反"控件限值必须来自
 *   后端/配置单源"。静态存在的控件由 featureControls._applyParamSchema 直接覆盖；
 *   动态构造的表单没有稳定 DOM 可提前覆盖，故需此缓存供构造后自取。
 *   只覆盖值域元数据，绝不动 value（value=用户当前值，归运行时参数链管）。
 */

let _schema = null;

/** featureControls 收到 GetData.param_schema 后写入（无效入参忽略，保留旧缓存） */
export function setParamSchema(schema) {
  if (schema && typeof schema === "object") _schema = schema;
}

/** 当前缓存（可能为 null=后端尚未同步） */
export function getParamSchema() {
  return _schema;
}

// 0714 enum_schema 接线（病型大扫·前后端对齐③-B）：枚举选项集缓存与 param_schema 同居本模块
//   （同为"后端权威清单下发"范式；后端单源=paramSchema.mjs ENUM_SCHEMA，经 GetData 下发）。
//   此前 enum_schema 只随 getSubModes 进 subModePanel 模块态，主面板 pp/prefill 下拉靠
//   HTML 静态 option=半接线（后端改选项集主面板不跟）。
let _enumSchema = null;

/** featureControls 收到 GetData.enum_schema 后写入（无效入参忽略，保留旧缓存） */
export function setEnumSchema(schema) {
  if (schema && typeof schema === "object") _enumSchema = schema;
}

/** 当前枚举选项集缓存（可能为 null=后端尚未同步/旧后端，消费方落静态退化） */
export function getEnumSchema() {
  return _enumSchema;
}

/**
 * 把缓存 schema 的 min/max/step 覆盖到一组输入控件
 * @param {Array<[string, string]>} map - [schema键, DOM id] 对
 * @returns {boolean} 是否实际应用（false=无缓存，控件保持静态退化值）
 */
export function applyParamSchemaToInputs(map) {
  if (!_schema) return false;
  for (const [key, elId] of map) {
    const meta = _schema[key];
    const el = document.getElementById(elId);
    if (!meta || !el) continue;
    if (Number.isFinite(meta.min)) el.min = String(meta.min);
    if (Number.isFinite(meta.max)) el.max = String(meta.max);
    if (Number.isFinite(meta.step)) el.step = String(meta.step);
    // [0727 凛倾「那些参数,默认值需要给一个,好参考」] 与 featureControls._applyParamSchema 同款：
    //   参考值单源=后端 PARAM_SCHEMA.default，数字框接 placeholder、其余控件接 title，零硬编码。
    if (meta.default !== undefined && meta.default !== null) {
      const _hint = `默认 ${meta.default}${Number.isFinite(meta.min) && Number.isFinite(meta.max) ? `（${meta.min}–${meta.max}）` : ""}`;
      el.title = _hint;
      if (el.tagName === "INPUT" && el.type === "number" && (!el.placeholder || el.placeholder === "默认")) el.placeholder = `默认 ${meta.default}`;
    }
  }
  return true;
}
