/**
 * imagePackRenderer.mjs — 图片模式渲染后端(桌宠形象的第二形态:图片包代替 Live2D)
 *
 * 功能链:
 *   live2dRenderer.mjs(路由层) 按 dict 条目 format==="image" 调 load(cfg, host)
 *     → fetch pack.json(cfg.url) → 解析 {expressions: 表情键→图片文件[], default, talk}
 *     → host 内建 <img>(contain 底对齐) → 显示默认表情
 *   setEmotion(tags) → 表情键解析(包自定义键精确匹配 > 别名撞库兜底) → 同键多张随机取一 → fade 换图
 *   talk(ms) → 有 talk 差分图则切差分,无则 CSS 轻微摇摆(优雅降级,同 _setP 范式)
 *
 * why(机制来源):
 *   克隆小圆2.html 图片机制(主AI 2026-07-09 亲读核实):
 *   · 同一表情键挂多张图、随机取一(CHARACTER_SPRITE_MAP:1651 数组值 + resolveSprite:2434)
 *   · 查不到键原样返回=AI 可输出特定键/直接文件名(resolveSprite:2432 passthrough)
 *   · fade 过渡(transition-group:1279)
 *   凛倾 2026-07-09:图片模式不需要背景;同表情多张随机;AI 可输出特定表情指令(键由包定义,管道不解释语义)。
 *
 * 关联链:
 *   ← live2dRenderer.mjs(唯一调用方/路由层,window.beiluLive2d 语义 API 统一在那边)
 *   ← pack.json(用户图片包清单,desktop-eye/user-images/<包名>/ 或 /api/eye/user-images/<包名>/)
 *   图片 URL 按 pack.json 绝对 URL 解析相对文件名(同 live2d 表情预载 new URL(file, baseUrl) 范式)。
 *
 * 影响范围:仅 #live2d-host 内的 DOM(<img> + style);不碰 PIXI/不碰 WS 订阅(路由层持有)。
 * 使用效果:AI 输出 <emotion>包内键</emotion> → 桌宠图片按键换图;同键多张时每次随机;说话时差分/摇摆。
 */

// pack 运行态(单实例:同一时刻只有一个形象后端激活,与 live2d 后端互斥)
let _host = null, _img = null, _cfg = null, _pack = null, _baseUrl = "";
let _curKey = "", _curFile = "", _talkTimer = null, _talkPrevKey = null;

// 动效参数默认值单源(任务⑥禁散落硬编码):pack.json 的 dynamics 字段可逐项覆盖(与 live2d _dyn 合并同构)。
const IMG_DYN_DEFAULT = { fadeMs: 220, talkWobbleDeg: 1.2, talkCapMs: 6000, nudgeGain: 0.06, nudgeMaxDeg: 6, nudgeResetMs: 350, tapLiftPx: 10, tapMs: 320 };
function _idyn() { return Object.assign({}, IMG_DYN_DEFAULT, (_pack && _pack.dynamics) || {}); }

