import fs from 'node:fs'
import path from 'node:path'

import { loadPartBase } from '../../server/parts_loader.mjs'

import info from './info.json' with { type: 'json' }

/** @typedef {import('../../decl/basedefs.ts').info_t} info_t */

/**
 * 已加载子部件的跟踪表（username -> partpath -> 实例）。
 * 注意：当前实现中本表从未被写入，仅在 Unload 中遍历，因此实际为空。
 * @type {Record<string, Record<string, any>>}
 */
const subparts = {}

/**
 * 全局根部件
 */
export default {
	/**
	 * 部件信息。
	 * @type {info_t}
	 */
	info,
	/**
	 * 加载部件。
	 * @param {object} options - 选项。
	 * @param {object} options.router - 路由。
	 */
	Load: async ({ router }) => { },
	/**
	 * 卸载部件。
	 */
	Unload: async () => {
		// subparts 从未被 loadSubPart 写入（loadSubPart 直接返回 loadPartBase 结果而不登记），
		// 故此遍历当前为空操作；子部件的卸载由 parts_loader 统一管理。
		// TODO(待凛倾确认): 若需在根部件主动卸载子部件，需登记 subparts 并补 unloadPartBase 调用。
		for (const username in subparts)
			for (const partpath in subparts[username]) {
				// 占位：循环体内暂无卸载逻辑（见上方 TODO）。
			}

	},
	/**
	 * 接口。
	 */
	interfaces: {
		parts: {
			/**
			 * 获取子部件列表。
			 * @param {string[]} my_paths - 当前部件的多个路径。
			 * @returns {Set<string>} 子部件列表。
			 */
			getSubPartsList: (my_paths) => {
				return [...new Set(my_paths.map(p => {
					if (fs.existsSync(p))
						return fs.readdirSync(p).filter(part =>
							fs.existsSync(path.join(p, part, 'main.mjs'))
						)

					return []
				}).flat())]
			},
			/**
			 * 获取子部件的安装文件夹路径。
			 * @param {string[]} my_paths - 当前部件的多个路径。
			 * @returns {string[]} 子部件的多个可选安装路径。
			 */
			getSubPartsInstallPaths: (my_paths) => {
				return my_paths
			},
			/**
			 * 加载子部件。
			 * @param {string[]} my_paths - 当前部件的多个路径。
			 * @param {string} username - 用户的用户名。
			 * @param {string} partname - 部件的名称。
			 * @returns {Promise<any>} 加载的部件实例。
			 */
			loadSubPart: (my_paths, username, partname) => {
				// partname passed here from parts_loader is just the name of the child.
				// Since this is root part, the path is just the name.
				return loadPartBase(username, partname)
			}
		}
	}
}
