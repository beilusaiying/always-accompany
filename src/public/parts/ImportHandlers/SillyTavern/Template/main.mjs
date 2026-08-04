import fs from "node:fs";
import path from "node:path";

import { regex_placement } from "../../../../../src/public/parts/ImportHandlers/SillyTavern/engine/charData.mjs";
import { getCharacterSource } from "../../../../../src/public/parts/ImportHandlers/SillyTavern/engine/data.mjs";
import { evaluateMacros } from "../../../../../src/public/parts/ImportHandlers/SillyTavern/engine/marco.mjs";
import { promptBuilder } from "../../../../../src/public/parts/ImportHandlers/SillyTavern/engine/prompt_builder.mjs";
import { runRegex } from "../../../../../src/public/parts/ImportHandlers/SillyTavern/engine/regex.mjs";
import { buildPromptStruct } from "../../../../../src/public/parts/shells/beilu-chat/src/prompt_struct.mjs";
import { saveJsonFile } from "../../../../../src/scripts/json_loader.mjs";
import {
  loadAnyPreferredDefaultPart,
  loadPart,
} from "../../../../../src/server/parts_loader.mjs";

/** @typedef {import('../../../../../src/decl/pluginAPI.ts').PluginAPI_t} PluginAPI_t */
/** @typedef {import('../../../../../src/decl/charAPI.ts').CharAPI_t} CharAPI_t */
/** @typedef {import('../../../../../src/decl/AIsource.ts').AIsource_t} AIsource_t */
/** @typedef {import('../../../../../src/public/parts/shells/chat/decl/chatLog.ts').chatReplyRequest_t} chatReplyRequest_t */
/** @typedef {import('../../../../../src/public/parts/ImportHandlers/SillyTavern/engine/charData.mjs').v2CharData} chardata_t */

/** @type {AIsource_t} */
let AIsource = null;
/** @type {Record<string, PluginAPI_t>} */
let plugins = {};

let username = "";

const chardir = import.meta.dirname;
const charurl = `/parts/chars:${encodeURIComponent(path.basename(chardir))}`;
const charjson = path.join(chardir, "chardata.json");

/** @type {chardata_t} */
// [0722 排雷] 原裸 JSON.parse(readFileSync)：chardata.json 缺失/损坏时 import 期抛裸 SyntaxError
//   （无文件路径，load_failed 日志不可诊断）。仍然失败（无数据角色无法工作，诚实 fail），但错误带
//   路径+原因，加载器 per-part 隔离住、日志可直接定位到哪个实例哪个文件。
let chardata;
try {
  chardata = JSON.parse(fs.readFileSync(charjson));
} catch (e) {
  throw new Error(`[chars] chardata.json 读取/解析失败（角色实例无法加载）: ${charjson}: ${e?.message || e}`);
}

/**
 * 构建角色 info（每次调用按当前 chardata + charurl 求值）。
 * 供静态 info 与 interfaces.info.UpdateInfo 复用——后者让 parts_loader
 * (nocacheGetPartBaseDetails:940 优先调 UpdateInfo) 每次取新鲜 info，规避部件 import 时
 * 一次性快照导致的 stale（SetData 改了 chardata 但旧 info 对象不刷新 / 显示名/标签编辑后不更新）。
 * avatar 用无条件 charurl 路径（不 fs.existsSync），避免 image.png 晚于 import 写入时烤进空串。
 * @returns {Record<string, any>}
 */
function buildCharInfo() {
  return {
    "": {
      name: chardata.name,
      avatar: charurl + "/image.png",
      description: evaluateMacros(chardata.creator_notes, {
        char: chardata.name,
        user: "user",
        model: "model",
        charVersion: chardata.character_version,
        char_version: chardata.character_version,
      }).split("\n")[0],
      description_markdown: evaluateMacros(chardata.creator_notes, {
        char: chardata.name,
        user: "user",
        model: "model",
        charVersion: chardata.character_version,
        char_version: chardata.character_version,
      }),
      version: chardata.character_version,
      author: chardata.creator || chardata.create_by,
      home_page: getCharacterSource(chardata),
      tags: chardata.tags,
    },
  };
}

