// pluginListSlot.mjs — 设置面板·插件列表 slot（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
import { escapeHtml } from "../../../shared/state/utils.mjs";
import { sendAction } from "../../../shared/transport/sendAction.mjs";
import { getPartList, getLoadedPartList, getAllCachedPartDetails } from "../../../../../../../scripts/parts.mjs";

// ============================================================
// 插件列表 slot (W46新增: 替代iframe)
// ============================================================

// A7: 插件 icon / 中文 desc 仅为纯 UI 文案（只存前端，不入后端单源），保留为元数据映射。
// 渲染源真相 = 后端 getPartList('plugins')（已安装插件目录全集），后端新增插件自动出现；
// 映射里没有的插件用兜底 icon/desc 渲染。不再写死插件数量，三方数字不一致(代码15/注释16/历史17)问题随动态化消除。
const PLUGIN_META = {
  "beilu-memory": { icon: '<i data-ic="brain"></i>', desc: "记忆系统核心" },
  "beilu-preset": { icon: '<i data-ic="clipboard"></i>', desc: "预设引擎" },
  "beilu-worldbook": { icon: '<i data-ic="book"></i>', desc: "世界书注入" },
  "beilu-mvu": { icon: '<i data-ic="chart"></i>', desc: "MVU变量系统" },
  "beilu-files": { icon: '<i data-ic="folder"></i>', desc: "文件操作沙箱" },
  "beilu-web": { icon: '<i data-ic="earth"></i>', desc: "联网搜索/浏览" },
  "beilu-plugin-host": { icon: '<i data-ic="plug"></i>', desc: "用户外部插件" },
  "beilu-eye": { icon: '<i data-ic="camera"></i>', desc: "桌面截图" },
  "beilu-toggle": { icon: '<i data-ic="shuffle"></i>', desc: "AI条目控制" },
  "beilu-sysinfo": { icon: '<i data-ic="info"></i>', desc: "系统信息注入" },
  "beilu-vectordb": { icon: '<i data-ic="search"></i>', desc: "向量搜索" },
  "beilu-ejs": { icon: '<i data-ic="edit"></i>', desc: "EJS模板渲染" },
  "beilu-regex": { icon: '<i data-ic="scissors"></i>', desc: "正则替换引擎" },
  "beilu-logger": { icon: '<i data-ic="edit"></i>', desc: "日志记录" },
};

export async function initPluginListSlot() {
  const slot = document.getElementById("settings-plugin-list");
  if (!slot) return;

  try {
    // 渲染源真相：后端已安装插件全集（GET /api/getlist/plugins，server/web_server/endpoints.mjs:563 → getPartList(username,'plugins')）
    // 后端单源 → 后端新增插件无需改前端即显示，根除写死清单漂移。失败时回退 PLUGIN_META 键集（已知插件，仍非硬编码数量）。
    let pluginNames = [];
    try {
      const _all = await getPartList("plugins");
      if (Array.isArray(_all)) pluginNames = _all;
    } catch {}
    if (!pluginNames.length) pluginNames = Object.keys(PLUGIN_META);

    // 获取当前chat已注册的插件（仅用于标"本对话启用"，非渲染源）
    // 补修（同族收口）：切守卫单源 getChatId（sharedState.mjs:108，内含 _CHATID_RE 校验）——非法 hash
    //   （分段气泡/IDE 内部锚点）返 ""，走下方 if(hash) false 分支不拼进 URL path segment，避免坏请求/404。
    //   对齐 cardsPanel.mjs:62 _cur()/featureControls.mjs:60 范式（window 全局桥单源，无需新增 import）。
    const hash = window._beiluGetChatId?.() || "";

    // 三路并行：描述后端单源(getallcacheddetails，info.json 本地化文案——新插件不再缺描述)
    //   + 真实加载态(getloadedlist = parts_set 实况；启动全量预加载 fullLoadAllParts 后正常应全部已加载)
    //   + 当前对话注册表。原"活跃/待机"语义=对话注册，与用户理解的"插件加载好没有"错位，拆成两个独立标记。
    const [detailsRes, loadedRes, registeredRes] = await Promise.allSettled([
      getAllCachedPartDetails("plugins"),
      getLoadedPartList("plugins"),
      // T2批23：静默降级读 → getChatPluginsQuiet（notify:"report"）。非 2xx sendAction throw 进 catch侧，registeredPlugins 保持 []。
      hash ? sendAction({ verb: "getChatPluginsQuiet", target: "shells:chat", source: "web", scope: { chatId: hash } }) : Promise.resolve([]),
    ]);
    const detailsMap = detailsRes.status === "fulfilled" ? (detailsRes.value?.cachedDetails || {}) : {};
    const loadedSet = new Set(loadedRes.status === "fulfilled" && Array.isArray(loadedRes.value)
      ? loadedRes.value.map(p => p.split("/").pop()) : []);
    const registeredPlugins = registeredRes.status === "fulfilled" && Array.isArray(registeredRes.value) ? registeredRes.value : [];
    const registeredNames = registeredPlugins.map(p => typeof p === "string" ? p : p.name || "");

    slot.innerHTML = pluginNames.map(name => {
      const meta = PLUGIN_META[name] || { icon: '<i data-ic="puzzle"></i>', desc: "" };
      const info = detailsMap[name]?.info || {};
      const desc = info.description || meta.desc;
      const loaded = loadedSet.has(name);
      const inChat = registeredNames.some(n => n.includes(name));
      return `<div class="flex items-center gap-2 p-2 bg-base-200/50 rounded text-xs">
        <span>${meta.icon}</span>
        <span class="font-mono shrink-0">${escapeHtml(name)}</span>
        <span class="flex-1 text-base-content/50 truncate" title="${escapeHtml(desc)}">${escapeHtml(desc)}</span>
        ${inChat ? '<span class="text-info text-[10px] shrink-0">本对话启用</span>' : ''}
        <span class="${loaded ? 'text-success' : 'text-base-content/50'} text-[10px] shrink-0">${loaded ? '● 已加载' : '○ 未加载'}</span>
      </div>`;
    }).join("");
  } catch (err) {
    slot.innerHTML = `<p class="text-xs text-error">加载失败: ${err.message}</p>`;
  }
}
