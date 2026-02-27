/**
 * EJS 模板引擎 Polyfill 代码生成器（Phase 2C）
 *
 * 生成注入到 iframe 内的 window.EjsTemplate 对象代码。
 * 依赖 CDN 加载的 ejs 库（在 buildInjectionScript 中按需注入）。
 *
 * EjsTemplate API 参考酒馆助手类型定义：
 *   - evalTemplate(code, context, options) → 执行 EJS 模板
 *   - prepareContext(additional, lastMessageId) → 准备模板上下文
 *   - getSyntaxErrorInfo(code, lineCount) → 检查语法错误
 *   - allVariables(endMessageId) → 获取所有变量
 *   - getFeatures() / setFeatures(f) / resetFeatures() → 特性管理
 *
 * 使用方式（在 index.mjs buildInjectionScript 中调用）：
 *   import { generateEjsEngineScript } from './ejsEngine.mjs'
 *   parts.push(generateEjsEngineScript())
 */

/**
 * 生成 EJS 模板引擎 polyfill 代码
 * 注入到 iframe 内，提供 window.EjsTemplate 对象
 *
 * @returns {string} JavaScript 代码字符串（不含 <script> 标签）
 */
export function generateEjsEngineScript() {
	return `
/* === ST Compat: EJS Template Engine Polyfill === */
(function() {
    // 默认特性设置（参考 exported.ejstemplate.d.ts Features 类型）
    var _defaultFeatures = {
        enabled: true,
        generate_enabled: true,
        generate_loader_enabled: true,
        inject_loader_enabled: true,
        render_enabled: true,
        render_loader_enabled: true,
        code_blocks_enabled: true,
        raw_message_evaluation_enabled: true,
        filter_message_enabled: true,
        depth_limit: -1,
        autosave_enabled: true,
        preload_worldinfo_enabled: false,
        with_context_disabled: false,
        debug_enabled: false,
        invert_enabled: false,
        compile_workers: false,
        sandbox: false,
        cache_enabled: 0,
        cache_size: 100,
        cache_hasher: 'h32ToString'
    };

    var _features = JSON.parse(JSON.stringify(_defaultFeatures));

    window.EjsTemplate = {
        /**
         * 执行 EJS 模板
         * @param {string} code - EJS 模板代码
         * @param {object} [context] - 变量上下文（不传则自动准备）
         * @param {object} [options] - ejs.render 选项
         * @returns {Promise<string>} 渲染结果
         */
        evalTemplate: async function(code, context, options) {
            if (!_features.enabled) return code;
            if (typeof ejs === 'undefined') {
                console.warn('[EjsTemplate] ejs 库未加载，返回原始内容');
                return code;
            }
            try {
                var ctx = context || await this.prepareContext();
                var result = ejs.render(code, ctx, options || {});
                if (_features.debug_enabled) {
                    console.log('[EjsTemplate] 模板执行:', code.length, '字符 →', result.length, '字符');
                }
                return result;
            } catch(e) {
                console.error('[EjsTemplate] 模板执行失败:', e.message);
                if (_features.debug_enabled) {
                    console.error('[EjsTemplate] 模板内容:', code.substring(0, 200));
                }
                return code;
            }
        },

        /**
         * 准备模板执行上下文
         * 合并变量系统数据 + SillyTavern 上下文 + 附加数据
         * @param {object} [additional] - 附加上下文
         * @param {number} [lastMessageId] - 最后消息 ID
         * @returns {Promise<object>} 上下文对象
         */
        prepareContext: async function(additional, lastMessageId) {
            var ctx = {};

            // 合并变量系统数据
            if (typeof getAllVariables === 'function') {
                try { Object.assign(ctx, getAllVariables()); } catch(e) {}
            }

            // SillyTavern 基础上下文
            var st = window.SillyTavern || {};
            ctx.user = st.name1 || 'User';
            ctx.char = st.name2 || 'Character';
            ctx.chat = st.chat || [];
            ctx._ = window._ || {};

            // 消息相关
            if (typeof lastMessageId === 'number' && lastMessageId >= 0 && ctx.chat.length > 0) {
                ctx.lastMessage = ctx.chat[Math.min(lastMessageId, ctx.chat.length - 1)] || {};
            } else if (ctx.chat.length > 0) {
                ctx.lastMessage = ctx.chat[ctx.chat.length - 1] || {};
            } else {
                ctx.lastMessage = {};
            }

            ctx.messageCount = ctx.chat.length;

            // 附加上下文
            if (additional) Object.assign(ctx, additional);

            return ctx;
        },

        /**
         * 检查 EJS 模板语法错误
         * @param {string} code - EJS 模板代码
         * @param {number} [lineCount] - 行数限制
         * @returns {Promise<string>} 错误信息（空字符串表示无错误）
         */
        getSyntaxErrorInfo: async function(code, lineCount) {
            if (typeof ejs === 'undefined') return 'ejs 库未加载';
            try {
                ejs.compile(code);
                return '';
            } catch(e) {
                return e.message || '语法错误';
            }
        },

        /**
         * 获取所有变量（截至指定消息 ID）
         * @param {number} [endMessageId] - 结束消息 ID
         * @returns {object} 变量对象
         */
        allVariables: function(endMessageId) {
            if (typeof getAllVariables === 'function') {
                try { return getAllVariables(); } catch(e) {}
            }
            return {};
        },

        /**
         * 获取当前特性设置
         * @returns {object} 特性设置副本
         */
        getFeatures: function() {
            return JSON.parse(JSON.stringify(_features));
        },

        /**
         * 设置特性（部分更新）
         * @param {object} f - 要更新的特性
         */
        setFeatures: function(f) {
            if (f && typeof f === 'object') {
                Object.assign(_features, f);
            }
        },

        /**
         * 重置特性为默认值
         */
        resetFeatures: function() {
            _features = JSON.parse(JSON.stringify(_defaultFeatures));
        }
    };

    console.log('[ST Compat] EjsTemplate polyfill 已注入');
})();
`
}