/** @type {CharAPI_t} */
export default {
  info: buildCharInfo(),

  /**
   * @param {any} stat 状态
   */
  Load: (stat) => {
    username = stat.username;
  },

  interfaces: {
    info: {
      // 每次调用按当前 chardata/charurl 重算 info，parts_loader nocache 路径(:940)优先用它取新鲜值，规避 stale 快照。
      UpdateInfo: () => buildCharInfo(),
    },
    config: {
      // 导入模板首次加载也需要执行 SetData({})，以沿用既有默认 AI 源初始化链。
      loadPolicy: "always",
      /**
       * 获取数据
       * @returns {{ AIsource: any; chardata: chardata_t; }} 一个包含 AI 源和角色数据的对象。
       */
      GetData: () => ({
        AIsource: AIsource?.filename || "",
        plugins: Object.keys(plugins),
        chardata,
      }),
      /**
       * 设置数据
       * @param {{ chardata: chardata_t; AIsource: string; }} data 数据
       */
      SetData: async (data) => {
        if (data.chardata) {
          chardata = data.chardata;
          saveJsonFile(charjson, chardata);
        }
        if (data.plugins)
          plugins = Object.fromEntries(
            await Promise.all(
              data.plugins.map(async (x) => [
                x,
                await loadPart(username, "plugins/" + x),
              ]),
            ),
          );
        if (data.AIsource)
          AIsource = await loadPart(
            username,
            "serviceSources/AI/" + data.AIsource,
          );
        else
          AIsource = await loadAnyPreferredDefaultPart(
            username,
            "serviceSources/AI",
          );
      },
    },
    chat: {
      /**
       * 获取问候语
       * @returns {{ content: any; content_for_show: any; }} 一个包含问候语内容的对象。
       * @param {any} args 参数
       * @param {any} index 索引
       */
      GetGreeting: (args, index) => {
        const greetings = [
          chardata?.first_mes,
          ...(chardata?.alternate_greetings ?? []),
        ].filter((x) => x);
        if (index >= greetings.length) throw new Error("Invalid index");
        const result = evaluateMacros(greetings[index], {
          char: chardata.name,
          user: args.UserCharname,
          model: AIsource?.filename,
          charVersion: chardata.character_version,
          char_version: chardata.character_version,
        });
        return {
          content: runRegex(
            chardata,
            result,
            (e) =>
              e.placement.includes(regex_placement.AI_OUTPUT) &&
              !e.markdownOnly &&
              !e.promptOnly,
          ),
          content_for_show: runRegex(
            chardata,
            result,
            (e) =>
              e.placement.includes(regex_placement.AI_OUTPUT) && !e.promptOnly,
          ),
        };
      },
      /**
       * 获取群组问候语
       * @returns {{ content: any; content_for_show: any; }} 一个包含群组问候语内容的对象。
       * @param {any} args 参数
       * @param {any} index 索引
       */
      GetGroupGreeting: (args, index) => {
        const greetings = [
          ...new Set(
            [
              ...(chardata?.extensions?.group_greetings ?? []),
              ...(chardata?.group_only_greetings ?? []),
            ].filter((x) => x),
          ),
        ];
        if (index >= greetings.length) throw new Error("Invalid index");
        const result = evaluateMacros(greetings[index], {
          char: chardata.name,
          user: args.UserCharname,
          model: AIsource?.filename,
          charVersion: chardata.character_version,
          char_version: chardata.character_version,
        });
        return {
          content: runRegex(
            chardata,
            result,
            (e) =>
              e.placement.includes(regex_placement.AI_OUTPUT) &&
              !e.markdownOnly &&
              !e.promptOnly,
          ),
          content_for_show: runRegex(
            chardata,
            result,
            (e) =>
              e.placement.includes(regex_placement.AI_OUTPUT) && !e.promptOnly,
          ),
        };
      },
      /**
       * 获取提示
       * @returns {import('../../../../../src/decl/prompt_struct.ts').single_part_prompt_t} 构建好的提示结构部分。
       * @param {any} args 参数
       */
      GetPrompt: (args) => {
        return promptBuilder(args, chardata, AIsource?.filename);
      },
      // no GetPromptForOther, ST card does not support it
      /**
       * 获取回复
       * @returns {Promise<import("../../../../../src/public/parts/shells/chat/decl/chatLog.ts").chatReply_t>} 一个解析为包含回复内容、文件和扩展信息的对象的 Promise。
       * @param {chatReplyRequest_t} args 参数
       */
      GetReply: async (args) => {
        if (!AIsource)
          return {
            content:
              "该角色尚未配置 AI 服务源，请前往 [beilu 首页](/parts/shells:beilu-chat/) 的「系统设置 → AI 服务源」进行配置。",
          };
        // 注入角色插件
        args.plugins = Object.assign({}, plugins, args.plugins);
        // N10 半修补齐：同 char-template:244——buildPromptStruct 前补 args.username，否则 beilu-files 等按 args?.username||"_default" 回退，具名账号拿不到自己的 allowedPaths/autoApprove。
        args.username = username;
        // 用 beilu 提供的工具构建提示词结构
        const prompt_struct = await buildPromptStruct(args);
        // 创建回复容器
        /** @type {import("../../../../../src/public/parts/shells/chat/decl/chatLog.ts").chatReply_t} */
        const result = {
          content: "",
          logContextBefore: [],
          logContextAfter: [],
          files: [],
          extension: {},
        };
        // 构建插件可能需要的追加上下文函数
        /**
         * 添加长时间日志
         * @param {import("../../../../../src/public/parts/shells/chat/decl/chatLog.ts").chatEntry_t} entry 条目
         */
        function AddLongTimeLog(entry) {
          entry.charVisibility = [args.char_id];
          result?.logContextBefore?.push?.(entry);
          prompt_struct.char_prompt.additional_chat_log.push(entry);
        }

        // 构建更新预览管线
        args.generation_options ??= {};
        const oriReplyPreviewUpdater =
          args.generation_options?.replyPreviewUpdater;
        /**
         * 聊天回复预览更新管道。
         * @type {import('../../../../../src/public/parts/shells/chat/decl/chatLog.ts').CharReplyPreviewUpdater_t}
         */
        let replyPreviewUpdater = (args, r) =>
          oriReplyPreviewUpdater?.({
            ...r,
            content: runRegex(
              chardata,
              r.content,
              (e) =>
                e.placement.includes(regex_placement.AI_OUTPUT) &&
                !e.promptOnly,
            ),
          });
        for (const GetReplyPreviewUpdater of [
          ...Object.values(args.plugins).map(
            (plugin) => plugin.interfaces?.chat?.GetReplyPreviewUpdater,
          ),
        ].filter(Boolean))
          replyPreviewUpdater = GetReplyPreviewUpdater(replyPreviewUpdater);

        /**
         * 更新回复预览。
         * @param {import('../../../../../src/public/parts/shells/chat/decl/chatLog.ts').chatLogEntry_t} r - 来自 AI 的回复块。
         * @returns {void}
         */
        args.generation_options.replyPreviewUpdater = (r) =>
          replyPreviewUpdater(args, r);

        // 在重新生成循环中检查插件触发（无次数上限，由 ReplyHandler 语义控制终止）
        regen: while (true) {
          args.generation_options.base_result = result;
          await AIsource.StructCall(prompt_struct, args.generation_options);
          let continue_regen = false;
          for (const replyHandler of [
            ...Object.values(args.plugins).map(
              (plugin) => plugin.interfaces?.chat?.ReplyHandler,
            ),
          ].filter(Boolean))
            if (
              await replyHandler(result, {
                ...args,
                prompt_struct,
                AddLongTimeLog,
              })
            )
              continue_regen = true;
          if (continue_regen) {
            continue regen;
          }
          break;
        }

        // ★ Phase 5: content_for_show 统一
        // 如果插件（如 beilu-memory）已设置 content_for_show（清除了内部标签），
        // 则在此基础上应用 regex，避免从原始 content 重新生成而覆盖插件的清理结果
        const showBase = result.content_for_show || result.content;
        return {
          content: runRegex(
            chardata,
            result.content,
            (e) =>
              e.placement.includes(regex_placement.AI_OUTPUT) &&
              !e.markdownOnly &&
              !e.promptOnly,
          ),
          content_for_show: runRegex(
            chardata,
            showBase,
            (e) =>
              e.placement.includes(regex_placement.AI_OUTPUT) && !e.promptOnly,
          ),
          files: result.files,
        };
      },
      /**
       * 获取回复频率
       * @returns {Promise<number>} 一个解析为回复频率（数字）的 Promise。
       * @param {any} args 参数
       */
      GetReplyFrequency: async (args) => {
        if (chardata.extensions.talkativeness)
          return Number(chardata.extensions.talkativeness) * 2;
        return 1;
      },
      /**
       * 消息编辑
       * @returns {any} 一个包含编辑后消息内容的对象。
       * @param {any} args 参数
       */
      MessageEdit: (args) => {
        return {
          ...args.edited,
          content: runRegex(
            chardata,
            args.edited.content,
            (e) =>
              e.placement.includes(regex_placement.AI_OUTPUT) &&
              !e.markdownOnly &&
              !e.promptOnly &&
              (e.runOnEdit ?? true),
          ),
          content_for_show: runRegex(
            chardata,
            args.edited.content,
            (e) =>
              e.placement.includes(regex_placement.AI_OUTPUT) &&
              !e.promptOnly &&
              (e.runOnEdit ?? true),
          ),
        };
      },
    },
  },
};
