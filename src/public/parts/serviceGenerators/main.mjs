import fs from 'node:fs'
import path from 'node:path'

import { loadPartBase, unloadPartBase } from '../../../server/parts_loader.mjs'

import info from './info.json' with { type: 'json' }

/**
 *
 */
export default {
	info,
	/**
	 *
	 */
	Load: async () => { },
	/**
	 *
	 */
	Unload: async () => { },
	interfaces: {
		parts: {
			/**
			 * 获取子部件列表。
			 * @param {string[]} my_paths - 搜索路径列表。
			 * @returns {string[]} 子部件名称列表。
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
			 * 获取子部件安装路径。
			 * @param {string[]} my_paths - 搜索路径列表。
			 * @returns {string[]} 子部件安装路径列表。
			 */
			getSubPartsInstallPaths: (my_paths) => my_paths,
			/**
			 * 加载子部件。
			 * @param {string[]} my_paths - 搜索路径列表。
			 * @param {string} username - 用户名。
			 * @param {string} partname - 部件名称。
			 * @returns {Promise<any>} 加载的部件实例。
			 */
			loadSubPart: (my_paths, username, partname) => {
				// 根节点子部件是 AI/search/translate 三个 cluster，全路径 = serviceGenerators/<partname>。
				// 与 unloadSubPart 及 sibling 父节点（AI/translate/search main.mjs）一致；插 translate/ 会把
				// AI、search 也拼成 serviceGenerators/translate/AI 等不存在路径，加载失败后靠 parts_loader 兜底重算掩盖。
				return loadPartBase(username, 'serviceGenerators/' + partname)
			},
			/**
			 * 卸载子部件。
			 * @param {string[]} my_paths - 搜索路径列表。
			 * @param {string} username - 用户名。
			 * @param {string} partname - 部件名称。
			 * @returns {Promise<void>}
			 */
			unloadSubPart: async (my_paths, username, partname) => {
				return unloadPartBase(username, 'serviceGenerators/' + partname)
			}
		}
	}
}
