/**
 * [beilu-st-host · st-mirror shim] scripts/slash-commands.js —— 酒馆斜杠命令系统落点（P2，二期）。
 *
 * 【依赖此文件的插件与符号（证据：ST-P4 §2.3）】
 *   SlashCommandParser 等 → Timelines / memory-enhancement（注册 /命令）。
 *
 * 【一期策略】P2：slash 注册表属二期主体（转换表§五）。一期一律抛错 stub（红线2 可见），不阻断插件加载
 *   —— 多数插件在「注册命令」这一步抛错会被 host-loader 的 hook/注入错误捕获进面板，其余功能仍可加载。
 */

function _stub(name) {
	return function stubbed() {
		throw new Error(`[beilu宿主] slash-commands 的 ${name} 尚未实现（一期 P2 stub）。斜杠命令注册表属二期。`)
	}
}

/** SlashCommandParser（P2 stub，构造/静态调用即抛）。 */
export class SlashCommandParser {
	constructor() { throw new Error('[beilu宿主] SlashCommandParser 尚未实现（一期 P2 stub）。斜杠命令属二期。') }
	static addCommandObject() { throw new Error('[beilu宿主] SlashCommandParser.addCommandObject 尚未实现（一期 P2 stub）。') }
}

/** 命令定义类（P2 stub）。 */
export class SlashCommand {
	static fromProps() { throw new Error('[beilu宿主] SlashCommand.fromProps 尚未实现（一期 P2 stub）。斜杠命令属二期。') }
}

/** 命令参数定义类（P2 stub）。 */
export class SlashCommandArgument {
	static fromProps() { throw new Error('[beilu宿主] SlashCommandArgument 尚未实现（一期 P2 stub）。') }
}
export class SlashCommandNamedArgument {
	static fromProps() { throw new Error('[beilu宿主] SlashCommandNamedArgument 尚未实现（一期 P2 stub）。') }
}

export const executeSlashCommands = _stub('executeSlashCommands')
export const executeSlashCommandsWithOptions = _stub('executeSlashCommandsWithOptions')
