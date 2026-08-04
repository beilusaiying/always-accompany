// accountSlot.mjs — 设置面板·用户账号 slot（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
import { escapeHtml } from "../../../shared/state/utils.mjs";
import { apiFetch } from "../../../shared/transport/api-client.mjs";
import { storage, KEYS } from "../../../shared/state/storage.mjs";
import { showToast } from "../../../../../../../scripts/toast.mjs";
import { beiluConfirm, beiluPrompt } from "../../../shared/widgets/beiluDialog.mjs";

// ============================================================
// 用户账号 slot
// ============================================================

export async function initAccountSlot() {
  const slot = document.getElementById("settings-account-slot");
  if (!slot) return;

  slot.innerHTML = '<div class="text-sm text-base-content/50 mt-2">加载中...</div>';

  try {
    const resp = await apiFetch("/api/users/list", { raw: true });
    const data = await resp.json();
    const users = data.users || [];

    let currentUser = "未知";
    let currentIsOwner = false;
    try {
      const whoRes = await apiFetch("/api/whoami", { headers: { Accept: "application/json" }, raw: true });
      if (whoRes.ok) {
        const who = await whoRes.json();
        currentUser = who.username || who.name || "未知";
        currentIsOwner = !!who.isOwner;
      }
    } catch {}

    slot.innerHTML = `
      <div class="space-y-4 mt-2">
        <!-- 当前用户 -->
        <div class="flex items-center gap-3 p-3 bg-base-200 rounded-lg">
          <div class="avatar placeholder">
            <div class="bg-primary text-primary-content rounded-full w-10">
              <span class="text-lg"><i data-ic="person"></i></span>
            </div>
          </div>
          <div class="flex-1">
            <div class="font-bold text-sm">${escapeHtml(currentUser)} ${currentIsOwner ? '<span class="badge badge-xs badge-info">管理员</span>' : ''}</div>
            <div class="text-xs text-base-content/50">当前登录账号</div>
          </div>
          <button class="btn btn-xs btn-outline" id="settings-switch-user">切换</button>
        </div>

        <!-- 用户列表 -->
        <div>
          <h4 class="text-sm font-medium mb-2">已注册账号 (${users.length})</h4>
          <div class="space-y-1" id="settings-user-list">
            ${users.map(u => {
              const name = u.username || u.name || u;
              const isCurrent = name === currentUser;
              const _en = escapeHtml(name);
              return `<div class="flex items-center justify-between p-2 rounded hover:bg-base-200 text-sm" ${isCurrent ? 'style="background:var(--beilu-amber-10)"' : ''}>
                <span><i data-ic="person"></i> ${_en} ${isCurrent ? '<span class="badge badge-xs badge-warning">当前</span>' : ''}</span>
                <div class="flex gap-1">
                  ${currentIsOwner && !isCurrent ? `<button class="btn btn-xs btn-ghost user-reset-pwd-btn" data-user="${_en}" title="重置密码"><i data-ic="key"></i></button>` : ''}
                  ${currentIsOwner && !isCurrent ? `<button class="btn btn-xs btn-ghost user-rename-btn" data-user="${_en}" title="重命名"><i data-ic="edit"></i></button>` : ''}
                  ${currentIsOwner && !isCurrent ? `<button class="btn btn-xs btn-ghost btn-error user-delete-btn" data-user="${_en}" title="删除此用户"><i data-ic="trash"></i></button>` : ''}
                  <button class="btn btn-xs btn-ghost user-login-btn" data-user="${_en}" ${isCurrent ? 'disabled' : ''}>登录</button>
                </div>
              </div>`;
            }).join("") || '<div class="text-xs text-base-content/40">暂无用户</div>'}
          </div>
        </div>

        <!-- 修改密码 -->
        <details class="collapse collapse-arrow bg-base-200 rounded-lg" id="acc-change-pw">
          <summary class="collapse-title text-sm font-medium min-h-0 py-2 px-3"><i data-ic="key"></i> 修改密码</summary>
          <div class="collapse-content px-3 pb-3 space-y-2">
            <input type="password" placeholder="当前密码（无密码留空）" class="input input-xs input-bordered w-full" id="acc-cur-pwd" autocomplete="current-password">
            <input type="password" placeholder="新密码" class="input input-xs input-bordered w-full" id="acc-new-pwd" autocomplete="new-password">
            <input type="password" placeholder="确认新密码" class="input input-xs input-bordered w-full" id="acc-confirm-pwd" autocomplete="new-password">
            <button class="btn btn-xs btn-primary w-full" id="acc-change-pwd-btn">修改密码</button>
          </div>
        </details>

        <!-- 安全问题（密码找回） -->
        <details class="collapse collapse-arrow bg-base-200 rounded-lg" id="acc-security-q">
          <summary class="collapse-title text-sm font-medium min-h-0 py-2 px-3"><i data-ic="shield"></i> 安全问题（找回密码用）</summary>
          <div class="collapse-content px-3 pb-3 space-y-2">
            <p class="text-xs text-base-content/50">设置 3 个安全问题，忘记密码时可通过回答问题重置。</p>
            <div id="acc-sq-fields"></div>
            <input type="password" placeholder="当前密码确认（无密码留空）" class="input input-xs input-bordered w-full" id="acc-sq-pwd" autocomplete="current-password">
            <button class="btn btn-xs btn-primary w-full" id="acc-sq-save-btn">保存安全问题</button>
          </div>
        </details>

        <!-- 删除当前账号 -->
        <details class="collapse collapse-arrow bg-error/10 rounded-lg border border-error/30" id="acc-delete-self">
          <summary class="collapse-title text-sm font-medium min-h-0 py-2 px-3 text-error"><i data-ic="warning"></i> 删除当前账号</summary>
          <div class="collapse-content px-3 pb-3 space-y-2">
            <p class="text-xs text-error/80">此操作将删除账号「${escapeHtml(currentUser)}」的所有数据。用户文件将移入回收站。</p>
            <input type="password" placeholder="输入密码确认（无密码留空）" class="input input-xs input-bordered w-full" id="acc-del-pwd" autocomplete="current-password">
            <label class="flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" class="checkbox checkbox-xs checkbox-error" id="acc-del-purge">
              <span>完全清除（不留任何配置痕迹，API密钥等记录一并永久删除）</span>
            </label>
            <button class="btn btn-xs btn-error w-full" id="acc-delete-self-btn">确认删除账号</button>
          </div>
        </details>
      </div>
    `;

    // 切换用户 → 先真登出再跳登录页（六域纠察断链修，凛倾0706「登录」域）：
    //   原实现只跳转，access(1d)/refresh(30d) token 全留=用户以为退出实际会话未撤（安全面）。
    //   后端 POST /api/logout（server/web_server/endpoints.mjs 路由→auth.logout 撤token+清cookie）完整可用，
    //   此前全前端零调用点=纯接线断链。登出失败也照跳（跳转是主语义，撤销尽力而为，失败console可见）。
    slot.querySelector("#settings-switch-user")?.addEventListener("click", async () => {
      try { await apiFetch("/api/logout", { method: "POST", raw: true }); } catch (e) { console.warn("[settings] 登出请求失败(仍跳转):", e?.message || e); }
      // 20260706 删号传导链修同批：登出=确定无会话，直达 /login/ 不绕 '/'（同 account_deleted 语义）
      window.location.href = "/login/";
    });

    // 用户列表登录按钮
    slot.querySelectorAll(".user-login-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const username = btn.dataset.user;
        const pwd = await beiluPrompt(`输入 ${username} 的密码（无密码直接确认）:`, "");
        if (pwd === null) return;
        try {
          const deviceid = storage.get(KEYS.BEILU_DEVICE_ID) || crypto.randomUUID();
          storage.set(KEYS.BEILU_DEVICE_ID, deviceid);
          const res = await apiFetch("/api/login", {
            method: "POST", raw: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password: pwd, deviceid }),
          });
          if (res.ok) {
            window.location.reload();
          } else {
            const err = await res.json().catch(() => ({}));
            showToast("error", "登录失败: " + (err.message || err.error || res.status));
          }
        } catch (e) {
          showToast("error", "登录失败: " + e.message);
        }
      });
    });

    // 管理员：重置他人密码
    slot.querySelectorAll(".user-reset-pwd-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const target = btn.dataset.user;
        const newPwd = await beiluPrompt(`为用户「${target}」设置新密码:`, "");
        if (newPwd === null || !newPwd.trim()) return;
        try {
          const res = await apiFetch("/api/users/admin-reset-password", {
            method: "POST", raw: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetUsername: target, newPassword: newPwd }),
          });
          const result = await res.json().catch(() => ({}));
          if (res.ok && result.success) showToast("success", `已重置「${target}」的密码`);
          else showToast("error", result.message || "重置失败");
        } catch (e) { showToast("error", "重置失败: " + e.message); }
      });
    });

    // 管理员：重命名用户
    slot.querySelectorAll(".user-rename-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const target = btn.dataset.user;
        const newName = await beiluPrompt(`将「${target}」重命名为:`, target);
        if (newName === null || !newName.trim() || newName.trim() === target) return;
        const pwd = await beiluPrompt("输入你（管理员）的密码确认:", "");
        if (pwd === null) return;
        try {
          const res = await apiFetch("/api/users/rename", {
            method: "POST", raw: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newUsername: newName.trim(), password: pwd, targetUsername: target }),
          });
          const result = await res.json().catch(() => ({}));
          if (res.ok && result.success) { showToast("success", `已重命名为「${newName.trim()}」`); initAccountSlot(); }
          else showToast("error", result.message || "重命名失败");
        } catch (e) { showToast("error", "重命名失败: " + e.message); }
      });
    });

    // 用户列表删除按钮（删别人，需要 owner 权限，后端校验）
    slot.querySelectorAll(".user-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const target = btn.dataset.user;
        if (!await beiluConfirm(`确定删除用户「${target}」？\n该用户的文件将移入回收站。`)) return;
        const pwd = await beiluPrompt("输入你（当前登录者）的密码确认:", "");
        if (pwd === null) return;
        // 文案对齐行为(20260706)：API密钥两种选择下都失效(auth.mjs deleteUserAccount 无条件清全局 apiKeys 表)，可恢复的只有用户文件(回收站)
        const purge = await beiluConfirm("是否完全清除该用户的配置痕迹？\n\n选「确定」= 完全清除不留痕\n选「取消」= 用户文件移入回收站（可恢复）\n\n注意：无论选哪个，该用户的 API 密钥与登录会话都会立即失效。");
        try {
          const res = await apiFetch("/api/users/delete-account", {
            method: "POST", raw: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pwd, targetUsername: target, purgeConfig: purge }),
          });
          const result = await res.json().catch(() => ({}));
          if (res.ok && result.success) {
            showToast("success", `用户「${target}」已删除`);
            initAccountSlot();
          } else {
            showToast("error", result.message || "删除失败");
          }
        } catch (e) {
          showToast("error", "删除失败: " + e.message);
        }
      });
    });

    // 修改密码
    slot.querySelector("#acc-change-pwd-btn")?.addEventListener("click", async () => {
      const curPwd = slot.querySelector("#acc-cur-pwd")?.value || "";
      const newPwd = slot.querySelector("#acc-new-pwd")?.value || "";
      const confirmPwd = slot.querySelector("#acc-confirm-pwd")?.value || "";
      if (!newPwd) return showToast("error", "请输入新密码");
      if (newPwd !== confirmPwd) return showToast("error", "两次输入的新密码不一致");
      try {
        const res = await apiFetch("/api/users/change-password", {
          method: "POST", raw: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword: curPwd, newPassword: newPwd }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.success) {
          showToast("success", "密码修改成功");
          slot.querySelector("#acc-cur-pwd").value = "";
          slot.querySelector("#acc-new-pwd").value = "";
          slot.querySelector("#acc-confirm-pwd").value = "";
          slot.querySelector("#acc-change-pw").removeAttribute("open");
        } else {
          showToast("error", result.message || "密码修改失败");
        }
      } catch (e) {
        showToast("error", "密码修改失败: " + e.message);
      }
    });

    // 安全问题 UI 初始化
    const PRESET_QUESTIONS = [
      "你的第一只宠物叫什么？",
      "你小时候最好的朋友叫什么？",
      "你的出生城市？",
      "你母亲的名字？",
      "你最喜欢的老师叫什么？",
      "你的第一所学校叫什么？",
      "你最喜欢的电影？",
      "你童年的昵称？",
    ];
    const sqFields = slot.querySelector("#acc-sq-fields");
    if (sqFields) {
      let existingQs = [];
      try {
        const r = await apiFetch(`/api/users/security-questions/get/${encodeURIComponent(currentUser)}`, { raw: true });
        const d = await r.json();
        if (d.success && d.questions?.length) existingQs = d.questions;
      } catch {}
      sqFields.innerHTML = [0, 1, 2].map(i => {
        const eq = existingQs[i];
        const opts = PRESET_QUESTIONS.map(q => `<option value="${escapeHtml(q)}" ${eq?.question === q ? 'selected' : ''}>${escapeHtml(q)}</option>`).join('');
        return `<div class="space-y-1 mb-2">
          <label class="text-xs font-medium text-base-content/60">问题 ${i + 1}</label>
          <select class="select select-xs select-bordered w-full acc-sq-question" data-idx="${i}">
            <option value="">选择预置问题或自定义…</option>
            ${opts}
            <option value="__custom__" ${eq && !PRESET_QUESTIONS.includes(eq.question) ? 'selected' : ''}>自定义问题</option>
          </select>
          <input type="text" class="input input-xs input-bordered w-full acc-sq-custom-q" data-idx="${i}" placeholder="输入自定义问题" style="display:${eq && !PRESET_QUESTIONS.includes(eq.question) ? 'block' : 'none'}" value="${eq && !PRESET_QUESTIONS.includes(eq.question) ? escapeHtml(eq.question) : ''}">
          <input type="text" class="input input-xs input-bordered w-full acc-sq-answer" data-idx="${i}" placeholder="输入答案（不区分大小写）" autocomplete="off">
        </div>`;
      }).join('');
      sqFields.querySelectorAll(".acc-sq-question").forEach(sel => {
        sel.addEventListener("change", () => {
          const custom = sel.closest("div").querySelector(".acc-sq-custom-q");
          custom.style.display = sel.value === "__custom__" ? "block" : "none";
        });
      });
    }

    slot.querySelector("#acc-sq-save-btn")?.addEventListener("click", async () => {
      const questions = [0, 1, 2].map(i => {
        const sel = sqFields.querySelector(`.acc-sq-question[data-idx="${i}"]`);
        const customInput = sqFields.querySelector(`.acc-sq-custom-q[data-idx="${i}"]`);
        const ansInput = sqFields.querySelector(`.acc-sq-answer[data-idx="${i}"]`);
        const question = sel.value === "__custom__" ? customInput.value.trim() : sel.value;
        return { questionId: `q${i}`, question, answer: ansInput?.value || "" };
      });
      if (questions.some(q => !q.question || !q.answer)) return showToast("error", "请填写所有问题和答案");
      const pwd = slot.querySelector("#acc-sq-pwd")?.value || "";
      try {
        const res = await apiFetch("/api/users/security-questions/set", {
          method: "POST", raw: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd, questions }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.success) {
          showToast("success", "安全问题已保存");
          slot.querySelector("#acc-security-q")?.removeAttribute("open");
          sqFields.querySelectorAll(".acc-sq-answer").forEach(el => { el.value = ""; });
          slot.querySelector("#acc-sq-pwd").value = "";
        } else {
          showToast("error", result.message || "保存失败");
        }
      } catch (e) {
        showToast("error", "保存失败: " + e.message);
      }
    });

    // 删除当前账号
    slot.querySelector("#acc-delete-self-btn")?.addEventListener("click", async () => {
      const pwd = slot.querySelector("#acc-del-pwd")?.value || "";
      const purge = slot.querySelector("#acc-del-purge")?.checked || false;
      // 文案对齐行为(20260706)：API密钥无论是否勾选"完全清除"都会失效，可从回收站恢复的只有用户文件
      if (!await beiluConfirm(`确定要永久删除账号「${currentUser}」？\n\n用户文件将移入回收站（可恢复）。\n${purge ? "配置痕迹将被完全清除，不留任何可恢复数据。" : "重新注册同名账号后，可从回收站还原用户文件。"}\nAPI 密钥与登录会话将立即失效。`)) return;
      try {
        const res = await apiFetch("/api/users/delete-account", {
          method: "POST", raw: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd, purgeConfig: purge }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.success) {
          showToast("success", "账号已删除，正在跳转...");
          // 20260706 删号传导链修：直达 /login/ 不绕 '/'（响应已 clearCookie=确定无会话，同 account_deleted 事件语义）
          setTimeout(() => { window.location.href = "/login/"; }, 1500);
        } else {
          showToast("error", result.message || "删除失败");
        }
      } catch (e) {
        showToast("error", "删除失败: " + e.message);
      }
    });
  } catch {
    slot.innerHTML = '<div class="text-sm text-error mt-2">加载用户列表失败</div>';
  }
}
