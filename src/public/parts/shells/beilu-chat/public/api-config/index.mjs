/**
 * 独立 API 配置页面入口
 *
 * 复用 beilu-chat 的 apiConfig.mjs 模块，
 * 作为 Home Shell 首页"管理服务源"按钮的目标页面。
 */
import { applyTheme } from '../../../scripts/theme.mjs'

import { initApiConfig, loadApiConfig } from '../src/apiConfig.mjs'

applyTheme()
initApiConfig()
loadApiConfig()