// apiSlot.mjs — 设置面板·AI服务源管理 slot（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
// 注：API_BASE/SERVICE_TYPE 为 T2批1收口后的死常量（原文件即无消费点），原样保留不顺手删。
import { escapeHtml } from "../../../shared/state/utils.mjs";
import { sendAction } from "../../../shared/transport/sendAction.mjs";
import { storage, KEYS } from "../../../shared/state/storage.mjs";
import { beiluConfirm, beiluPrompt } from "../../../shared/widgets/beiluDialog.mjs";
import { saveReasoningTags, saveBeiluThinkingStrip } from "../../../shared/state/reasoningTags.mjs";
import { loadChannels, modelsRequestFor } from "../apiChannels.mjs";
import { assertApiSourceReadback, isApiSourceMarkedUsable } from "../apiSourceContract.mjs";

// ============================================================
// AI服务源管理 slot (W63新增: 完整CRUD + Fetch Models)
// ============================================================

const API_BASE = '/api/parts/shells:serviceSourceManage';
const SERVICE_TYPE = 'AI';

// SETTINGS_API_TYPES 硬编码两项表已删（0711 渠道下拉恢复）：类型=渠道，表由 apiChannels.loadChannels()
// 从后端 PROVIDER_META 单源构建（禁前端另写枚举/URL/文案，apiAdapters.mjs:29 裁决）

