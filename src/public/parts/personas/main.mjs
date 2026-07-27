import fs from 'node:fs'
import path from 'node:path'

import { loadPartBase, unloadPartBase } from '../../../server/parts_loader.mjs'

import info from './info.json' with { type: 'json' }

/**
 * personas 容器部件：将 personas/ 目录下的每个子目录暴露为子部件。
 */
export default {
	info,
	/**
	 * 加载部件（容器本身无需初始化）。
	 */
	Load: async () => { },
	/**
	 * 卸载部件（容器本身无需清理）。
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
				return loadPartBase(username, 'personas/' + partname)
			},
			/**
			 * 卸载子部件。
			 * @param {string[]} my_paths - 搜索路径列表。
			 * @param {string} username - 用户名。
			 * @param {string} partname - 部件名称。
			 * @returns {Promise<void>}
			 */
			unloadSubPart: async (my_paths, username, partname) => {
				return unloadPartBase(username, 'personas/' + partname)
			}
		}
	}
}
