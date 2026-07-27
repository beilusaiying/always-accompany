import fs from 'node:fs'
import path from 'node:path'

import { loadPartBase } from '../../../server/parts_loader.mjs'

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
			 * @param {string[]} my_paths - 当前部件的多个路径。
			 * @returns {string[]} 去重后的子部件名称列表（由 Set 展开为数组返回）。
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
				// serviceSources 是 parts/serviceSources/ 下的部件（非 root part）——子部件全路径需带 "serviceSources/" 前缀。
				// 原裸 partname 让 loadPartBase 解析成 parts/<partname>/main.mjs（如 AI→parts/AI 不存在）→ 抛错被
				// parts_loader.mjs:365 catch 成 "Parent part load failed: serviceSources" boot 噪声 + :367 全路径兜底重算。
				// 仿 sibling serviceSources/AI/main.mjs:167（"serviceSources/AI/"+partname）拼全路径，消噪声+省冗余递归。
				return loadPartBase(username, "serviceSources/" + partname)
			}
		}
	}
}