export async function initApiSlot() {
  const slot = document.getElementById("settings-api-slot");
  if (!slot) return;

  // 渠道表先于 DOM 构建（后端 PROVIDER_META 单源；失败内部降级基础两项，面板不空转）
  const CH = await loadChannels();

  slot.innerHTML = `
    <div class="space-y-3 mt-2">
      <!-- 选择 -->
      <div class="flex items-center gap-2">
        <select id="sa-api-select" class="select select-sm select-bordered flex-1"></select>
        <button id="sa-api-new" class="btn btn-sm btn-outline btn-success" title="新建">＋</button>
        <button id="sa-api-delete" class="btn btn-sm btn-outline btn-error" title="删除" disabled><i data-ic="trash"></i></button>
      </div>
      <!-- 名称+类型（类型=渠道，选中即声明 convert_config.provider） -->
      <div class="flex items-center gap-2">
        <input id="sa-api-name" class="input input-sm input-bordered flex-1" placeholder="配置名称" />
        <select id="sa-api-type" class="select select-sm select-bordered w-44">
          ${CH.channels.map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`).join('')}
        </select>
      </div>
      <!-- 渠道坑提示（后端 PROVIDER_META.hint；只提示不改参数，0708 裁决） -->
      <div id="sa-api-hint" class="hidden text-[11px] text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1"></div>
      <!-- URL（可改可清空；「恢复默认」回填后端默认端点） -->
      <div>
        <label class="text-xs opacity-60" id="sa-api-url-label">API URL</label>
        <div class="flex items-center gap-2">
          <input id="sa-api-url" class="input input-sm input-bordered flex-1" />
          <button id="sa-api-url-reset" class="btn btn-sm btn-outline" title="恢复该渠道的默认地址">恢复默认</button>
        </div>
      </div>
      <!-- API Key -->
      <div>
        <label class="text-xs opacity-60">API Key</label>
        <input id="sa-api-key" type="password" class="input input-sm input-bordered w-full" placeholder="sk-..." />
      </div>
      <!-- Model -->
      <div>
        <label class="text-xs opacity-60">模型</label>
        <div class="flex items-center gap-2">
          <input id="sa-api-model" class="input input-sm input-bordered flex-1" placeholder="模型名称" />
          <button id="sa-api-fetch" class="btn btn-sm btn-outline btn-info">获取模型</button>
        </div>
        <select id="sa-api-model-list" class="select select-sm select-bordered w-full mt-1 hidden"></select>
      </div>
      <!-- 思维链模式（2026-08-01 凛倾收口：thinking 控制唯一入口=本面板 per-源；三态+默认，
           按 convert_config.provider 在后端 applyThinkingMode 映射成各家参数，见 providerPatch.mjs） -->
      <div class="form-control">
        <label class="label py-0.5">
          <span class="label-text text-xs"><i data-ic="brain"></i> 思维链（Thinking / CoT）</span>
        </label>
        <select id="sa-api-thinking-mode" class="select select-sm select-bordered w-full">
          <option value="">渠道默认（不发参数）</option>
          <option value="off">关闭思维链 · 最快直接输出</option>
          <option value="standard">标准思维链 · 平衡速度和质量</option>
          <option value="max">最大思维链 · 最深推理</option>
        </select>
        <span class="text-[9px] text-base-content/50 pl-1">按渠道自动映射参数（DeepSeek/Kimi: thinking.type；Claude: thinking+effort；OpenAI系: reasoning_effort）。部分模型不可关（Gemini 2.5 Pro、kimi-k2.7-code、Claude Fable），强关会由 API 报错提示。</span>
      </div>
      <div class="form-control">
        <label class="label py-0.5 cursor-pointer justify-start gap-2">
          <input id="sa-api-ide-tool-results-as-user" type="checkbox" class="checkbox checkbox-sm checkbox-primary" />
          <span class="label-text text-xs">将 IDE 工具结果作为 user 发送</span>
        </label>
        <span class="text-[9px] text-base-content/50 pl-1">默认关闭。开启后只改变发给当前 AI 源的 IDE 工具回执角色，不修改聊天记录，也不改变其他 system 提示词；可让要求以 user 作为最新输入的模型或缓存机制正确识别工具续轮。</span>
      </div>
      <!-- 操作 -->
      <div class="flex gap-2">
        <button id="sa-api-save" class="btn btn-sm btn-primary flex-1"><i data-ic="save"></i> 保存</button>
      </div>
      <div id="sa-api-status" class="text-xs text-center hidden"></div>
      <!-- [0727 并发闸] 用户级 AI 并发上限（全局总闸，非 per-源参数，故放保存按钮之外、改动即存） -->
      <div class="divider text-xs opacity-40 mt-4">并发控制</div>
      <div class="form-control">
        <label class="label py-0.5">
          <span class="label-text text-xs"><i data-ic="zap"></i> AI 并发上限（0=不限）</span>
          <span id="sa-ai-concurrency-status" class="label-text-alt font-mono text-xs opacity-60"></span>
        </label>
        <input type="number" id="sa-ai-concurrency" min="0" max="99" step="1" placeholder="0" class="input input-sm input-bordered w-full font-mono" />
        <span class="text-[9px] text-base-content/50 pl-1 mt-1">同时最多几路 AI 在跑（含所有窗口+分身+记忆AI）。本体优先于分身；本体忙时分身自动排队逐个执行。改动即存即生效。</span>
      </div>
    </div>
  `;

  let currentName = null;
  let apiSources = [];
  let loadSourceRequestId = 0;
  const $ = id => slot.querySelector('#' + id);
  // 根病2 单向同步修(步骤0):自抑制本面板自身派发(复刻 apiConfig.mjs:88-93),避免步骤1监听器在本面板保存/删除/新建后重复刷新自己。
  let _suppressApiReload = false;
  const _emitApiChanged = () => {
    _suppressApiReload = true;
    try { window.dispatchEvent(new CustomEvent('resource:api-changed')); }
    finally { _suppressApiReload = false; }
  };

  const showStatus = (msg, type = 'info') => {
    const el = $('sa-api-status');
    el.textContent = msg;
    el.className = `text-xs text-center mt-1 ${type === 'success' ? 'text-success' : type === 'error' ? 'text-error' : 'text-warning'}`;
    el.classList.remove('hidden');
    if (type === 'success') setTimeout(() => el.classList.add('hidden'), 2000);
  };

  // [0727 并发闸] AI 并发上限接线：后端 yonban_config.ai_max_concurrent 单源（GET 回显 / change 即存），
  //   值域校验在后端 endpoints（0-99 整数），前端只 clamp 展示——操作界面三原则：选项限值来自后端。
  {
    const concInput = $('sa-ai-concurrency');
    const concStatus = $('sa-ai-concurrency-status');
    if (concInput) {
      sendAction({ verb: 'getAiConcurrency', target: 'shells:chat', source: 'web' })
        .then((r) => { concInput.value = String(r?.limit ?? 0); })
        .catch(() => { /* 读失败保持占位（0=不限），不阻断面板初始化 */ });
      concInput.addEventListener('change', async () => {
        const n = Math.max(0, Math.min(99, parseInt(concInput.value, 10) || 0));
        concInput.value = String(n);
        try {
          const r = await sendAction({ verb: 'setAiConcurrency', target: 'shells:chat', source: 'web', payload: { limit: n } });
          if (concStatus) {
            concStatus.textContent = (r?.limit ?? n) > 0 ? `已生效: ${r.limit}` : '不限';
            setTimeout(() => { if (concStatus) concStatus.textContent = ''; }, 3000);
          }
        } catch (err) {
          if (concStatus) concStatus.textContent = '保存失败';
          window._reportError?.(`[settingsSlots] setAiConcurrency: ${err.message}`, err.stack);
        }
      });
    }
  }

  // 未知生成器（claude-api/grok/polling…）的临时渠道项：只在加载到该源时注入下拉，
  // 保存不动 generator/provider（修 0711 前旧病：未知生成器被强转 proxy=错绑）
  let _tempEntry = null;
  // 「用户没改过 URL」判据：值为空或仍等于上个渠道的默认值 → 切渠道时才自动换成新默认
  let _lastDefaultUrl = '';

  const curEntry = () => {
    const v = $('sa-api-type').value;
    if (_tempEntry && _tempEntry.value === v) return _tempEntry;
    return CH.byValue.get(v) || null;
  };

  const removeTempOption = () => {
    _tempEntry = null;
    $('sa-api-type').querySelector('option[data-temp]')?.remove();
  };

  const ensureTempOption = (entry) => {
    removeTempOption();
    _tempEntry = entry;
    const opt = document.createElement('option');
    opt.value = entry.value;
    opt.textContent = entry.label;
    opt.dataset.temp = '1';
    $('sa-api-type').appendChild(opt);
  };

  const syncChannelUI = () => {
    const e = curEntry();
    $('sa-api-url-label').textContent = e?.urlLabel || 'API URL';
    $('sa-api-url').placeholder = e?.defaultUrl || '';
    const hintEl = $('sa-api-hint');
    hintEl.textContent = e?.hint || '';
    hintEl.classList.toggle('hidden', !e?.hint);
    $('sa-api-url-reset').classList.toggle('hidden', !e?.defaultUrl);
  };

  const clearForm = () => {
    currentName = null;
    removeTempOption();
    $('sa-api-name').value = '';
    $('sa-api-url').value = '';
    $('sa-api-key').value = '';
    $('sa-api-model').value = '';
    $('sa-api-delete').disabled = true;
    $('sa-api-model-list').classList.add('hidden');
    _lastDefaultUrl = curEntry()?.defaultUrl || '';
    syncChannelUI();
  };

  const loadList = async () => {
    try {
      // T2批1收口：raw GET → sendAction 门面（shells:serviceSourceManage#getAISources REST 精确路由，回包=数组裸体等价）
      apiSources = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" });
      const sel = $('sa-api-select');
      sel.innerHTML = apiSources.length === 0
        ? '<option value="">（无配置）</option>'
        : apiSources.map(n => `<option value="${escapeHtml(n)}" ${n === currentName ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
      return true;
    } catch (e) {
      showStatus('加载列表失败: ' + e.message, 'error');
      return false;
    }
  };

  const loadSource = async (name) => {
    if (!name) return false;
    const requestId = ++loadSourceRequestId;
    currentName = name;
    $('sa-api-select').value = name;
    try {
      // T2批1收口：raw GET 单源 → sendAction 门面（getAISource REST，回包 {generator,config} 裸体等价）
      const data = await sendAction({ verb: "getAISource", target: "shells:serviceSourceManage", source: "web", payload: { name } });
      // A→B 快速切换时，A 的慢响应不得填回 B 的表单；过期请求是正常取消，不算刷新失败。
      if (requestId !== loadSourceRequestId || currentName !== name) return true;
      const gen = typeof data?.generator === 'string' ? data.generator.trim() : '';
      const cfg = data?.config && typeof data.config === 'object' && !Array.isArray(data.config) ? data.config : {};
      $('sa-api-name').value = cfg.name || name;
      if (!gen) {
        // 旧空壳必须如实展示并允许用户选定渠道后修复；不能解释成 proxy。
        removeTempOption();
        $('sa-api-url').value = cfg.url || cfg.base_url || cfg.host || '';
        $('sa-api-key').value = cfg.apikey || '';
        $('sa-api-model').value = cfg.model || '';
        $('sa-api-delete').disabled = false;
        $('sa-api-model-list').classList.add('hidden');
        _lastDefaultUrl = '';
        syncChannelUI();
        showStatus('该配置缺少渠道；请选择渠道后重新保存。', 'error');
        return false;
      }
      const chValue = CH.valueFor(gen, cfg);
      let entry;
      if (chValue) {
        removeTempOption();
        $('sa-api-type').value = chValue;
        entry = curEntry();
      } else {
        // 未知生成器：按配置实有键探测地址字段，保存时保留原 generator
        const urlField = ['url', 'base_url', 'host'].find((k) => k in cfg) || 'url';
        ensureTempOption({
          value: `__gen:${gen}`, label: `${gen}（其他生成器）`, generator: gen, provider: '',
          urlField, urlLabel: `API 地址（字段：${urlField}）`, defaultUrl: '',
          hint: '此生成器的专项参数请在服务源管理页配置；这里保存只更新名称/地址/密钥/模型',
        });
        $('sa-api-type').value = `__gen:${gen}`;
        entry = _tempEntry;
      }
      $('sa-api-url').value = cfg[entry.urlField] || '';
      _lastDefaultUrl = entry.defaultUrl || '';
      $('sa-api-key').value = cfg.apikey || '';
      $('sa-api-model').value = cfg.model || '';
      $('sa-api-delete').disabled = false;
      $('sa-api-model-list').classList.add('hidden');
      // 思维链模式回显（per-源）：新键 thinking_mode 优先；旧 boolean extended_thinking 迁移显示
      //   （true=standard，false/缺失=渠道默认），与后端 httpFetch 迁移语义一致
      const _thinkModeEl = $('sa-api-thinking-mode');
      if (_thinkModeEl) {
        _thinkModeEl.value = (cfg.thinking_mode !== undefined && cfg.thinking_mode !== null && cfg.thinking_mode !== '')
          ? cfg.thinking_mode
          : (cfg.extended_thinking ? 'standard' : '');
      }
      const _toolResultRoleEl = $('sa-api-ide-tool-results-as-user');
      if (_toolResultRoleEl) {
        _toolResultRoleEl.checked = cfg.convert_config?.ide_tool_results_as_user === true;
      }
      syncChannelUI();
      return true;
    } catch (e) { showStatus('加载失败: ' + e.message, 'error'); return false; }
  };

  // Events
  $('sa-api-select').addEventListener('change', () => loadSource($('sa-api-select').value));
  $('sa-api-type').addEventListener('change', () => {
    // 用户没改过 URL（空或=上个渠道默认）才自动换新默认；改过的值不动（凛倾：可删可改）
    const entry = curEntry();
    if (!entry) return;
    const u = $('sa-api-url');
    if (!u.value || u.value === _lastDefaultUrl) u.value = entry.defaultUrl || '';
    _lastDefaultUrl = entry.defaultUrl || '';
    syncChannelUI();
  });
  $('sa-api-url-reset').addEventListener('click', () => {
    const entry = curEntry();
    if (!entry) return;
    $('sa-api-url').value = entry.defaultUrl || '';
    _lastDefaultUrl = entry.defaultUrl || '';
  });

  // （旧 Extended Thinking 开关/预算联动已删——2026-08-01 三态下拉无需联动）

  $('sa-api-save').addEventListener('click', async () => {
    if (!currentName) { showStatus('请先选择或新建配置', 'error'); return; }
    const sourceName = currentName;
    const entry = curEntry();
    if (!entry) { showStatus('请先选择一个 API 渠道', 'error'); return; }
    const isTempEntrySnapshot = entry === _tempEntry;
    // 点击时冻结表单；getAISource 等待期间即使切换源，也不能把后一个源的 DOM 值写进 sourceName。
    const formSnapshot = {
      name: $('sa-api-name').value.trim(),
      apikey: $('sa-api-key').value.trim(),
      model: $('sa-api-model').value.trim(),
      url: $('sa-api-url').value.trim(),
      thinkingMode: $('sa-api-thinking-mode')?.value || '',
      ideToolResultsAsUser: $('sa-api-ide-tool-results-as-user')?.checked === true,
    };
    let baseCfg = {};
    try {
      baseCfg = (await sendAction({ verb: "getAISource", target: "shells:serviceSourceManage", source: "web", payload: { name: sourceName } })).config || {};
    } catch (e) {
      // 已有源读失败时禁止拿空对象继续覆盖；保留原配置并让错误对用户可见。
      showStatus('无法读取现有配置，已停止保存: ' + e.message, 'error');
      return;
    }
    // 0714 trim：name/key/model/url 全字段去首尾空白（脏 URL 曾致后端 getModels 解析炸=模型下拉静默空）
    baseCfg.name = formSnapshot.name || sourceName;
    baseCfg.apikey = formSnapshot.apikey;
    baseCfg.model = formSnapshot.model;
    // 思维链模式 per-源（2026-08-01 凛倾收口：thinking 控制唯一入口=本面板）：写 config 顶层
    //   thinking_mode（""=渠道默认/off/standard/max），消费方=httpFetch→applyThinkingMode 按
    //   convert_config.provider 显式映射各家参数。旧键 extended_thinking/thinking_budget 同步删除
    //   （存量迁移读侧兜底：无 thinking_mode 时 extended_thinking===true 视同 standard）。
    baseCfg.thinking_mode = formSnapshot.thinkingMode;
    delete baseCfg.extended_thinking;
    delete baseCfg.thinking_budget;
    // 仅控制最终出站角色；工具结果在聊天记录中仍保持 system，其他 system 也不受影响。
    baseCfg.convert_config = {
      ...(baseCfg.convert_config || {}),
      ide_tool_results_as_user: formSnapshot.ideToolResultsAsUser,
    };
    if (isTempEntrySnapshot) {
      // 未知生成器：只写探测到的地址字段，不清理其他键、不写 provider（保留原生成器语义）
      baseCfg[entry.urlField] = formSnapshot.url;
    } else {
      CH.applyToConfig(entry, baseCfg, formSnapshot.url);
    }
    const gen = entry.generator;
    try {
      // T2批1收口：raw POST 保存 → sendAction 门面（saveAISource 注册体 buildBody 取 payload.data，故 {generator,config} 须包进 data）。
      //   sendAction 非 2xx 自动 throw，原 if(!res.ok)throw 由门面接管删除。
      const saveResult = await sendAction({ verb: "saveAISource", target: "shells:serviceSourceManage", source: "web",
        payload: { name: sourceName, data: { generator: gen, config: baseCfg } } });
      const persisted = await sendAction({ verb: "getAISource", target: "shells:serviceSourceManage", source: "web", payload: { name: sourceName } });
      assertApiSourceReadback(persisted, { generator: gen, config: baseCfg }, '保存');
      // 0714 根修（凛倾「保存后转跳为空白」案）：原 `currentName = baseCfg.name` 改名漂移删除——
      //   后端按 URL :name 存文件从不改名（serviceSourceManage endpoints.mjs POST :39），config.name
      //   只是显示名（生成器 buildInfo v.name 消费），两者本就允许不同。漂移后 loadSource(不存在名)
      //   → select.value 落空=下拉空白，且后续保存/加载全按幽灵名 404。文件键恒=currentName 不动。
      if (!await loadList())
        throw new Error('保存已完成，但列表刷新失败；请重新打开 API 设置');
      if (currentName === sourceName && !await loadSource(sourceName))
        throw new Error('保存已完成，但界面刷新失败；请重新打开 API 设置');
      const usable = isApiSourceMarkedUsable(saveResult, sourceName);
      showStatus(usable ? '✅ 已保存' : '已保存草稿；请补全 API 地址和模型后再次保存。', usable ? 'success' : 'warning');
      _emitApiChanged();
    } catch (e) { showStatus('保存失败: ' + e.message, 'error'); }
  });

  $('sa-api-delete').addEventListener('click', async () => {
    if (!currentName || !await beiluConfirm(`确定删除「${currentName}」?`)) return;
    try {
      // T2批1收口：raw DELETE → sendAction 门面（deleteAISource REST，不带 mode=无 query 等价；现状不消费返回值）
      await sendAction({ verb: "deleteAISource", target: "shells:serviceSourceManage", source: "web", payload: { name: currentName } });
      showStatus('已删除', 'success');
      currentName = null;
      if (!await loadList()) {
        showStatus('删除已完成，但列表刷新失败；请重新打开 API 设置', 'error');
        _emitApiChanged();
        return;
      }
      if (apiSources.length > 0) await loadSource(apiSources[0]); else clearForm();
      _emitApiChanged();
    } catch (e) { showStatus('删除失败: ' + e.message, 'error'); }
  });

  $('sa-api-new').addEventListener('click', async () => {
    const name = await beiluPrompt('输入新API配置名称：');
    if (!name?.trim()) return;
    const safeName = name.trim();
    if (apiSources.includes(safeName)) { showStatus('名称已存在', 'error'); return; }
    const entry = curEntry();
    if (!entry) { showStatus('请先选择一个 API 渠道', 'error'); return; }
    let tmpl;
    try {
      tmpl = await sendAction({ verb: "getGeneratorTemplate", target: "shells:serviceSourceManage", source: "web", payload: { generator: entry.generator } });
    } catch (e) {
      // 新建必须取得真实模板；读取失败时不创建空 config 假成功。
      showStatus('无法读取渠道模板，已停止创建: ' + e.message, 'error');
      return;
    }
    CH.applyToConfig(entry, tmpl, entry.defaultUrl || '');
    try {
      // T2批1收口：raw POST 新建 → sendAction 门面（saveAISource 同 A4，buildBody 取 payload.data，故 {generator,config} 须包进 data）。
      const saveResult = await sendAction({ verb: "saveAISource", target: "shells:serviceSourceManage", source: "web",
        payload: { name: safeName, data: { generator: entry.generator, config: tmpl } } });
      const persisted = await sendAction({ verb: "getAISource", target: "shells:serviceSourceManage", source: "web", payload: { name: safeName } });
      assertApiSourceReadback(persisted, { generator: entry.generator, config: tmpl }, '创建');
      currentName = safeName;
      if (!await loadList())
        throw new Error('创建已完成，但列表刷新失败；请重新打开 API 设置');
      if (!await loadSource(safeName))
        throw new Error('创建已完成，但界面刷新失败；请重新打开 API 设置');
      const usable = isApiSourceMarkedUsable(saveResult, safeName);
      showStatus(usable ? '✅ 已创建并可用' : '已创建配置草稿；请填写 API 地址、密钥和模型后保存。', usable ? 'success' : 'warning');
      _emitApiChanged();
    } catch (e) { showStatus('创建失败: ' + e.message, 'error'); }
  });

  // [0717 抽函数] 原按钮内联体抽出共用：按钮点击（可见反馈）+ 模型下拉 mousedown（静默实时拉，
  //   凛倾「拉条是每次都需要访问,不是访问一次就缓存,每次点击都需要访问」）两口同链。
  //   silent 时：不动状态条/按钮文案；列表未变跳过重建（重建会把刚展开的原生下拉强制收起）。
  let _saFetchSeq = 0; // 乱序守卫：连点/连开期间旧慢响应不覆盖新列表（同 preset.mjs _fetchModelsSeq 范式）
  async function _saFetchModels({ silent = false } = {}) {
    const seq = ++_saFetchSeq;
    const url = $('sa-api-url').value;
    const key = $('sa-api-key').value;
    if (!url) { if (!silent) showStatus('请先填写URL', 'error'); return; }
    // 按渠道分发列表端点：ollama=/api/tags（{models:[{name}]}），其余 OpenAI 惯例 /models
    const entry = curEntry();
    if (!entry) { if (!silent) showStatus('请先选择一个 API 渠道', 'error'); return; }
    const req = modelsRequestFor(entry, url);
    const modelsUrl = req.url;
    if (!silent) { $('sa-api-fetch').disabled = true; $('sa-api-fetch').textContent = '获取中...'; }
    try {
      let models = [];
      // Try proxy fetch via beilu-memory (参数格式与 index.mjs chat 侧栏对齐)
      // T6b尾：原 raw POST setdata {_action:"getModels",...} + proxyRes.ok 手检 → sendAction 门面（memory#* 通配桥组装 _action=verb+平铺 payload）。
      //   等价换算：verb="getModels"，payload 逐字段照搬原 body 非 _action 部分 {apiConfig,url:modelsUrl,apikey}（语义=按未保存配置试拉，非 sourceName 路径，故不照抄他处 {sourceName}）；门面返回体=原 proxyRes.json() 解析结果（桥 unwrap 还原裸数据）。
      //   控制流等价（要点）：原 proxyRes.ok=false 是布尔态、models 保持 [] 继续走下方 direct fetch fallback；门面失败改为抛错，故此处包 try/catch 把门面抛错降级为「proxy 无果」(models 仍 [])，让控制流照原样落到 fallback——非吞错：direct 也失败时 models=[] → 显示「未找到模型」，与原三态一致。
      try {
        const d = await sendAction({ verb: "getModels", target: "plugins:beilu-memory", source: "web", payload: { apiConfig: { url: $('sa-api-url').value, key }, url: modelsUrl, apikey: key } });
        models = req.normalize(d);
      } catch { /* proxy 失败=降级走下方 direct fetch fallback（保持原 !ok 分支的控制流），错误在 fallback 也失败时经末尾「未找到模型」可见 */ }
      if (models.length === 0) {
        // Direct fetch fallback
        try {
          // R1-SKIP: modelsUrl=用户填的外部 API 端点(自管 Authorization Bearer)；apiFetch 401→/login 对外站有害。
          const directRes = await fetch(modelsUrl, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
          if (directRes.ok) {
            const d = await directRes.json();
            models = req.normalize(d);
          }
        } catch {}
      }
      if (seq !== _saFetchSeq) return; // 已被更新的调用超越，丢弃旧响应
      const listEl = $('sa-api-model-list');
      if (models.length > 0) {
        const oldVals = Array.from(listEl.options).map(o => o.value);
        const sameList = !listEl.classList.contains('hidden') &&
          oldVals.length === models.length && oldVals.every((v, i) => v === models[i]);
        if (!sameList) {
          const current = $('sa-api-model').value;
          listEl.innerHTML = models.map(m => `<option value="${escapeHtml(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
          listEl.classList.remove('hidden');
        }
        // 原生 select 在没有显式 current 时会视觉选中第一项，但不会触发 change；
        // 保存读取的是独立 input，导致“看见已选模型、实际仍为空”。仅在 input 为空时
        // 接受下拉当前项作为默认值，保留已有已存/手填模型，不创建第二状态源。
        const modelInput = $('sa-api-model');
        if (!modelInput.value.trim() && listEl.value) modelInput.value = listEl.value;
        if (!silent) showStatus(`找到 ${models.length} 个模型`, 'success');
      } else if (!silent) {
        listEl.classList.add('hidden');
        showStatus('未找到模型，请检查URL和Key', 'error');
      }
    } catch (e) { if (!silent) showStatus('获取模型失败: ' + e.message, 'error'); }
    if (!silent) { $('sa-api-fetch').disabled = false; $('sa-api-fetch').textContent = '获取模型'; }
  }

  $('sa-api-fetch').addEventListener('click', () => _saFetchModels({ silent: false }));

  $('sa-api-model-list').addEventListener('change', () => {
    $('sa-api-model').value = $('sa-api-model-list').value;
  });
  // [0717] 下拉点击展开=静默实时拉（列表未变不重建，不打断展开中的下拉）
  $('sa-api-model-list').addEventListener('mousedown', () => _saFetchModels({ silent: true }));

  syncChannelUI();
  if (await loadList()) {
    if (apiSources.length > 0) await loadSource(apiSources[0]);
    else clearForm();
  }

  // 根病2 单向同步修(步骤1,补 C4 消费边):外部(apiConfig 右栏/独立页/onboarding)改 API 源 → 重拉后端权威刷新本设置弹窗 #sa-api-*。
  //   resource 事件不是可重放状态，隐藏设置页时也必须消费；列表失败立即终止，不再拿旧 currentName 继续读。
  //   当前源已被外部删除时改选权威列表首项；列表为空则清空表单。initApiSlot 单次调用，无重复监听。
  window.addEventListener('resource:api-changed', async () => {
    if (_suppressApiReload) return; // 跳过本面板自身派发(步骤0自抑制)
    if (!await loadList()) return;
    const nextName = currentName && apiSources.includes(currentName) ? currentName : (apiSources[0] || '');
    if (nextName) await loadSource(nextName);
    else clearForm();
  });

  // 思维链设定唯一入口（凛倾 2026-07-14 收口；0720 硬化：内置 think/thinking 恒剥离恒显示——
  //   折叠开关与内置标签勾选均已删，剩折叠标题+自定义标签对两项可配）。
  // 元素在 index.html api 区块静态存在（slot 外，不被 innerHTML 重建）。写点全走既有单源，本处只做 UI 装配：
  //   - 折叠标题：KEYS.BEILU_THINKING_FOLD_LABEL，消费方 messageList；空值/恢复默认 = 删 key 回落代码默认值
  //   - 自定义标签对：reasoningTags.saveReasoningTags（后端 functions:hide#setReasoningTags 权威 + 本地折叠镜像 + 重渲染）
  const { THINKING_FOLD_LABEL_DEFAULT } = await import('../../../shared/render/displayRegex.mjs');
  const tfInput = document.getElementById('sa-thinkfold-label');
  const tfReset = document.getElementById('sa-thinkfold-reset');
  const _tfRefresh = () => import('../../../shared/render/virtualQueue.mjs')
    .then((m) => m.reloadBeautify?.(30))
    .catch((err) => console.warn('[settingsSlots] 思维链折叠标题 reloadBeautify 失败:', err));
  if (tfInput && !tfInput._wired) {
    tfInput._wired = true;
    tfInput.placeholder = THINKING_FOLD_LABEL_DEFAULT;
    tfInput.value = storage.get(KEYS.BEILU_THINKING_FOLD_LABEL) || '';
    tfInput.addEventListener('change', () => {
      const v = tfInput.value.trim();
      if (v) storage.set(KEYS.BEILU_THINKING_FOLD_LABEL, v);
      else storage.remove(KEYS.BEILU_THINKING_FOLD_LABEL);
      _tfRefresh();
    });
    tfReset?.addEventListener('click', () => {
      tfInput.value = '';
      storage.remove(KEYS.BEILU_THINKING_FOLD_LABEL);
      _tfRefresh();
    });
  }

  // [2026-08-10] 内置 beilu_thinking「对 AI 隐藏」开关（AI 可见性）：折叠块用户恒可见，本开关只管发给 AI 前是否剥离。
  //   回填=后端 _config.json 真实状态（权威源；缺省无键=剥离=开=checked）；change 即保存走 saveBeiluThinkingStrip
  //   独立写路（payload 只带 beilu_thinking_strip，后端 patch 语义不动盘上 reasoning_tags）。同步前端镜像供 badge 诚实性渲染。
  const stripToggle = document.getElementById('sa-beilu-thinking-strip');
  if (stripToggle && !stripToggle._wired) {
    stripToggle._wired = true;
    try {
      const _d = await sendAction({ verb: 'getData', target: 'plugins:beilu-memory', source: 'web' });
      stripToggle.checked = (_d?.config || {}).beilu_thinking_strip !== false; // 缺省=剥离=开
    } catch (err) {
      console.warn('[settingsSlots] beilu_thinking 开关状态加载失败:', err);
      window._reportError?.(`[settingsSlots] beilu_thinking 开关状态加载失败: ${err?.message}`, err?.stack);
      // 加载失败保持 HTML 默认 checked（剥离=安全默认）
    }
    storage.set(KEYS.BEILU_THINKING_STRIP, stripToggle.checked ? '1' : '0'); // 镜像与回填一致
    stripToggle.addEventListener('change', async () => {
      try { await saveBeiluThinkingStrip(stripToggle.checked); }
      catch (err) {
        console.warn('[settingsSlots] beilu_thinking 开关保存失败:', err);
        window._reportError?.(`[settingsSlots] beilu_thinking 开关保存失败: ${err?.message}`, err?.stack);
      }
    });
  }

  // 折叠开关已删（0720 硬化）：凛倾硬性核心「人类必须看得到」——折叠块恒渲染,无隐藏开关。

  // 标签编辑（自定义标签对；内置 think/thinking 恒剥离恒显示不可关）：权威源=后端 beilu-memory config
  //   （reasoning_tags；reasoning_builtin 已废,0720 硬化），打开设置时拉一次填充；保存走 saveReasoningTags 唯一写点。
  const tfSave = document.getElementById('sa-think-save');
  if (tfSave && !tfSave._wired) {
    tfSave._wired = true;
    // [0720 硬化] 内置 think/thinking 勾选框已删（恒剥离恒显示,凛倾硬性核心）,只装配自定义标签对
    const tfTagsBox = document.getElementById('sa-think-custom-tags');
    const _mkTagRow = (open = '', close = '') => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-1';
      const mk = (ph, val) => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'input input-xs input-bordered flex-1';
        inp.placeholder = ph; inp.value = val;
        return inp;
      };
      const oInp = mk('<tag>', open); oInp.dataset.rf = 'o';
      const cInp = mk('</tag>', close); cInp.dataset.rf = 'c';
      const del = document.createElement('button');
      del.className = 'btn btn-xs btn-ghost'; del.textContent = '✖';
      del.addEventListener('click', () => row.remove());
      row.append(oInp, cInp, del);
      return row;
    };
    let _hadPrevTags = false;
    try {
      const data = await sendAction({ verb: 'getData', target: 'plugins:beilu-memory', source: 'web' });
      const cfg = data?.config || {};
      _hadPrevTags = Array.isArray(cfg.reasoning_tags) && cfg.reasoning_tags.length > 0;
      if (tfTagsBox) for (const t of (cfg.reasoning_tags || [])) tfTagsBox.appendChild(_mkTagRow(t.open || '', t.close || ''));
    } catch (err) {
      console.warn('[settingsSlots] 思维链标签配置加载失败:', err);
      window._reportError?.(`[settingsSlots] 思维链标签配置加载失败: ${err?.message}`, err?.stack);
    }
    document.getElementById('sa-think-add-tag')?.addEventListener('click', () => tfTagsBox?.appendChild(_mkTagRow()));
    tfSave.addEventListener('click', async () => {
      const rTags = [];
      tfTagsBox?.querySelectorAll(':scope > div').forEach((row) => {
        const o = row.querySelector('[data-rf="o"]')?.value?.trim() || '';
        const c = row.querySelector('[data-rf="c"]')?.value?.trim() || '';
        if (o && c) rTags.push({ open: o, close: c });
      });
      const _origHtml = tfSave.innerHTML;
      try {
        tfSave.innerHTML = '<i data-ic="hourglass"></i> 保存中';
        await saveReasoningTags(rTags, { hadPrevTags: _hadPrevTags });
        _hadPrevTags = rTags.length > 0; // 保存成功后基线更新：本轮清空已落盘，下次再清空仍要落盘
        tfSave.innerHTML = '<i data-ic="check"></i> 已保存';
      } catch (err) {
        console.warn('[settingsSlots] 思维链标签保存失败:', err);
        window._reportError?.(`[settingsSlots] 思维链标签保存失败: ${err?.message}`, err?.stack);
        tfSave.innerHTML = '<i data-ic="cross"></i> 失败';
      }
      setTimeout(() => { tfSave.innerHTML = _origHtml; }, 1500);
    });
  }
}

// beilu-files 路径白黑名单已迁入权限域（凛倾0710）：code 权限面板(permissionPanel.mjs) + work 工具箱·工具权限(workPanel.mjs)，共享单源 panels/shared/filesPathConfig.mjs（安全中心副本 0710 已删）
