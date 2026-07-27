import info from './info.json' with { type: 'json' }
import { runBot, pauseBot } from './src/bot.mjs'
import { setEndpoints } from './src/endpoints.mjs'
import { createBotShellMain } from '../../../../scripts/botContentShared.mjs'

// [0716 P1 件6] 入口骨架收口 createBotShellMain（botContentShared）——原 9 壳逐字同构实现纯删
//（md5 实证：归一平台名+剥注释后唯一差异=import 行序/分号风格）。壳侧只余平台名与
// loadActions 懒加载闭包（actions.mjs 是壳相对路径，且保留原 handleAction 动态 import 语义）。
export default createBotShellMain('telegram', {
	info, runBot, pauseBot, setEndpoints,
	loadActions: () => import('./src/actions.mjs'),
})
