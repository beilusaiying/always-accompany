import info from "./info.json" with { type: "json" };
import { nicerWriteFileSync } from "../../../../scripts/nicerWriteFile.mjs";
import { readJsonSafeSync } from "../../../../scripts/safeJsonIO.mjs"; // T019：损坏不静默重建，备份.corrupt.bak后抛错中止
import { sanitizeFilename } from "../../../../scripts/sanitizeName.mjs"; // 0716 轮子收口：文件名安全清洗共享原语
import { safeTrash, safeUnlink } from "../../../../yonban/core/functions/rollback/safeDelete.mjs"; // T8·回切：改指 yonban 新位实现体

/**
 * ⚠️ 废弃声明（凛倾 2026-06-10）：beilu-home 已标记废弃，暂保留运行（不影响功能就继续用）。
 * 新功能请去 beilu-chat；本壳后续整体迁移后移除。活依赖（角色管理/删除角色等）迁移前不动。
 *
 * beilu-home Shell — 贝露首页
 *
 * 职责：
 * - 提供选项卡式首页界面（使用 / 系统设置 / 用户设置）
 * - 角色卡列表展示和进入聊天
 * - 预设管理和 API 配置入口
 *
 * 后端 API：注册角色卡/人设/AIsource 绑定/网络诊断等 20+ 条路由（详见下方各 router.* 注册）。
 * - 例：GET /api/parts/shells:beilu-home/chat-summaries — 获取聊天摘要缓存
 */
