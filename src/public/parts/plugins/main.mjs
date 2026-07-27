import fs from "node:fs";
import path from "node:path";

import {
  loadPartBase,
  setDefaultPart,
  setDefaultPartBatch,
  unsetDefaultPart,
  getAllDefaultParts,
  unloadPartBase,
} from "../../../server/parts_loader.mjs";

import info from "./info.json" with { type: "json" };

const pluginDir = import.meta.dirname;

/**
 *
 */
export default {
  info,
  /**
   * 加载 plugins 容器时，自动扫描并注册所有内置插件为默认插件。
   * @param {object} root0 - 参数对象。
   * @param {string} root0.username - 用户名。
   */
  Load: async ({ username }) => {
    if (!username) return;
    try {
      const entries = fs.readdirSync(pluginDir);
      const validPlugins = new Set();
      const toRegister = [];
      for (const entry of entries) {
        if (fs.existsSync(path.join(pluginDir, entry, "main.mjs"))) {
          validPlugins.add(entry);
          toRegister.push(entry);
        }
      }
      const registered = setDefaultPartBatch(username, "plugins", toRegister);
      // 清理不存在的脏条目（目录已删但 defaultParts 残留）
      const currentList = getAllDefaultParts(username, "plugins");
      for (const name of currentList) {
        if (!validPlugins.has(name)) {
          unsetDefaultPart(username, "plugins", name);
          console.warn(`[plugins] 清理脏条目: plugins/${name}（目录不存在）`);
        }
      }
      if (registered.length) {
        console.log(
          `[plugins] 已自动注册 ${registered.length} 个默认插件: ${toRegister.join(", ")}`,
        );
      }
    } catch (e) {
      console.warn("[plugins] 扫描子插件目录失败:", e.message);
    }
  },
  /**
   *
   */
  Unload: async () => {},
  interfaces: {
    parts: {
      /**
       * 获取子部件列表。
       * @param {string[]} my_paths - 搜索路径列表。
       * @returns {string[]} 子部件名称列表。
       */
      getSubPartsList: (my_paths) => {
        return [
          ...new Set(
            my_paths
              .map((p) => {
                if (fs.existsSync(p))
                  return fs
                    .readdirSync(p)
                    .filter((part) =>
                      fs.existsSync(path.join(p, part, "main.mjs")),
                    );

                return [];
              })
              .flat(),
          ),
        ];
      },
      /**
       * 获取子部件安装路径。
       * @param {string[]} my_paths - 搜索路径列表。
       * @returns {string[]} 子部件安装路径列表。
       */
      getSubPartsInstallPaths: (my_paths) => my_paths,
      /**
       * 加载子部件（加载时自动注册为默认插件）。
       * @param {string[]} my_paths - 搜索路径列表。
       * @param {string} username - 用户名。
       * @param {string} partname - 部件名称。
       * @returns {Promise<any>} 加载的部件实例。
       */
      loadSubPart: (my_paths, username, partname) => {
        // beilu: 自动注册为默认插件，确保 getAllDefaultParts 能发现它（setDefaultPart 内部去重）。
        // 2026-07-16 死链自续环根修：原「先注册后加载」——加载失败（部件已删，如聊天档 timeSlice
        //   plugins 快照里的已删插件）时脏名已写回 defaultParts，启动自愈（stale_entry_removed）
        //   删掉后一开旧对话又被加回=永久复活。改为加载成功后才注册；失败拒绝原样上抛。
        return Promise.resolve(loadPartBase(username, "plugins/" + partname)).then((part) => {
          setDefaultPart(username, "plugins", partname);
          return part;
        });
      },
      /**
       * 卸载子部件。
       * @param {string[]} my_paths - 搜索路径列表。
       * @param {string} username - 用户名。
       * @param {string} partname - 部件名称。
       * @returns {Promise<void>}
       */
      unloadSubPart: async (my_paths, username, partname) => {
        return unloadPartBase(username, "plugins/" + partname);
      },
    },
  },
};
