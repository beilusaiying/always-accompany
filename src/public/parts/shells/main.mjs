import fs from 'node:fs'
import path from 'node:path'

import { loadPartBase } from '../../../server/parts_loader.mjs'

import info from './info.json' with { type: 'json' }

/**
 * shells 容器部件：把 shells/ 目录下的各子 shell 作为子部件统一枚举/加载/卸载。
 */
export default {
	info,
	/**
	 * 加载容器部件（无副作用，子 shell 按需通过 loadSubPart 加载）。
	 * @returns {Promise<void>}
	 */
	Load: async () => { },
	/**
	 * 卸载容器部件（无副作用）。
	 * @returns {Promise<void>}
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
				return loadPartBase(username, 'shells/' + partname)
			},
			/**
			 * 卸载子部件。
			 * @param {string[]} my_paths - 搜索路径列表。
			 * @param {string} username - 用户名。
			 * @param {string} partname - 部件名称。
			 * @returns {Promise<void>}
			 */
			unloadSubPart: async (my_paths, username, partname) => {
				// 动态 import unloadPartBase（仅卸载时才需要，避免顶层多引一个仅此处用到的符号）
				const { unloadPartBase } = await import('../../../server/parts_loader.mjs')
				return unloadPartBase(username, 'shells/' + partname)
			}
		}
	}
}