export default {
  info,
  /**
   * 加载 Shell，注册后端路由
   * @param {Object} param0 - 参数对象
   * @param {Object} param0.router - Express 路由器
   */
  Load: async ({ router }) => {
    const { authenticate, getUserByReq, getUserDictionary } =
      await import("../../../../yonban/core/functions/security/auth.mjs");
    const { notifyPartInstall, uninstallPartBase, parts_set } =
      await import("../../../../server/parts_loader.mjs");
    const { loadData, saveData } =
      await import("../../../../server/setting_loader.mjs");
    // 跨客户端角色卡内容同步：编辑角色卡(描述/开场白/头像)后按 username 推 char-data-changed，
    // 让另一端(本体↔YonBan)正在看该卡的角色信息面板重载（走通道B userConnections）。
    const { sendEventToUser } =
      await import("../../../../server/web_server/event_dispatcher.mjs");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");

    // network-info 已迁至 beilu-chat/src/endpoints.mjs（shells:chat/network-info）
    // beilu 角色卡模板目录
    const CHAR_TEMPLATE_DIR = path.join(
      import.meta.dirname,
      "beilu-char-template",
    );
    const PERSONA_TEMPLATE_DIR = path.join(
      import.meta.dirname,
      "beilu-persona-template",
    );

    // PNG 角色卡解析器（复用 beilu 的 data_reader）
    const dataReader =
      await import("../../ImportHandlers/SillyTavern/data_reader.mjs");

    // POST /api/parts/shells:beilu-home/create-char
    // 创建空白角色卡
    router.post(
      "/api/parts/shells\\:beilu-home/create-char",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { name } = req.body || {};

          if (!name || typeof name !== "string" || !name.trim()) {
            return res.status(400).json({ message: "角色名称不能为空" });
          }

          const charName = name.trim();
          // 安全检查：禁止路径穿越字符
          if (/[\/\\:*?"<>|]/.test(charName)) {
            return res.status(400).json({ message: "角色名称包含非法字符" });
          }

          const userDir = getUserDictionary(username);
          const charDir = path.join(userDir, "chars", charName);

          if (fs.existsSync(charDir)) {
            return res
              .status(409)
              .json({ message: `角色 "${charName}" 已存在` });
          }

          // 创建目录
          fs.mkdirSync(charDir, { recursive: true });

          // 复制 beilu 角色卡模板 main.mjs（保持与导入角色卡结构一致）
          const templateMain = path.join(CHAR_TEMPLATE_DIR, "main.mjs");
          if (fs.existsSync(templateMain)) {
            fs.copyFileSync(templateMain, path.join(charDir, "main.mjs"));
          } else {
            console.warn(
              "[beilu-home] 角色卡模板 main.mjs 不存在，空白角色卡可能缺少 main.mjs",
            );
          }

          // 写入 beilu-part.json
          nicerWriteFileSync(
            path.join(charDir, "beilu-part.json"),
            JSON.stringify({ type: "chars", dirname: charName }, null, "\t"),
            "utf-8",
          );

          // 写入 info.json（最小的多语言信息）
          const infoData = {
            "zh-CN": {
              name: charName,
              avatar: "",
              description: "",
              version: "0.1.0",
              author: username,
              tags: [],
            },
            "en-UK": {
              name: charName,
              avatar: "",
              description: "",
              version: "0.1.0",
              author: username,
              tags: [],
            },
          };
          nicerWriteFileSync(
            path.join(charDir, "info.json"),
            JSON.stringify(infoData, null, "\t"),
            "utf-8",
          );

          // 写入 chardata.json（空白角色卡初始数据）
          const chardata = {
            name: charName,
            description: "",
            personality: "",
            scenario: "",
            first_mes: "",
            mes_example: "",
            system_prompt: "",
            post_history_instructions: "",
            creator_notes: "",
            creator: username,
            character_version: "0.1.0",
            tags: [],
            alternate_greetings: [],
            extensions: {},
          };
          nicerWriteFileSync(
            path.join(charDir, "chardata.json"),
            JSON.stringify(chardata, null, "\t"),
            "utf-8",
          );

          // 为新角色自动分配默认 AIsource
          try {
            const parts_config = loadData(username, "parts_config");
            let defaultAIsource = "";
            // 策略1: 复用已有角色卡的 AIsource
            for (const [key, val] of Object.entries(parts_config)) {
              if (key.startsWith("chars/") && val?.AIsource) {
                defaultAIsource = val.AIsource;
                break;
              }
            }
            // 策略2: 找 generator === "proxy" 的第一个 AI 源
            if (!defaultAIsource) {
              for (const [key, val] of Object.entries(parts_config)) {
                if (
                  key.startsWith("serviceSources/AI/") &&
                  val?.generator === "proxy"
                ) {
                  defaultAIsource = key.replace("serviceSources/AI/", "");
                  break;
                }
              }
            }
            if (defaultAIsource) {
              parts_config[`chars/${charName}`] = {
                AIsource: defaultAIsource,
                plugins: [],
              };
              saveData(username, "parts_config");
              console.log(
                `[beilu-home] 新角色自动配置 AIsource: "${defaultAIsource}" → chars/${charName}`,
              );
            }
          } catch (e) {
            console.warn(
              "[beilu-home] 新角色自动配置 AIsource 失败:",
              e.message,
            );
          }

          // 通知 beilu 刷新 parts 缓存
          try {
            notifyPartInstall(username, `chars/${charName}`);
          } catch (e) {
            console.warn("[beilu-home] notifyPartInstall 失败:", e.message);
          }

          console.log(
            `[beilu-home] 角色卡已创建: "${charName}" (user: ${username})`,
          );
          res.status(201).json({ success: true, name: charName });
        } catch (error) {
          console.error("[beilu-home] Error creating char:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );

    // POST /api/parts/shells:beilu-home/sync-aisource
    // 将指定 AI 源同步到所有未配置 AIsource 的角色卡（仅补空，不覆盖已有绑定）
    router.post(
      "/api/parts/shells\\:beilu-home/sync-aisource",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { sourceName } = req.body || {};

          if (
            !sourceName ||
            typeof sourceName !== "string" ||
            !sourceName.trim()
          ) {
            return res.status(400).json({ error: "sourceName required" });
          }

          const normalizedSourceName = sourceName.trim();
          const parts_config = loadData(username, "parts_config");

          if (!parts_config || typeof parts_config !== "object") {
            return res.status(500).json({ error: "parts_config invalid" });
          }

          let updated = 0;
          for (const [key, val] of Object.entries(parts_config)) {
            if (!key.startsWith("chars/")) continue;

            const charConfig =
              val && typeof val === "object" && !Array.isArray(val) ? val : {};
            if (charConfig.AIsource) continue;

            parts_config[key] = {
              ...charConfig,
              AIsource: normalizedSourceName,
            };
            updated++;
          }

          if (updated > 0) {
            saveData(username, "parts_config");
          }

          res.status(200).json({
            success: true,
            updated,
            sourceName: normalizedSourceName,
          });
        } catch (error) {
          console.error("[beilu-home] sync-aisource error:", error);
          res.status(500).json({ error: error.message });
        }
      },
    );

    // ============================================================
    // GET /api/parts/shells:beilu-home/char-aisource/:charName
    // 获取角色卡当前绑定的 AI 源 + 可用源列表
    // ============================================================
    router.get(
      "/api/parts/shells\\:beilu-home/char-aisource/:charName",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { charName } = req.params;
          const parts_config = loadData(username, "parts_config");

          // 当前角色绑定的 AIsource
          const charConfig = parts_config[`chars/${charName}`];
          const currentSource = charConfig?.AIsource || "";

          // 可用的 AI 源列表
          const available = [];
          for (const key of Object.keys(parts_config)) {
            if (key.startsWith("serviceSources/AI/")) {
              available.push(key.replace("serviceSources/AI/", ""));
            }
          }

          res.json({ AIsource: currentSource, available });
        } catch (error) {
          console.error("[beilu-home] char-aisource GET error:", error);
          res.status(500).json({ error: error.message });
        }
      },
    );

    // ============================================================
    // PUT /api/parts/shells:beilu-home/char-aisource/:charName
    // 设置角色卡绑定的 AI 源
    // Body: { AIsource: string }
    // ============================================================
    router.put(
      "/api/parts/shells\\:beilu-home/char-aisource/:charName",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { charName } = req.params;
          const { AIsource } = req.body || {};

          if (!AIsource || typeof AIsource !== "string") {
            return res.status(400).json({ error: "AIsource required" });
          }

          const parts_config = loadData(username, "parts_config");
          const configKey = `chars/${charName}`;

          // 保留现有的其他配置字段（如 plugins）
          const existing =
            parts_config[configKey] &&
            typeof parts_config[configKey] === "object"
              ? parts_config[configKey]
              : {};

          parts_config[configKey] = {
            ...existing,
            AIsource: AIsource.trim(),
          };

          saveData(username, "parts_config");
          console.log(
            `[beilu-home] 角色 AIsource 已更新: chars/${charName} → ${AIsource}`,
          );

          // 热更新：如果角色卡实例已加载到内存，立即触发 SetData 重新加载 AIsource
          try {
            const charPart = parts_set[username]?.[`chars/${charName}`];
            if (charPart?.interfaces?.config?.SetData) {
              await charPart.interfaces.config.SetData({
                ...existing,
                AIsource: AIsource.trim(),
              });
              console.log(
                `[beilu-home] 角色 ${charName} AIsource 已热更新到内存`,
              );
            }
          } catch (hotErr) {
            console.warn(
              `[beilu-home] 角色 ${charName} AIsource 热更新失败:`,
              hotErr.message,
            );
          }

          res.json({ success: true, AIsource: AIsource.trim() });
        } catch (error) {
          console.error("[beilu-home] char-aisource PUT error:", error);
          res.status(500).json({ error: error.message });
        }
      },
    );

    // GET /api/parts/shells:beilu-home/chat-summaries
    // 读取 chat_summaries_cache.json，过滤 null 值后返回
    router.get(
      "/api/parts/shells\\:beilu-home/chat-summaries",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const userDir = getUserDictionary(username);
          const cachePath = path.join(
            userDir,
            "shells",
            "chat",
            "chat_summaries_cache.json",
          );

          if (!fs.existsSync(cachePath)) {
            return res.status(200).json({});
          }

          const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
          const filtered = {};
          for (const [key, value] of Object.entries(raw)) {
            if (value !== null) filtered[key] = value;
          }

          res.status(200).json(filtered);
        } catch (error) {
          console.error("[beilu-home] Error reading chat summaries:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );
    // ============================================================
    // POST /api/parts/shells:beilu-home/import-char
    // 自定义角色卡导入（不使用 beilu 的 ST ImportHandler）
    // 接收 multipart 文件上传（支持 JSON / PNG）
    // ============================================================
    router.post(
      "/api/parts/shells\\:beilu-home/import-char",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);

          // express-fileupload 解析后的文件
          const uploadedFile = req.files?.file;
          if (!uploadedFile) {
            return res.status(400).json({ message: "未上传文件" });
          }

          const fileName = uploadedFile.name || "";
          const fileBuffer = uploadedFile.data;
          const ext = fileName.toLowerCase().split(".").pop();

          let charDataRaw = null; // 解析后的角色卡 JSON 对象
          let imageBuffer = null; // PNG 图片 Buffer（仅 PNG 导入时有）

          // --- 根据文件类型解析 ---
          if (ext === "json") {
            // JSON 角色卡：直接解析
            const text = fileBuffer.toString("utf-8");
            charDataRaw = JSON.parse(text);
          } else if (ext === "png") {
            // PNG 角色卡：从 tEXt chunk 提取 chara 数据
            try {
              const charaJson = dataReader.read(fileBuffer);
              charDataRaw = JSON.parse(charaJson);
              imageBuffer = fileBuffer; // 原始 PNG 作为头像
            } catch (pngErr) {
              return res
                .status(400)
                .json({ message: "PNG 中未找到角色卡数据: " + pngErr.message });
            }
          } else {
            return res.status(400).json({
              message: `不支持的文件格式: .${ext}（支持 .json / .png）`,
            });
          }

          if (!charDataRaw || typeof charDataRaw !== "object") {
            return res.status(400).json({ message: "角色卡数据解析失败" });
          }

          // 解析 ST chara_card_v2/v3 格式
          const data = charDataRaw.data || charDataRaw;
          const charName = (data.name || "unknown").trim();

          if (!charName) {
            return res.status(400).json({ message: "角色名称为空" });
          }

          // 安全检查：替换非法字符
          const safeName = sanitizeFilename(charName);
          const userDir = getUserDictionary(username);
          let charDir = path.join(userDir, "chars", safeName);

          // 处理重名：加数字后缀
          let finalName = safeName;
          let counter = 1;
          while (fs.existsSync(charDir)) {
            finalName = `${safeName}_${counter}`;
            charDir = path.join(userDir, "chars", finalName);
            counter++;
          }

          // 创建角色卡目录
          fs.mkdirSync(charDir, { recursive: true });

          // 1. 复制 beilu 角色卡模板 main.mjs
          const templateMain = path.join(CHAR_TEMPLATE_DIR, "main.mjs");
          if (fs.existsSync(templateMain)) {
            fs.copyFileSync(templateMain, path.join(charDir, "main.mjs"));
          } else {
            // 模板缺失时清理已创建的目录
            fs.rmSync(charDir, { recursive: true, force: true });
            console.warn(
              "[beilu-home] 角色卡模板 main.mjs 不存在:",
              templateMain,
            );
            return res.status(500).json({ message: "角色卡模板缺失" });
          }

          // 2. 写入 chardata.json（完整保留原始 ST 数据，不篡改）
          nicerWriteFileSync(
            path.join(charDir, "chardata.json"),
            JSON.stringify(data, null, "\t"),
            "utf-8",
          );

          // 3. 写入 beilu-part.json
          nicerWriteFileSync(
            path.join(charDir, "beilu-part.json"),
            JSON.stringify({ type: "chars", dirname: finalName }, null, "\t"),
            "utf-8",
          );

          // 4. 保存头像图片
          if (imageBuffer) {
            const publicDir = path.join(charDir, "public");
            fs.mkdirSync(publicDir, { recursive: true });
            fs.writeFileSync(path.join(publicDir, "image.png"), imageBuffer);
          }

          // 5. 为新角色写入默认 AIsource 配置（在 notifyPartInstall 之前，确保 beilu 加载时能读到）
          try {
            const parts_config = loadData(username, "parts_config");

            // 策略1: 复用已有角色卡的 AIsource
            let defaultAIsource = "";
            for (const [key, val] of Object.entries(parts_config)) {
              if (key.startsWith("chars/") && val?.AIsource) {
                defaultAIsource = val.AIsource;
                break;
              }
            }

            // 策略2: 找 generator === "proxy" 的第一个 AI 源
            if (!defaultAIsource) {
              for (const [key, val] of Object.entries(parts_config)) {
                if (
                  key.startsWith("serviceSources/AI/") &&
                  val?.generator === "proxy"
                ) {
                  defaultAIsource = key.replace("serviceSources/AI/", "");
                  break;
                }
              }
            }

            if (defaultAIsource) {
              parts_config[`chars/${finalName}`] = {
                AIsource: defaultAIsource,
                plugins: [],
              };
              saveData(username, "parts_config");
              console.log(
                `[beilu-home] 自动配置 AIsource: "${defaultAIsource}" → chars/${finalName}`,
              );
            } else {
              console.warn(
                "[beilu-home] 未找到可用的 AIsource，新角色卡需要手动配置",
              );
            }
          } catch (e) {
            console.warn("[beilu-home] 自动配置 AIsource 失败:", e.message);
          }

          // 6. 通知 beilu 刷新 parts 缓存 + 跨客户端角色卡列表变更(G7)
          try {
            notifyPartInstall(username, `chars/${finalName}`);
          } catch (e) {
            console.warn("[beilu-home] notifyPartInstall 失败:", e.message);
          }
          try { sendEventToUser(username, "char-data-changed", { charName: finalName }); } catch { /* 不阻塞导入 */ }

          // 7. 迁移角色卡内嵌正则（extensions.regex_scripts）进 beilu-regex 运行时存储
          //    根因（2026-06-23 诊断）：应用层（displayRegex/applyRegexRules）只读 beilu-regex
          //    的 config_data.json.rules（in-memory pluginData），从不读 chardata.regex_scripts。
          //    旧迁移动作只在已废弃 beilu-home/usage.mjs 的前端 extractAndImportResources 里，
          //    当前激活壳 beilu-chat 导入路径不调它 → char 正则永不进库、永不生效。
          //    框架级修：迁移下沉到后端 import-char，所有导入入口（任一前端壳/直接 API）统一生效。
          //    口径：boundCharName = finalName（文件系统目录名），与删 char 清理（本文件 :670
          //    filter boundCharName!==charName）和前端显示层（messageList.mjs:1048 charKeyForRegex
          //    = timeSlice.charname 文件系统 key）一致。幂等：先按 finalName 清旧再导入，防重名/重复导入累积。
          try {
            const stRegexScripts = data?.extensions?.regex_scripts;
            if (Array.isArray(stRegexScripts) && stRegexScripts.length > 0) {
              const regexPlugin =
                parts_set[username]?.["plugins/beilu-regex"];
              if (regexPlugin?.interfaces?.config?.SetData) {
                // 插件已加载：走插件 action（importFromSTFormat 单一权威转换 + saveConfigToDisk，
                // 同时更新 in-memory pluginData 让运行中的 app 立即可见）。先清后导保证幂等。
                // [0719 错桶修·病族] in-process 直调必须带身份：regex SetData 读第二参 args.username
                //   分桶（T065 per-user），漏传=写 _default 桶、用户桶读不到=「角色卡正则导入不了」根因。
                await regexPlugin.interfaces.config.SetData({
                  _action: "removeByChar",
                  charName: finalName,
                }, { username });
                const imp = await regexPlugin.interfaces.config.SetData({
                  _action: "importST",
                  scripts: stRegexScripts,
                  scope: "scoped",
                  boundCharName: finalName,
                }, { username });
                console.log(
                  `[beilu-home] 角色 "${finalName}" 迁移 ${imp?._result?.count ?? stRegexScripts.length} 条正则进 beilu-regex（in-memory）`,
                );
              } else {
                // 插件未加载到 parts_set：直接落盘迁移（与删 char 的磁盘 fallback 对称）。
                // 复用 beilu-regex 导出的 importFromSTFormat，避免另写一份 placement 映射副本。
                const { importFromSTFormat } = await import(
                  "../../plugins/beilu-regex/main.mjs"
                );
                // [T077 补漏 2026-07-25] 路径对齐 per-user 分桶（与 regex 实现体 getConfigPath 同源推导:
                //   data/users/<u>/regex/config_data.json）——原写旧全局路径 plugins/beilu-regex/
                //   config_data.json：T077 per-user 化后运行时只读用户桶,此处=死写(fallback 导入的
                //   角色正则落在永不被读的位置,静默丢失)。分身D 侦察 0725 发现,主AI亲核。
                const { getUserDataDir } = await import(
                  "../../../../yonban/core/functions/memory/storage_mod/storage.mjs"
                );
                const regexConfigPath = path.join(
                  getUserDataDir(username || "_default"),
                  "regex",
                  "config_data.json",
                );
                // 新用户 regex 目录可能未建（首个正则写点在此 fallback 时）——建目录守卫
                const _fsm = await import("node:fs");
                _fsm.mkdirSync(path.dirname(regexConfigPath), { recursive: true });
                // T019：损坏→备份.corrupt.bak后抛错，本段迁移中止（外层catch报错），不空库顶上写回。
                const regexData = readJsonSafeSync(regexConfigPath, { rules: [], enabled: true });
                if (!Array.isArray(regexData.rules)) regexData.rules = [];
                // 幂等：先清掉该 finalName 已有 scoped 规则
                regexData.rules = regexData.rules.filter(
                  (r) => r.boundCharName !== finalName,
                );
                const converted = importFromSTFormat(
                  stRegexScripts,
                  "scoped",
                  finalName,
                  "",
                );
                regexData.rules.push(...converted);
                nicerWriteFileSync(
                  regexConfigPath,
                  JSON.stringify(regexData, null, 2),
                  "utf-8",
                );
                console.log(
                  `[beilu-home] 角色 "${finalName}" 迁移 ${converted.length} 条正则进 beilu-regex（磁盘 fallback，插件未加载）`,
                );
              }
            }
          } catch (e) {
            console.warn(
              `[beilu-home] 迁移角色 "${finalName}" 正则进 beilu-regex 失败:`,
              e.message,
            );
          }

          // 8. 迁移角色卡内嵌世界书（character_book）进 beilu-worldbook 运行时存储
          //    根因（2026-06-23 诊断 Batch1-A）：应用层 GetPrompt 只读 beilu-worldbook 的
          //    config_data.json.worldbooks（getAllEnabledEntries main.mjs:417 按 boundCharName 命中），
          //    从不读 chardata.character_book。旧迁移动作只在已废弃 beilu-home/usage.mjs:60 的前端
          //    extractAndImportResources 里，当前激活壳 beilu-chat 导入路径不调它 → 内嵌世界书永不注入。
          //    框架级修：与第 7 步正则迁移同模式，下沉到后端 import-char，所有导入入口统一生效。
          //    口径：boundCharName = finalName（文件系统目录名）。getAllEnabledEntries:429-433 命中条件为
          //    boundCharName === currentCharId || boundCharName === currentCharName，其中
          //    currentCharId = arg.char_id = requestBuilder.mjs:101 charname（目录名 = finalName），
          //    currentCharName = arg.Charname = charinfo.name||charname（显示名优先）。用 finalName 必经
          //    char_id 分支命中，与正则迁移口径一致，且即便显示名≠目录名也不漏（worldbook 双键 OR 比正则更宽）。
          //    幂等：先 removeByChar（按 boundCharName 清该 char 旧绑定世界书）再导入，防重复导入累积。
          //    character_book 可能位于 data.character_book 或 data.extensions.character_book（参 usage.mjs:61）。
          try {
            const charBook =
              data?.character_book || data?.extensions?.character_book;
            if (
              charBook?.entries &&
              (Array.isArray(charBook.entries)
                ? charBook.entries.length > 0
                : Object.keys(charBook.entries).length > 0)
            ) {
              const bookName = `${finalName} 世界书`;
              const worldbookPlugin =
                parts_set[username]?.["plugins/beilu-worldbook"];
              const entryCount = Array.isArray(charBook.entries)
                ? charBook.entries.length
                : Object.keys(charBook.entries).length;
              if (worldbookPlugin?.interfaces?.config?.SetData) {
                // 插件已加载：走插件 action（import_worldbook 内部 convertSTEntries +
                // saveConfigToDisk，同时更新 in-memory configData 让运行中的 app 立即可见）。
                // 先 removeByChar 保证幂等（按 boundCharName 清该 char 旧绑定世界书）。
                // [0719 错桶修·病族] worldbook SetData 读第二参 ctx.username 分桶（T074），
                //   漏传=写 _default 桶=「导入不了世界书」根因。
                await worldbookPlugin.interfaces.config.SetData({
                  removeByChar: { charName: finalName },
                }, { username });
                await worldbookPlugin.interfaces.config.SetData({
                  import_worldbook: {
                    json: charBook,
                    name: bookName,
                    boundCharName: finalName,
                  },
                }, { username });
                console.log(
                  `[beilu-home] 角色 "${finalName}" 迁移 ${entryCount} 条内嵌世界书进 beilu-worldbook（in-memory，绑定 "${finalName}"）`,
                );
              } else {
                // 插件未加载到 parts_set：直接落盘迁移（与删 char 的磁盘 fallback 对称）。
                // 复用 beilu-worldbook 导出的 convertSTEntries，避免另写一份转换副本。
                const { convertSTEntries } = await import(
                  "../../plugins/beilu-worldbook/main.mjs"
                );
                const worldbookConfigPath = path.join(
                  import.meta.dirname,
                  "../../plugins",
                  "beilu-worldbook",
                  "config_data.json",
                );
                // T019：损坏→备份.corrupt.bak后抛错中止，不空库顶上写回清空其他世界书。
                const worldbookData = readJsonSafeSync(worldbookConfigPath, {
                  active_worldbook: "",
                  worldbooks: {},
                });
                if (
                  !worldbookData.worldbooks ||
                  typeof worldbookData.worldbooks !== "object"
                ) {
                  worldbookData.worldbooks = {};
                }
                // 幂等：先清掉该 finalName 已绑定的世界书（与插件 removeByChar 同口径）
                for (const [wbName, wb] of Object.entries(
                  worldbookData.worldbooks,
                )) {
                  if (wb?.boundCharName === finalName) {
                    delete worldbookData.worldbooks[wbName];
                  }
                }
                const convertedEntries = convertSTEntries(charBook.entries);
                worldbookData.worldbooks[bookName] = {
                  entries: convertedEntries,
                  // 绑定书默认 enabled=false：靠 boundMatch(getAllEnabledEntries:430)私有注入到本角色；
                  // enabled=true 会经 globalEnabled(:425)泄漏进所有角色。与插件 import_worldbook:877 修后一致。
                  enabled: false,
                  boundCharName: finalName,
                };
                worldbookData.active_worldbook = bookName;
                nicerWriteFileSync(
                  worldbookConfigPath,
                  JSON.stringify(worldbookData, null, 2),
                  "utf-8",
                );
                console.log(
                  `[beilu-home] 角色 "${finalName}" 迁移 ${Object.keys(convertedEntries).length} 条内嵌世界书进 beilu-worldbook（磁盘 fallback，插件未加载，绑定 "${finalName}"）`,
                );
              }
            }
          } catch (e) {
            console.warn(
              `[beilu-home] 迁移角色 "${finalName}" 内嵌世界书进 beilu-worldbook 失败:`,
              e.message,
            );
          }

          console.log(
            `[beilu-home] 角色卡已导入: "${finalName}" (原名: "${charName}", user: ${username})`,
          );
          res.status(201).json({
            success: true,
            name: finalName,
            original_name: charName,
            // 返回角色卡数据供前端统计附属资源数量（正则 + 世界书的实际导入已在上方 Step 7/8 完成）
            chardata: data,
          });
        } catch (error) {
          console.error("[beilu-home] Error importing char:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );

    // ============================================================
    // DELETE /api/parts/shells:beilu-home/delete-char/:charName
    // 删除角色卡（移动到回收站）
    // Body 可选参数:
    //   deleteChats: boolean — 是否同时删除该角色的聊天记录
    //   deleteMemory: boolean — 是否同时删除该角色的记忆数据
    //   deleteWorldbook: boolean — 是否同时删除绑定的世界书
    // 正则规则始终自动删除（无需询问）
    // ============================================================
    router.delete(
      "/api/parts/shells\\:beilu-home/delete-char/:charName",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { charName } = req.params;
          const options = req.body || {};

          if (!charName) {
            return res.status(400).json({ message: "缺少角色名称" });
          }

          const userDir = getUserDictionary(username);
          const charDir = path.join(userDir, "chars", charName);

          if (!fs.existsSync(charDir)) {
            return res
              .status(404)
              .json({ message: `角色 "${charName}" 不存在` });
          }

          const partpath = `chars/${charName}`;
          const cleanupResults = {
            regex: false,
            worldbook: false,
            chats: 0,
            memory: false,
          };

          const failedPaths = [];
          const rmDirWithRetry = async (dirPath, label) => {
            if (!fs.existsSync(dirPath)) return true;
            const r = await safeTrash(dirPath, `delete-char_${label}`);
            if (!r.success) {
              failedPaths.push({ path: dirPath, label, error: r.error || "safeTrash failed" });
              return false;
            }
            return true;
          };

          // 插件配置文件的固定路径（不依赖 parts_set 运行时加载状态）
          const pluginsDir = path.join(import.meta.dirname, "../../plugins");

          // 1. 正则规则 — 始终自动删除（直接操作磁盘文件）
          // [T077 per-user 补齐] 正则真库已迁 data/users/<u>/regex/config_data.json（regex getStore
          //   per-user 分桶），原全局 plugins/beilu-regex/config_data.json 是退役旧路径——继续写旧路径
          //   = 插件未加载时用户桶残留不清（endpoints.mjs:903 同型已修，本入口漏了=删角色后正则还在）。
          try {
            const regexConfigPath = path.join(
              userDir,
              "regex",
              "config_data.json",
            );
            if (fs.existsSync(regexConfigPath)) {
              const regexData = JSON.parse(
                fs.readFileSync(regexConfigPath, "utf-8"),
              );
              if (Array.isArray(regexData.rules)) {
                const before = regexData.rules.length;
                regexData.rules = regexData.rules.filter(
                  (r) => r.boundCharName !== charName,
                );
                const removed = before - regexData.rules.length;
                if (removed > 0) {
                  nicerWriteFileSync(
                    regexConfigPath,
                    JSON.stringify(regexData, null, 2),
                    "utf-8",
                  );
                  console.log(
                    `[beilu-home] 已清理角色 "${charName}" 绑定的 ${removed} 条正则规则`,
                  );
                }
                cleanupResults.regex = true;
              }
            }
            // 如果插件已加载到 parts_set，同步内存状态
            try {
              const regexPlugin = parts_set[username]?.["plugins/beilu-regex"];
              if (regexPlugin?.interfaces?.config?.SetData) {
                // [0719 错桶修·病族] 同上：漏 args.username=清理落 _default 桶（用户桶残留不清）
                await regexPlugin.interfaces.config.SetData({
                  _action: "removeByChar",
                  charName,
                }, { username });
              }
            } catch (_) {
              /* 插件未加载时忽略 */
            }
          } catch (e) {
            console.warn("[beilu-home] 清理绑定正则失败:", e.message);
          }

          // 2. 世界书 — 根据用户选择（直接操作磁盘文件）
          if (options.deleteWorldbook) {
            try {
              const wbConfigPath = path.join(
                pluginsDir,
                "beilu-worldbook",
                "config_data.json",
              );
              if (fs.existsSync(wbConfigPath)) {
                const wbData = JSON.parse(
                  fs.readFileSync(wbConfigPath, "utf-8"),
                );
                // N23：worldbooks 真实类型是对象/map（worldbook/main.mjs:162 `worldbooks:{}`，全程 Object.entries/[name] 访问），
                //   原 Array.isArray 对对象恒 false=死分支 → 删角色时磁盘侧清理绑定世界书永不执行。改对象遍历删除，
                //   范式照 worldbook/main.mjs removeByChar（按 boundCharName 删 key）。
                if (wbData.worldbooks && typeof wbData.worldbooks === "object") {
                  const toRemove = Object.keys(wbData.worldbooks).filter(
                    (name) => wbData.worldbooks[name]?.boundCharName === charName,
                  );
                  if (toRemove.length > 0) {
                    for (const name of toRemove) delete wbData.worldbooks[name];
                    // active_worldbook 若被删则重指（避免悬空激活指向已删世界书）
                    if (toRemove.includes(wbData.active_worldbook)) {
                      const remaining = Object.keys(wbData.worldbooks);
                      wbData.active_worldbook = remaining.length > 0 ? remaining[0] : "";
                    }
                    nicerWriteFileSync(
                      wbConfigPath,
                      JSON.stringify(wbData, null, 2),
                      "utf-8",
                    );
                    console.log(
                      `[beilu-home] 已清理角色 "${charName}" 绑定的 ${toRemove.length} 个世界书`,
                    );
                  }
                  cleanupResults.worldbook = true;
                }
              }
              // 如果插件已加载到 parts_set，同步内存状态
              try {
                const worldbookPlugin =
                  parts_set[username]?.["plugins/beilu-worldbook"];
                if (worldbookPlugin?.interfaces?.config?.SetData) {
                  // [0719 错桶修·病族] 同上：漏 ctx.username=清理落 _default 桶
                  await worldbookPlugin.interfaces.config.SetData({
                    removeByChar: { charName },
                  }, { username });
                }
              } catch (_) {
                /* 插件未加载时忽略 */
              }
            } catch (e) {
              console.warn("[beilu-home] 清理绑定世界书失败:", e.message);
            }
          }

          // 3. 聊天记录 — 根据用户选择
          // 策略：优先通过 beilu-chat 接口（知道正确的存储路径，无论新旧），
          //       手动磁盘删除作为 fallback
          if (options.deleteChats) {
            try {
              const chatShell = parts_set[username]?.["shells/beilu-chat"];
              let chatIdsToDelete = [];

              // 方式1：通过 beilu-chat 接口获取该角色的所有 chatId，然后统一删除
              if (
                chatShell?.interfaces?.chat?.getChatIdsByCharName &&
                chatShell?.interfaces?.chat?.deleteChat
              ) {
                chatIdsToDelete =
                  chatShell.interfaces.chat.getChatIdsByCharName(
                    username,
                    charName,
                  );
                if (chatIdsToDelete.length > 0) {
                  const results = await chatShell.interfaces.chat.deleteChat(
                    chatIdsToDelete,
                    username,
                  );
                  const successCount = results.filter((r) => r.success).length;
                  cleanupResults.chats = successCount;
                  console.log(
                    `[beilu-home] 通过 beilu-chat 接口删除 ${successCount}/${chatIdsToDelete.length} 个聊天`,
                  );
                }
              }

              // 方式2（fallback）：直接删除 chars/{charName}/chats/ 目录下的文件
              // 处理 beilu-chat 未加载、或接口未找到所有文件的情况
              const chatsDir = path.join(charDir, "chats");
              if (fs.existsSync(chatsDir)) {
                const chatFiles = fs
                  .readdirSync(chatsDir)
                  .filter((f) => f.endsWith(".json"));
                for (const file of chatFiles) {
                  const chatid = file.replace(".json", "");
                  if (!chatIdsToDelete.includes(chatid)) {
                    try {
                      await safeUnlink(path.join(chatsDir, file), "delete-char_聊天文件");
                      cleanupResults.chats++;
                    } catch (e) {
                      console.warn(`[beilu-home] 删除聊天文件 ${file} 失败:`, e.message,
                      );
                    }
                  }
                }
              }

              // 方式3（兼容旧路径）：检查 shells/chat/chats/ 下是否有该角色的聊天文件
              const oldChatsDir = path.join(userDir, "shells", "chat", "chats");
              if (fs.existsSync(oldChatsDir)) {
                const oldChatFiles = fs
                  .readdirSync(oldChatsDir)
                  .filter((f) => f.endsWith(".json"));
                for (const file of oldChatFiles) {
                  try {
                    const raw = JSON.parse(
                      fs.readFileSync(path.join(oldChatsDir, file), "utf-8"),
                    );
                    const lastEntry = raw.chatLog?.[raw.chatLog.length - 1];
                    const chars = lastEntry?.timeSlice?.chars || [];
                    if (Array.isArray(chars) && chars.includes(charName)) {
                      await safeUnlink(path.join(oldChatsDir, file), "delete-char_旧路径聊天");
                      cleanupResults.chats++;
                    }
                  } catch (_) {
                    /* 解析失败跳过 */
                  }
                }
              }

              // 清理 summaries cache 中该角色的聊天
              try {
                const cachePath = path.join(
                  userDir,
                  "shells",
                  "chat",
                  "chat_summaries_cache.json",
                );
                if (fs.existsSync(cachePath)) {
                  const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
                  let changed = false;
                  for (const [chatid, summary] of Object.entries(cache)) {
                    if (summary?.chars?.includes?.(charName)) {
                      delete cache[chatid];
                      changed = true;
                    }
                  }
                  if (changed) {
                    nicerWriteFileSync(
                      cachePath,
                      JSON.stringify(cache, null, 2),
                      "utf-8",
                    );
                  }
                }
              } catch (_) {
                /* 缓存清理失败不影响主流程 */
              }
            } catch (e) {
              console.warn("[beilu-home] 清理聊天记录失败:", e.message);
            }
          }

          // 4. 记忆数据 — 根据用户选择（在 uninstallPartBase 之前主动处理）
          if (options.deleteMemory) {
            // 主动删除新路径 chars/{charName}/memory/（不依赖 uninstallPartBase 的 trash）
            const memoryDir = path.join(charDir, "memory");
            const okMem = await rmDirWithRetry(memoryDir, "记忆目录");
            // 同时清理旧路径残留 memory/{charName}/
            const oldMemoryDir = path.join(userDir, "memory", charName);
            const okOldMem = await rmDirWithRetry(oldMemoryDir, "旧记忆目录");
            // 仅当两处都成功（或本不存在）才算记忆已清理
            cleanupResults.memory = okMem && okOldMem;
          } else {
            // 用户选择保留记忆 → 备份 memory 目录到临时位置
            const memoryDir = path.join(charDir, "memory");
            const tempMemoryDir = path.join(
              userDir,
              "_temp_memory_backup_" + charName,
            );
            if (fs.existsSync(memoryDir)) {
              try {
                fs.cpSync(memoryDir, tempMemoryDir, { recursive: true });
              } catch (e) {
                console.warn("[beilu-home] 备份记忆数据失败:", e.message);
              }
            }
            // 标记需要恢复
            options._restoreMemoryFrom = tempMemoryDir;
          }

          // 5. 使用 beilu 的 uninstallPartBase 进行完整卸载
          // 清理 5 层缓存：parts_set / parts_init / parts_config / parts_details_cache / parts_branch_cache
          // 加 try-catch 保护：trash 对中文路径可能失败，回退为 rmSync
          try {
            await uninstallPartBase(username, partpath, undefined, undefined, {
              pathGetter: () => charDir,
            });
          } catch (uninstallErr) {
            console.warn(
              `[beilu-home] uninstallPartBase 失败(${uninstallErr.message})，手动删除目录...`,
            );
            // 手动回退删除（带重试）；失败会进 failedPaths，步8 还会再尝试一次
            await rmDirWithRetry(charDir, "角色卡目录(uninstall回退)");
          }

          // 6. 如果需要恢复记忆数据（用户选择保留时）
          if (
            options._restoreMemoryFrom &&
            fs.existsSync(options._restoreMemoryFrom)
          ) {
            try {
              // 恢复到独立的 memory/{charName}/ 目录（角色卡已删除，chars/ 不再存在）
              const restoredDir = path.join(userDir, "memory", charName);
              fs.cpSync(options._restoreMemoryFrom, restoredDir, {
                recursive: true,
              });
              fs.rmSync(options._restoreMemoryFrom, {
                recursive: true,
                force: true,
              });
              console.log(`[beilu-home] 记忆数据已保留到: ${restoredDir}`);
            } catch (e) {
              console.warn("[beilu-home] 恢复记忆数据失败:", e.message);
            }
          }

          // 7. 通知 beilu-memory 清理内存缓存
          try {
            const memPlugin = parts_set[username]?.["plugins/beilu-memory"];
            if (memPlugin?.interfaces?.config?.SetData) {
              await memPlugin.interfaces.config.SetData({
                _action: "clearCache",
                charName,
                username,
              });
            }
          } catch (_) {
            /* 插件未加载时忽略 */
          }

          // 8. 保险：确保角色卡目录被彻底删除（防止 trash/rmSync 因路径或占用问题遗漏）
          //    这是 charDir 的最终裁决：成功则撤销步5回退留下的同路径失败记录。
          const charDirOk = await rmDirWithRetry(charDir, "角色卡目录(保险清理)");
          if (charDirOk) {
            // charDir 已删干净 → 移除 failedPaths 中所有指向 charDir 的记录（步5回退可能已 push）
            for (let i = failedPaths.length - 1; i >= 0; i--) {
              if (failedPaths[i].path === charDir) failedPaths.splice(i, 1);
            }
            console.log(
              `[beilu-home] 保险清理：角色卡目录已删除: ${charDir}`,
            );
          }

          // 最终回报：任一关键目录删除失败 → success:false + failedPaths，让前端能提示重试
          if (failedPaths.length > 0) {
            console.error(
              `[beilu-home] 角色卡删除未彻底: "${charName}" (user: ${username})，残留:`,
              failedPaths,
            );
            return res.status(500).json({
              success: false,
              name: charName,
              cleanup: cleanupResults,
              failedPaths,
              error: `删除未彻底：${failedPaths.length} 个目录残留（可能被进程占用，请稍后重试）`,
            });
          }

          console.log(
            `[beilu-home] 角色卡已删除（含缓存清理）: "${charName}" (user: ${username})`,
            cleanupResults,
          );
          res
            .status(200)
            .json({ success: true, name: charName, cleanup: cleanupResults });
        } catch (error) {
          console.error("[beilu-home] Error deleting char:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );

    // ============================================================
    // PUT /api/parts/shells:beilu-home/update-char/:charName
    // 更新角色卡数据（chardata.json 字段 + 可选头像上传）
    // Body JSON: 可选文本字段 name/first_mes/description/personality/scenario/mes_example/system_prompt/post_history_instructions/creator_notes，及 extensions(深合并)/alternate_greetings
    // 或 multipart: avatar 文件 + JSON 字段
    // ============================================================
    router.put(
      "/api/parts/shells\\:beilu-home/update-char/:charName",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { charName } = req.params;

          if (!charName) {
            return res.status(400).json({ message: "缺少角色名称" });
          }

          const userDir = getUserDictionary(username);
          const charDir = path.join(userDir, "chars", charName);

          if (!fs.existsSync(charDir)) {
            return res
              .status(404)
              .json({ message: `角色 "${charName}" 不存在` });
          }

          const chardataPath = path.join(charDir, "chardata.json");
          let chardata = {};
          if (fs.existsSync(chardataPath)) {
            chardata = JSON.parse(fs.readFileSync(chardataPath, "utf-8"));
          }

          // 更新文本字段
          const updates = req.body || {};
          const allowedFields = [
            "name",
            "first_mes",
            "description",
            "personality",
            "scenario",
            "mes_example",
            "system_prompt",
            "post_history_instructions",
            "creator_notes",
          ];
          let changed = false;
          for (const field of allowedFields) {
            if (updates[field] !== undefined) {
              chardata[field] = updates[field];
              changed = true;
            }
          }

          // extensions 深度合并更新（支持修改 tavern_helper.scripts 等嵌套字段）
          if (updates.extensions && typeof updates.extensions === "object") {
            if (
              !chardata.extensions ||
              typeof chardata.extensions !== "object"
            ) {
              chardata.extensions = {};
            }
            // 递归浅合并第一层 key（如 tavern_helper）
            for (const [extKey, extVal] of Object.entries(updates.extensions)) {
              if (
                extVal &&
                typeof extVal === "object" &&
                !Array.isArray(extVal)
              ) {
                if (
                  !chardata.extensions[extKey] ||
                  typeof chardata.extensions[extKey] !== "object"
                ) {
                  chardata.extensions[extKey] = {};
                }
                Object.assign(chardata.extensions[extKey], extVal);
              } else {
                chardata.extensions[extKey] = extVal;
              }
            }
            changed = true;
          }
          // alternate_greetings 数组（兼容 FormData 字符串传输）
          let altGreetings = updates.alternate_greetings;
          if (typeof altGreetings === "string") {
            try {
              altGreetings = JSON.parse(altGreetings);
            } catch (_) {
              altGreetings = null;
            }
          }
          if (Array.isArray(altGreetings)) {
            chardata.alternate_greetings = altGreetings;
            changed = true;
          }

          if (changed) {
            nicerWriteFileSync(
              chardataPath,
              JSON.stringify(chardata, null, "\t"),
              "utf-8",
            );
          }

          // 如果 name 字段变更，同步更新 info.json
          if (updates.name !== undefined) {
            const infoPath = path.join(charDir, "info.json");
            if (fs.existsSync(infoPath)) {
              const infoData = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
              for (const lang of Object.keys(infoData)) {
                if (typeof infoData[lang] === "object") {
                  infoData[lang].name = updates.name;
                }
              }
              nicerWriteFileSync(
                infoPath,
                JSON.stringify(infoData, null, "\t"),
                "utf-8",
              );
            }
          }

          // 处理头像上传
          const avatarFile = req.files?.avatar;
          if (avatarFile) {
            const publicDir = path.join(charDir, "public");
            fs.mkdirSync(publicDir, { recursive: true });
            fs.writeFileSync(
              path.join(publicDir, "image.png"),
              avatarFile.data,
            );
          }

          // 清除 parts_details_cache 以刷新
          try {
            const cache = loadData(username, "parts_details_cache");
            delete cache[`chars/${charName}`];
            saveData(username, "parts_details_cache");
          } catch (_) {
            /* 静默 */
          }

          console.log(
            `[beilu-home] 角色卡已更新: "${charName}" (user: ${username})`,
          );
          // 跨客户端：通知该用户所有端，正在看此卡的角色信息面板/选卡器重载（编辑非安装，故用专用事件）。
          try { sendEventToUser(username, "char-data-changed", { charName }); } catch { /* 同步不阻塞保存 */ }
          res.status(200).json({ success: true, name: charName, chardata });
        } catch (error) {
          console.error("[beilu-home] Error updating char:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );

    // ============================================================
    // GET /api/parts/shells:beilu-home/char-data/:charName
    // 获取角色卡完整数据
    // ============================================================
    router.get(
      "/api/parts/shells\\:beilu-home/char-data/:charName",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { charName } = req.params;
          const userDir = getUserDictionary(username);
          const chardataPath = path.join(
            userDir,
            "chars",
            charName,
            "chardata.json",
          );

          if (!fs.existsSync(chardataPath)) {
            return res
              .status(404)
              .json({ message: `角色 "${charName}" 数据不存在` });
          }

          const chardata = JSON.parse(fs.readFileSync(chardataPath, "utf-8"));
          res.status(200).json(chardata);
        } catch (error) {
          console.error("[beilu-home] Error reading char data:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );

    // ============================================================
    // GET /api/parts/shells:beilu-home/char/:charName/export
    // 导出角色卡为 ST V2 PNG（chara tEXt 块）或 JSON
    // ============================================================
    router.get(
      "/api/parts/shells\\:beilu-home/char/:charName/export",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { charName } = req.params;
          const format = req.query.format || "png";
          const userDir = getUserDictionary(username);
          const charDir = path.join(userDir, "chars", charName);
          const chardataPath = path.join(charDir, "chardata.json");
          if (!fs.existsSync(chardataPath)) {
            return res.status(404).json({ message: `角色 "${charName}" 数据不存在` });
          }
          const chardata = JSON.parse(fs.readFileSync(chardataPath, "utf-8"));
          if (format === "json") {
            res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(charName)}.json"`);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            return res.status(200).send(JSON.stringify(chardata, null, 2));
          }
          const avatarPath = path.join(charDir, "public", "image.png");
          if (!fs.existsSync(avatarPath)) {
            // 无头像 PNG 时自动降级 JSON 导出（E1 框架级修：无图角色也可导出）
            res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(charName)}.json"`);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            return res.status(200).send(JSON.stringify(chardata, null, 2));
          }
          const { write: writePng } = await import("../ImportHandlers/SillyTavern/data_reader.mjs");
          const imageBuffer = fs.readFileSync(avatarPath);
          const exportData = JSON.stringify(chardata);
          const resultPng = writePng(imageBuffer, exportData);
          res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(charName)}.png"`);
          res.setHeader("Content-Type", "image/png");
          res.status(200).send(resultPng);
        } catch (error) {
          console.error("[beilu-home] char export error:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );

    // ============================================================
    // POST /api/parts/shells:beilu-home/create-persona
    // 创建新用户人设（支持头像上传）
    // ============================================================
    router.post(
      "/api/parts/shells\\:beilu-home/create-persona",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { name, description } = req.body || {};

          if (!name || typeof name !== "string" || !name.trim()) {
            return res.status(400).json({ message: "人设名称不能为空" });
          }

          const personaName = name.trim();
          if (/[\/\\:*?"<>|]/.test(personaName)) {
            return res.status(400).json({ message: "人设名称包含非法字符" });
          }

          const userDir = getUserDictionary(username);
          const personaDir = path.join(userDir, "personas", personaName);

          if (fs.existsSync(personaDir)) {
            return res
              .status(409)
              .json({ message: `人设 "${personaName}" 已存在` });
          }

          // 创建目录
          fs.mkdirSync(personaDir, { recursive: true });

          // 复制模板 main.mjs
          const templateMain = path.join(PERSONA_TEMPLATE_DIR, "main.mjs");
          if (fs.existsSync(templateMain)) {
            fs.copyFileSync(templateMain, path.join(personaDir, "main.mjs"));
          } else {
            fs.rmSync(personaDir, { recursive: true, force: true });
            return res.status(500).json({ message: "人设模板缺失" });
          }

          // 写入 beilu-part.json
          nicerWriteFileSync(
            path.join(personaDir, "beilu-part.json"),
            JSON.stringify(
              { type: "personas", dirname: personaName },
              null,
              "\t",
            ),
            "utf-8",
          );

          // 处理头像上传（统一文件名 image.png：全库头像标准名，与 chat 壳 persona 写点
          //   endpoints.mjs:2890 及全库角色卡 chars public/image.png 对齐——原 home 壳 persona 单独
          //   用 avatar.png 是唯一异类，同一 persona 被两壳先后编辑会残留孤儿文件+磁盘双份。
          //   读侧数据驱动（info.json avatar 字段 → URL 拼接，见 persona.mjs:104/sidebar.mjs:191），
          //   历史 avatar.png 由旧 info.json avatar 字段继续指向，不迁移文件[T6双键批]）
          let avatarFileName = "";
          const avatarFile = req.files?.avatar;
          if (avatarFile) {
            const publicDir = path.join(personaDir, "public");
            fs.mkdirSync(publicDir, { recursive: true });
            avatarFileName = "image.png";
            fs.writeFileSync(
              path.join(publicDir, avatarFileName),
              avatarFile.data,
            );
          }

          // 写入 info.json
          const infoData = {
            "zh-CN": {
              name: personaName,
              avatar: avatarFileName,
              description: description || "",
              version: "0.1.0",
              author: username,
            },
            "en-UK": {
              name: personaName,
              avatar: avatarFileName,
              description: description || "",
              version: "0.1.0",
              author: username,
            },
          };
          nicerWriteFileSync(
            path.join(personaDir, "info.json"),
            JSON.stringify(infoData, null, "\t"),
            "utf-8",
          );

          // 通知 beilu 刷新
          try {
            notifyPartInstall(username, `personas/${personaName}`);
          } catch (e) {
            console.warn(
              "[beilu-home] notifyPartInstall(persona) 失败:",
              e.message,
            );
          }

          // 写入 parts_details_cache，确保前端 getAllCachedPartDetails 能立即获取头像等信息
          try {
            const cache = loadData(username, "parts_details_cache");
            cache[`personas/${personaName}`] = {
              info: infoData,
              supportedInterfaces: [],
            };
            saveData(username, "parts_details_cache");
          } catch (_) {
            /* 静默 */
          }

          console.log(
            `[beilu-home] 人设已创建: "${personaName}" (user: ${username})`,
          );
          res.status(201).json({ success: true, name: personaName });
        } catch (error) {
          console.error("[beilu-home] Error creating persona:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );
    // ============================================================
    // PUT /api/parts/shells:beilu-home/update-persona/:name
    // 更新用户人设（描述 + 可选头像上传）
    // ============================================================
    router.put(
      "/api/parts/shells\\:beilu-home/update-persona/:name",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { name: personaName } = req.params;
          const { description } = req.body || {};

          if (!personaName) {
            return res.status(400).json({ message: "缺少人设名称" });
          }

          const userDir = getUserDictionary(username);
          const personaDir = path.join(userDir, "personas", personaName);

          if (!fs.existsSync(personaDir)) {
            return res
              .status(404)
              .json({ message: `人设 "${personaName}" 不存在` });
          }

          // 处理头像上传（统一文件名 image.png，同 create-persona 写点，与全库头像标准名对齐[T6双键批]）
          const avatarFile = req.files?.avatar;
          let avatarFileName = undefined; // undefined = 不更新 avatar 字段
          if (avatarFile) {
            const publicDir = path.join(personaDir, "public");
            fs.mkdirSync(publicDir, { recursive: true });
            avatarFileName = "image.png";
            fs.writeFileSync(
              path.join(publicDir, avatarFileName),
              avatarFile.data,
            );
          }

          // 读取并更新 info.json
          const infoPath = path.join(personaDir, "info.json");
          let infoData = {};
          if (fs.existsSync(infoPath)) {
            infoData = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
          }

          // 更新所有语言的 description 和 avatar
          for (const lang of Object.keys(infoData)) {
            if (typeof infoData[lang] === "object") {
              if (description !== undefined)
                infoData[lang].description = description;
              if (avatarFileName !== undefined)
                infoData[lang].avatar = avatarFileName;
            }
          }
          // 如果 info.json 为空或没有语言键，创建默认结构
          if (Object.keys(infoData).length === 0) {
            infoData = {
              "zh-CN": {
                name: personaName,
                description: description || "",
                avatar: avatarFileName || "",
              },
              "en-UK": {
                name: personaName,
                description: description || "",
                avatar: avatarFileName || "",
              },
            };
          }

          nicerWriteFileSync(
            infoPath,
            JSON.stringify(infoData, null, "\t"),
            "utf-8",
          );

          // 更新 parts_details_cache（写入最新的 info，而非仅删除缓存）
          try {
            const cache = loadData(username, "parts_details_cache");
            cache[`personas/${personaName}`] = {
              info: infoData,
              supportedInterfaces: [],
            };
            saveData(username, "parts_details_cache");
          } catch (_) {
            /* 静默 */
          }

          console.log(
            `[beilu-home] 人设已更新: "${personaName}" (user: ${username})`,
          );
          res.status(200).json({ success: true, name: personaName });
        } catch (error) {
          console.error("[beilu-home] Error updating persona:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );

    // ============================================================
    // DELETE /api/parts/shells:beilu-home/delete-persona/:name
    // 删除用户人设
    // ============================================================
    router.delete(
      "/api/parts/shells\\:beilu-home/delete-persona/:name",
      authenticate,
      async (req, res) => {
        try {
          const { username } = await getUserByReq(req);
          const { name: personaName } = req.params;

          if (!personaName) {
            return res.status(400).json({ message: "缺少人设名称" });
          }

          const partpath = `personas/${personaName}`;

          // 使用 beilu 的 uninstallPartBase 完整卸载
          // 加 try-catch 保护：trash 对中文路径可能失败，回退为 rmSync
          try {
            await uninstallPartBase(username, partpath);
          } catch (uninstallErr) {
            console.warn(
              `[beilu-home] uninstallPartBase(persona) 失败(${uninstallErr.message})，手动删除目录...`,
            );
            const userDir = getUserDictionary(username);
            const personaDir = path.join(userDir, "personas", personaName);
            if (fs.existsSync(personaDir)) {
              try {
                await safeTrash(personaDir, "删除人设_fallback");
              } catch (rmErr) {
                console.error("[beilu-home] safeTrash 人设目录也失败:", rmErr.message);
              }
            }
          }

          console.log(
            `[beilu-home] 人设已删除: "${personaName}" (user: ${username})`,
          );
          res.status(200).json({ success: true, name: personaName });
        } catch (error) {
          console.error("[beilu-home] Error deleting persona:", error);
          res.status(500).json({ message: error.message });
        }
      },
    );

    // 诊断系统 API（diag/*）已迁至 beilu-chat/src/endpoints.mjs（shells:chat/diag/*）
  },
  Unload: () => {},
  interfaces: {
    web: {},
  },
};
