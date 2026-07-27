import * as botModule from './bot.mjs'
import { createBotActions } from '../../../../../scripts/botContentShared.mjs'

// [0716 P1 件7] 动作字典收口 createBotActions（botContentShared）——原 9 壳同构实现纯删
//（8 动作 md5 diff 实证同构；差异仅折行/文案/wecom 同步版，统一 async 形状等价）。
export const actions = createBotActions(botModule)