// ── 表情键解析(小圆2 resolveSprite 机制) ──
// 顺序:① 包自定义键精确匹配(AI 特定指令,管道不解释) ② 键=图片文件名直接放行(passthrough)
//      ③ 别名撞库兜底(EMOTION_ALIASES 由路由层注入,撞包键的小写子串)。都不中→null(保持现状)。
let _aliases = {}; // 路由层注入(live2dRenderer EMOTION_ALIASES 单源,不再抄一份)
export function setAliases(map) { if (map && typeof map === "object") _aliases = map; }
// 触碰热区(pack.json.hitAreas 单源;命中判定/执行在路由层 hitAt,此处只交数据)。
// 作用域过滤(编辑器2.0,凛倾:"需要考虑多张图片"——不同立绘姿势不同,一套区对不上):
//   区.scope={file:"x.png"}=只在显示该图时生效;{key:"平静"}=该表情键的全部图;无 scope=全包。
export function getHitAreas() {
  const all = (_pack && Array.isArray(_pack.hitAreas)) ? _pack.hitAreas : [];
  return all.filter((a) => {
    const sc = a && a.scope;
    if (!sc || typeof sc !== "object") return true;
    if (sc.file) return sc.file === _curFile;
    if (sc.key) return sc.key === _curKey;
    return true;
  });
}
export function currentFile() { return _curFile || ""; }
export function currentKey() { return _curKey || ""; }
// 形象显示框(host 内 px):img 元素框=真实渲染范围(max 约束 contain+transform 缩放,getBoundingClientRect 已含)。
// 热区坐标系锚定此框而非容器——容器留白/宽高比在 web 预览与桌面窗不同,按容器切割=跨端命中错位(凛倾 2026-07-09 纠偏)。
export function fitRect() {
  if (!_img || !_host) return null;
  const hr = _host.getBoundingClientRect(), ir = _img.getBoundingClientRect();
  if (!hr.width || !ir.width || !ir.height) return null;
  return { x: ir.left - hr.left, y: ir.top - hr.top, w: ir.width, h: ir.height };
}
function _resolveKey(tag) {
  if (!tag || !_pack) return null;
  const ex = _pack.expressions || {};
  if (ex[tag]) return tag;                                   // ① 精确键
  const lower = String(tag).toLowerCase();
  for (const k in ex) { if (k.toLowerCase() === lower) return k; }
  // ② 文件名 passthrough(AI 直接点名某张图)
  for (const k in ex) {
    const arr = Array.isArray(ex[k]) ? ex[k] : [ex[k]];
    if (arr.includes(tag)) return k + "\u0000" + tag;        // 特定文件:键+文件复合(内部标记)
  }
  // ③ 别名撞库(alias 子串撞包键,同 live2d _resolveExpr 的 ② 段范式)。
  //   用户可覆盖(2026-07-09 凛倾"系统性硬编码"纠偏):pack.json.aliases[标签]=数组 优先于内建注入表——别名表不再是改源码才能扩的常量。
  const aliases = (_pack.aliases && Array.isArray(_pack.aliases[tag]) && _pack.aliases[tag]) || _aliases[tag] || [tag];
  for (const a of aliases) {
    const al = String(a).toLowerCase();
    for (const k in ex) { if (k.toLowerCase().indexOf(al) >= 0) return k; }
  }
  return null;
}
// 同键多张随机取一(小圆2 resolveSprite:2434);复合标记时取指定文件。
function _pickFile(resolved) {
  if (!resolved || !_pack) return null;
  const sep = resolved.indexOf("\u0000");
  if (sep >= 0) return resolved.slice(sep + 1); // AI 点名的特定文件
  const v = (_pack.expressions || {})[resolved];
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
function _fileUrl(file) {
  try { return new URL(file, _baseUrl).href; } catch (e) { return file; }
}

// fade 换图(小圆2 transition-group fade 同思路;时长走 _idyn().fadeMs)
function _swapTo(file) {
  if (!_img || !file || file === _curFile) return;
  _curFile = file;
  const url = _fileUrl(file);
  _img.style.opacity = "0";
  setTimeout(() => {
    if (!_img) return;
    _img.src = url;
    _img.style.opacity = "1";
  }, _idyn().fadeMs);
}

/**
 * 加载图片包并挂进 host。cfg=dict 条目 {name, format:"image", url:pack.json 绝对URL, scale?, yShiftRatio?}。
 * pack.json 结构(单源,编辑器写回同一文件):
 *   { "default": "neutral", "expressions": {"键": ["图1.png","图2.png"], ...}, "talk": ["说话差分.png"]? }
 * @returns {boolean} 加载成功与否(失败由路由层决定回退,不在此兜底)
 */
export async function load(cfg, host) {
  destroy(); // 幂等:清上一个实例
  _cfg = cfg; _host = host;
  try {
    // R1-SKIP: cfg.url=用户图片包 pack.json(file:// 或 /api/eye/user-images 静态资源),非受控 /api 业务端点。
    const r = await fetch(cfg.url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    _pack = await r.json();
  } catch (e) {
    console.warn("[imagePack] pack.json 读取失败:", cfg && cfg.url, e.message);
    _pack = null; return false;
  }
  if (!_pack || typeof _pack.expressions !== "object" || !Object.keys(_pack.expressions).length) {
    console.warn("[imagePack] 包内无 expressions 定义:", cfg && cfg.name);
    _pack = null; return false;
  }
  // 基址绝对化(追链发现的坑):web 端条目 url 是根相对路径("/api/eye/user-images/…/pack.json"),
  // new URL(file, 相对base) 会 TypeError → 图片全 404。按页面地址先绝对化;file://(Electron)本就绝对,原样。
  try { _baseUrl = new URL(cfg.url, (typeof location !== "undefined" ? location.href : undefined)).href; }
  catch (e) { _baseUrl = cfg.url; }
  _img = document.createElement("img");
  _img.id = "imagepack-avatar";
  _img.alt = cfg.name || "avatar";
  // 布局:contain 底对齐居中(与 live2d contain-fit 同语义)。缩放优先级:pack.json.scale(编辑器可改) > dict 条目 > 1。
  // 视口(凛倾 2026-07-13"缩放不只是按照比例,还可以专门显示那一部分"):scale>1+xShift/yShift=只显示形象某部分,
  // 与 live2d relayout 同三字段同语义(pack.json 优先 > dict 条目;web 微调控件/saveUserModel 同链写)。
  // yShiftRatio 缺省=保持原"底对齐"行为(桌宠站地惯例);设了=形象中心定位到 (xShift,yShift),溢出被窗口裁掉=视口效果。
  const scale = (typeof _pack.scale === "number" && _pack.scale > 0) ? _pack.scale
    : ((typeof cfg.scale === "number" && cfg.scale > 0) ? cfg.scale : 1);
  const _xs = (typeof _pack.xShiftRatio === "number") ? _pack.xShiftRatio
    : ((typeof cfg.xShiftRatio === "number") ? cfg.xShiftRatio : 0.5);
  const _ys = (typeof _pack.yShiftRatio === "number") ? _pack.yShiftRatio
    : ((typeof cfg.yShiftRatio === "number") ? cfg.yShiftRatio : null);
  const _posCss = (_ys === null)
    ? "left:" + (_xs * 100) + "%;bottom:0;transform:translateX(-50%) scale(" + scale + ");transform-origin:bottom center;"
    : "left:" + (_xs * 100) + "%;top:" + (_ys * 100) + "%;transform:translate(-50%,-50%) scale(" + scale + ");transform-origin:center center;";
  _img.style.cssText =
    "position:absolute;" + _posCss +
    "max-width:100%;max-height:100%;object-fit:contain;" +
    "transition:opacity .22s ease, transform .3s ease;user-select:none;-webkit-user-drag:none;";
  host.appendChild(_img);
  // 默认表情(包声明 default,缺省取第一个键)
  const defKey = (_pack.default && _pack.expressions[_pack.default]) ? _pack.default : Object.keys(_pack.expressions)[0];
  _curKey = defKey;
  const f = _pickFile(defKey);
  if (f) {
    _curFile = f; _img.src = _fileUrl(f);
    // 等首图解码完成再返回:壳侧 init 后立刻读 _metrics().internal 上报窗口比例,未解码时 naturalWidth=0。
    try { await _img.decode(); } catch (e) { /* 解码失败(404/格式):保留 img,onerror 面由后续换图救 */ }
  }
  console.log("[imagePack] 图片包就绪:", cfg.name, "| 表情键", Object.keys(_pack.expressions).length, "个");
  return true;
}

/** 视口即时预览(拖拽定位/微调控件用):改中心定位比例,不动 scale。持久化走 saveUserModel 同链(此处只预览)。 */
export function setViewport(x, y) {
  if (!_img) return;
  const _sc = /scale\(([^)]+)\)/.exec(_img.style.transform);
  const s = _sc ? _sc[1] : "1";
  const xs = Math.max(0, Math.min(1, Number(x)));
  const ys = Math.max(0, Math.min(1, Number(y)));
  if (!Number.isFinite(xs) || !Number.isFinite(ys)) return;
  _img.style.left = (xs * 100) + "%";
  _img.style.bottom = "";
  _img.style.top = (ys * 100) + "%";
  _img.style.transform = "translate(-50%,-50%) scale(" + s + ")";
  _img.style.transformOrigin = "center center";
}

export function destroy() {
  if (_talkTimer) { clearTimeout(_talkTimer); _talkTimer = null; }
  if (_img) { try { _img.remove(); } catch (e) {} }
  _img = null; _pack = null; _cfg = null; _curKey = ""; _curFile = ""; _talkPrevKey = null;
}

export function ready() { return !!(_img && _pack); }
export function getName() { return (_cfg && _cfg.name) || ""; }

/** 表情切换入口(路由层 setEmotion 的图片分支)。tags=已拆分的标签数组。返回是否命中。 */
export function setEmotion(tags) {
  if (!ready()) return false;
  for (const tag of tags) {
    const key = _resolveKey(tag);
    if (key != null) {
      _curKey = key.indexOf("\u0000") >= 0 ? key.slice(0, key.indexOf("\u0000")) : key;
      const f = _pickFile(key);
      if (f) _swapTo(f);
      return true;
    }
  }
  return false; // 无命中:保持现状(小圆2 unmapped 不换图同语义)
}

/** 说话:有 talk 差分图切差分,结束回当前表情;无差分=CSS 轻微摇摆(优雅降级)。 */
export function talk(ms) {
  if (!ready() || !(ms > 0)) return;
  if (_talkTimer) { clearTimeout(_talkTimer); _talkTimer = null; }
  const talkArr = Array.isArray(_pack.talk) ? _pack.talk : [];
  const d = _idyn();
  if (talkArr.length) {
    if (_talkPrevKey == null) _talkPrevKey = _curKey;
    _swapTo(talkArr[Math.floor(Math.random() * talkArr.length)]);
  } else {
    // 摇摆:transform 追加轻微 rotate,动画期自复位(不叠加 scale 之外的持久态)
    _img.style.transform += " rotate(" + d.talkWobbleDeg + "deg)";
    setTimeout(() => { if (_img) _img.style.transform = _img.style.transform.replace(/ rotate\([^)]*\)/g, ""); }, d.nudgeResetMs);
  }
  _talkTimer = setTimeout(() => stopTalk(), Math.min(d.talkCapMs, ms));
}
export function stopTalk() {
  if (_talkTimer) { clearTimeout(_talkTimer); _talkTimer = null; }
  if (_talkPrevKey != null) {
    const f = _pickFile(_talkPrevKey);
    _talkPrevKey = null;
    if (f) _swapTo(f);
  }
}

