// fakeSendSlot.mjs — 设置面板·请求预览(fakeSend) slot（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
import { escapeHtml, copyWithFeedback } from "../../../shared/state/utils.mjs";
import { sendAction } from "../../../shared/transport/sendAction.mjs";

// 请求预览面板 (W63新增: fakeSend)
// ============================================================

export async function initFakeSendSlot() {
  const slot = document.getElementById("settings-fakesend-slot");
  if (!slot) return;

  slot.innerHTML = `
    <div class="space-y-3 mt-2">
      <div class="flex items-center gap-2">
        <select id="fs-chat-select" class="select select-xs select-bordered flex-1">
          <option value="">选择聊天...</option>
        </select>
        <button id="fs-refresh" class="btn btn-xs btn-ghost" title="刷新"><i data-ic="refresh"></i></button>
        <button id="fs-build" class="btn btn-xs btn-primary">生成预览</button>
      </div>
      <div id="fs-status" class="text-[10px] opacity-40"></div>
      <div id="fs-result" class="hidden">
        <!-- Stats -->
        <div id="fs-stats" class="flex gap-2 flex-wrap text-[10px] mb-2"></div>
        <!-- Sub tabs -->
        <div class="flex gap-0.5 border-b border-base-content/10 mb-2">
          <button class="btn btn-xs fs-tab active" data-tab="messages" style="background:oklch(var(--b2))">消息</button>
          <button class="btn btn-xs btn-ghost fs-tab" data-tab="params">参数</button>
          <button class="btn btn-xs btn-ghost fs-tab" data-tab="raw">原始JSON</button>
        </div>
        <div id="fs-tab-messages" class="fs-tab-content max-h-64 overflow-y-auto"></div>
        <div id="fs-tab-params" class="fs-tab-content hidden"></div>
        <div id="fs-tab-raw" class="fs-tab-content hidden">
          <div class="flex justify-end mb-1"><button id="fs-copy-raw" class="btn btn-xs btn-ghost">📋 复制</button></div>
          <pre id="fs-raw-output" class="text-[10px] font-mono bg-base-200 rounded p-2 max-h-60 overflow-auto whitespace-pre-wrap"></pre>
        </div>
      </div>
    </div>
  `;

  const $ = id => slot.querySelector('#' + id);

  // Load chat list
  const loadChats = async () => {
    try {
      // T2批23：下拉填充静默读 → getChatListQuiet（notify:"report"，失败不弹 toast 进报错系统）。
      const chats = await sendAction({ verb: "getChatListQuiet", target: "shells:chat", source: "web" });
      const sel = $('fs-chat-select');
      sel.innerHTML = '<option value="">选择聊天...</option>' +
        (Array.isArray(chats) ? chats : []).map(c => {
          const id = c.chatid || c.id || c;
          const label = c.chars ? `${c.chars.join(',')} (${id.substring(0,8)})` : id.substring(0,16);
          return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
        }).join('');
    } catch {}
  };

  // Build request preview
  const buildPreview = async () => {
    const chatId = $('fs-chat-select').value;
    if (!chatId) { $('fs-status').textContent = '请选择聊天'; return; }
    $('fs-build').disabled = true;
    $('fs-build').textContent = '生成中...';
    $('fs-status').textContent = '';
    try {
      // T2批1收口：raw GET → sendAction 门面（getFakeSend REST，回包 {messages,_meta,model} 裸体等价；if(!res.ok)throw 由门面接管删除）
      const data = await sendAction({ verb: "getFakeSend", target: "shells:chat", source: "web", scope: { chatId } });
      const msgs = data.messages || [];
      const meta = data._meta || {};

      // Stats
      $('fs-stats').innerHTML = [
        `<span class="badge badge-xs">${msgs.length} 消息</span>`,
        `<span class="badge badge-xs badge-info">${meta.system_prompt_chars || 0} 系统字符</span>`,
        `<span class="badge badge-xs badge-warning">${meta.total_chars || 0} 总字符</span>`,
        `<span class="badge badge-xs badge-success">~${meta.estimated_tokens || 0} tokens</span>`,
        `<span class="badge badge-xs">${data.model || 'N/A'}</span>`,
      ].join(' ');

      // Messages tab
      $('fs-tab-messages').innerHTML = msgs.map((m, i) => {
        const roleColor = m.role === 'system' ? 'badge-ghost' : m.role === 'user' ? 'badge-info' : 'badge-success';
        const preview = escapeHtml((m.content || '').substring(0, 80)); // T7b：原单字符 .replace(/</g) 只挡 <，&/>/引号未转仍插 innerHTML；收口壳权威版，与下行 full 同源
        const full = escapeHtml(m.content || '');
        return `<div class="mb-1 text-xs"><div class="flex items-center gap-1 cursor-pointer fs-msg-toggle" data-idx="${i}"><span class="text-[10px] opacity-50">▶</span><span class="badge badge-xs ${roleColor}">${m.role}</span><span class="opacity-60">[${(m.content||'').length}]</span><span class="truncate opacity-80">${preview}</span></div><div class="fs-msg-full hidden bg-base-200 rounded p-2 mt-1 text-[10px] font-mono whitespace-pre-wrap max-h-40 overflow-auto">${full}</div></div>`;
      }).join('');
      // Toggle expand
      $('fs-tab-messages').querySelectorAll('.fs-msg-toggle').forEach(el => {
        el.addEventListener('click', () => {
          const full = el.nextElementSibling;
          full.classList.toggle('hidden');
          el.querySelector('span').textContent = full.classList.contains('hidden') ? '▶' : '▼';
        });
      });

      // Params tab
      const paramKeys = ['model','temperature','max_tokens','stream','top_p','top_k','presence_penalty','frequency_penalty','stop'];
      $('fs-tab-params').innerHTML = `<div class="grid grid-cols-2 gap-1 text-xs">${paramKeys.map(k => data[k] !== undefined ? `<span class="opacity-60">${k}</span><span class="font-mono">${JSON.stringify(data[k])}</span>` : '').join('')}</div>${meta.char_display_name ? `<div class="mt-2 text-xs opacity-40">角色: ${escapeHtml(meta.char_display_name)} | 用户: ${escapeHtml(meta.user_display_name||'')}</div>` : ''}`;

      // Raw JSON
      const json = JSON.stringify(data, null, 2);
      $('fs-raw-output').textContent = json.length > 50000 ? json.substring(0, 50000) + '\n... (截断)' : json;

      $('fs-result').classList.remove('hidden');
      $('fs-status').textContent = `生成于 ${new Date().toLocaleTimeString('zh-CN')}`;
    } catch (e) {
      $('fs-status').textContent = '❌ ' + e.message;
      $('fs-result').classList.add('hidden');
    }
    $('fs-build').disabled = false;
    $('fs-build').textContent = '生成预览';
  };

  // Sub tabs
  slot.querySelectorAll('.fs-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      slot.querySelectorAll('.fs-tab').forEach(b => { b.classList.add('btn-ghost'); b.style.background = ''; });
      btn.classList.remove('btn-ghost');
      btn.style.background = 'oklch(var(--b2))';
      slot.querySelectorAll('.fs-tab-content').forEach(c => c.classList.add('hidden'));
      slot.querySelector(`#fs-tab-${btn.dataset.tab}`)?.classList.remove('hidden');
    });
  });

  $('fs-refresh').addEventListener('click', loadChats);
  $('fs-build').addEventListener('click', buildPreview);
  $('fs-copy-raw')?.addEventListener('click', () => {
    copyWithFeedback($('fs-raw-output').textContent, $('fs-copy-raw'));
  });

  await loadChats();
}

// 输出标签管控已迁入正则编辑器 (regexEditor.mjs)
