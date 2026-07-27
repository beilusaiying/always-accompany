// wbStub.mjs — 白盒埋点统一入口（惰性加载，失败静默，绝不影响主逻辑）
// 64 个文件各有一份逐字等价的本地 _wbEnsure/wbT/wbD 桩。本模块收敛为单一权威源。
let _wbMod = null, _wbInit = false;
function _wbEnsure() { if (_wbInit) return; _wbInit = true; import(new URL("./whitebox.mjs", import.meta.url).href).then(m => { _wbMod = m; }).catch(() => {}); }
export function wbT(chatid, line, node, data) { _wbEnsure(); try { _wbMod && _wbMod.wbTrace && _wbMod.wbTrace(chatid, line, node, data); } catch {} }
export function wbD(chatid, line, node, ok, msg, data) { _wbEnsure(); try { _wbMod && _wbMod.wbDetect && _wbMod.wbDetect(chatid, line, node, ok, msg, data); } catch {} return ok; }