/** 点击反馈:轻弹(与 live2d-pet 兜底 pf-tap 同感)。 */
export function tap() {
  if (!ready()) return false;
  const d = _idyn();
  _img.animate(
    [{ transform: _img.style.transform }, { transform: _img.style.transform + " translateY(-" + d.tapLiftPx + "px)" }, { transform: _img.style.transform }],
    { duration: d.tapMs, easing: "ease" },
  );
  return true;
}

/** 拖动跟随:轻微倾斜后回正(替 live2d nudge 的 ParamBodyAngleZ)。 */
let _nudgeReset = null;
export function nudge(vx) {
  if (!ready() || !vx) return;
  const d = _idyn();
  const deg = Math.max(-d.nudgeMaxDeg, Math.min(d.nudgeMaxDeg, vx * d.nudgeGain));
  _img.style.transform = _img.style.transform.replace(/ rotate\([^)]*\)/g, "") + " rotate(" + deg.toFixed(2) + "deg)";
  if (_nudgeReset) clearTimeout(_nudgeReset);
  _nudgeReset = setTimeout(() => { if (_img) _img.style.transform = _img.style.transform.replace(/ rotate\([^)]*\)/g, ""); }, d.nudgeResetMs);
}

// ── 魔法棒式不透明边界检测(凛倾 2026-07-12:命中/捕捉按图片实际内容,不按整张含透明边的 PNG 元素框) ──
// 立绘 PNG 常带大片透明边距,元素框≠角色实际范围→桌宠命中盒虚大/错位。canvas 读 alpha 求内容包围盒,
// 每个已显示的图 URL 扫一次缓存(keyed by currentSrc:fade 换图期间 src 未切时不会用新键扫旧图)。
// 失败(canvas 污染/解码异常)=null → 诚实降级回元素框,不编造边界。
const _bboxCache = new Map(); // currentSrc → {x,y,w,h}(natural px) | null
let _bboxAlphaMin = 10; // alpha 阈值:>阈值视为内容(排除近全透明噪点)。默认10=原硬编码值。
// 阈值可配(凛倾 2026-07-13"为什么要设置硬编码":单源=pet_settings.alphaHitThreshold,
// 链路=web设置中心/托盘→beilu store→桌宠主进程 sendPetConfig→live2d-pet.html→本 setter)。
// 变更即清 bbox 缓存(缓存值是按旧阈值扫的);非法值忽略=保持现值,不编造。
export function setAlphaHitThreshold(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 255) return;
  if (Math.round(n) === _bboxAlphaMin) return;
  _bboxAlphaMin = Math.round(n);
  _bboxCache.clear();
}
function _scanOpaqueBBox(img) {
  const key = img.currentSrc || img.src;
  if (!key) return null;
  if (_bboxCache.has(key)) return _bboxCache.get(key);
  let out = null;
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (w && h) {
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, w, h).data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          if (d[row + x * 4 + 3] > _bboxAlphaMin) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX >= minX && maxY >= minY) out = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }
  } catch (e) { out = null; }
  _bboxCache.set(key, out);
  return out;
}
// 当前显示图的不透明内容框(viewport px):natural bbox 按 元素框/natural 比例映射。无 bbox=null。
function _contentBox() {
  if (!_img || !_img.naturalWidth || !_img.naturalHeight) return null;
  const bb = _scanOpaqueBBox(_img);
  if (!bb) return null;
  const r = _img.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const sx = r.width / _img.naturalWidth, sy = r.height / _img.naturalHeight;
  return { x: r.x + bb.x * sx, y: r.y + bb.y * sy, w: bb.w * sx, h: bb.h * sy };
}

