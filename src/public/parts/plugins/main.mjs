import fs from "node:fs";
import path from "node:path";

import {
  loadPartBase,
  setDefaultPart,
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
    // beilu: 扫描所有子插件目录，自动注册为默认插件
    // 解决"先有鸡还是先有蛋"问题：插件需要先注册才能被 getAllDefaultParts 发现
    try {
      const entries = fs.readdirSync(pluginDir);
      const registered = [];
      for (const entry of entries) {
        if (fs.existsSync(path.join(pluginDir, entry, "main.mjs"))) {
          setDefaultPart(username, "plugins", entry);
          registered.push(entry);
        }
      }
      if (registered.length) {
        console.log(
          `[plugins] 已自动注册 ${registered.length} 个默认插件: ${registered.join(", ")}`,
        );
      }
    } catch (e) {
      console.warn("[plugins] 扫描子插件目录失败:", e.message);
    }
  },
  /**
   *
   */
  Load: async () => {},
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
        // beilu: 自动注册为默认插件，确保 getAllDefaultParts 能发现它
        // setDefaultPart 内部有去重，不会重复注册
        setDefaultPart(username, "plugins", partname);
        return loadPartBase(username, "plugins/" + partname);
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