// ── 像素级命中二级判定(T3 airi 式,凛倾拍板 tasks#11):包围盒只判"在角色矩形内",本函数再判"该点是否真有内容"。
// 单点采样:1×1 canvas drawImage 源裁剪一像素(不整图 getImageData,无大缓存),阈值与包围盒同源 _bboxAlphaMin。
// 消费方=桌宠壳 live2d-pet.html 经 window.beiluLive2d.pixelHitAt 转发(主进程穿透判定二级细化)。
// 返回:true=不透明(命中)/false=透明(穿透)/null=无法判定(canvas 污染/未解码)→调用方降级回包围盒,不编造。
let _pxCv = null, _pxCtx = null;
export function pixelHitAt(clientX, clientY) {
  if (!_img || !_img.naturalWidth || !_img.naturalHeight) return null;
  try {
    const r = _img.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    if (clientX < r.x || clientX >= r.x + r.width || clientY < r.y || clientY >= r.y + r.height) return false; // 元素框外=必透明
    // 元素框→natural 线性映射:_img 只有 max-width/height 约束,元素框自持天然宽高比(与 _contentBox 同映射假设)。
    const nx = Math.floor((clientX - r.x) / r.width * _img.naturalWidth);
    const ny = Math.floor((clientY - r.y) / r.height * _img.naturalHeight);
    if (!_pxCtx) {
      _pxCv = document.createElement("canvas");
      _pxCv.width = 1; _pxCv.height = 1;
      _pxCtx = _pxCv.getContext("2d", { willReadFrequently: true });
    }
    _pxCtx.clearRect(0, 0, 1, 1);
    _pxCtx.drawImage(_img, nx, ny, 1, 1, 0, 0, 1, 1);
    return _pxCtx.getImageData(0, 0, 1, 1).data[3] > _bboxAlphaMin;
  } catch (e) { return null; }
}
/** 当前 alpha 命中阈值(单源读口:live2d 侧 gl.readPixels 判定与本模块同阈,不抄副本)。 */
export function alphaHitThreshold() { return _bboxAlphaMin; }

/** 观测(壳侧命中测试/比例上报兼容 live2d _metrics 形状):internal=图片天然尺寸,
 *  bounds=不透明内容框(魔法棒;唯一消费方=桌宠壳命中判定,已全 grep 核实),扫描失败降级元素框。 */
export function metrics() {
  if (!ready()) return null;
  const b = _img.getBoundingClientRect();
  const cb = _contentBox();
  return {
    internal: { w: _img.naturalWidth || b.width, h: _img.naturalHeight || b.height },
    container: { w: b.width, h: b.height, scale: (_cfg && _cfg.scale) || 1 },
    bounds: cb
      ? { x: Math.round(cb.x), y: Math.round(cb.y), w: Math.round(cb.w), h: Math.round(cb.h) }
      : { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    host: { w: _host && _host.clientWidth, h: _host && _host.clientHeight },
    rotation: 0, lean: 0,
  };
}

/** 当前包可用表情键(编辑器/调试/提示词侧读单源)。 */
export function listKeys() { return _pack ? Object.keys(_pack.expressions || {}) : []; }
/** 动效参数默认值导出(编辑器回填占位用,前端不再抄默认副本)。 */
export function dynDefaults() { return { ...IMG_DYN_DEFAULT }; }
