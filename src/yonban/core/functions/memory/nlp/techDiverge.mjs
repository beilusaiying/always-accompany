// techDiverge.mjs — 技术词发散模块（code/work 模式专用，SWOW 对技术无效故独立）
//
// 功能链：p1_node2_swow / p1_transfer → techDiverge(word, mode) → [{word, strength}]（技术词发散候选）
// why：SWOW 是日常联想网络，"挂"→"孤独"而非"崩溃"；code/work 模式需专属技术词层
//      （coding_terms + IDE 诊断路径 + StackOverflow 共现），让 P1 在技术场景正常发散。
// 关联链：
//   ← p1_node2_swow.mjs（mode=code/work 时 fallback 到 techDiverge）
//   ← p1_transfer.mjs（技术词补散词池）
//   → ide_diagnostic_paths.json（lib/，IDE 诊断路径框架，缺失返回空）
//   → P1资源库/coding_terms.txt
// 影响范围：只读 ide_diagnostic_paths.json + P1资源库（进程级懒加载；资源缺失静默降级）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getResDir } from "../p1/p1_resdir.mjs";  // P1 单一资源根
const RES_DIR = getResDir();

// IDE诊断路径框架(Gemini标注): 问题类别→排查步骤+激活术语+常见原因+避免建议
let _diagnosticPaths = null;
function _getDiagnosticPaths() {
  if (_diagnosticPaths) return _diagnosticPaths;
  try {
    const p = path.join(__dirname, "..", "ide_diagnostic_paths.json");
    if (fs.existsSync(p)) {
      _diagnosticPaths = JSON.parse(fs.readFileSync(p, "utf-8"));
      return _diagnosticPaths;
    }
  } catch {}
  _diagnosticPaths = {};
  return _diagnosticPaths;
}

// 诊断路径匹配: 从用户输入词找到最匹配的诊断类别
// 短词→诊断类别映射: 单字技术口语直接指向一个"诊断类别"(下方 value), 不是字面义
// (注: 字面义"看"=检查/"跑"=运行/"挂"=崩溃/"卡"=阻塞 只是直觉来源; 实际 value 是映射到的诊断类别, 二者层级不同)
const SHORT_WORD_TECH_MAP = {
  "看": "代码重构",
  "查": "性能瓶颈定位",
  "跑": "异步不生效",
  "挂": "部署内存泄漏",
  "卡": "性能瓶颈定位",
  "慢": "页面加载慢",
  "崩": "部署内存泄漏",
  "报错": "错误边界处理",
  "出错": "错误边界处理",
  "不行": "变量未定义",
  "不对": "接口不一致",
  "不了": "异步不生效",
  "冲突": "Git冲突",
  "断了": "WebSocket断连",
};

export function getDiagnosticPath(word) {
  const paths = _getDiagnosticPaths();
  if (!paths || Object.keys(paths).length === 0) return null;
  if (!word) return null;
  // 短词先查语义映射(中文单字多义: "看"=检查, "挂"=崩溃)
  if (word.length <= 2) {
    const mapped = SHORT_WORD_TECH_MAP[word];
    if (mapped && paths[mapped]) return { category: mapped, ...paths[mapped] };
    return null;
  }
  // 精确匹配
  if (paths[word]) return { category: word, ...paths[word] };
  // 子串匹配(word至少3字且包含类别名，或类别名包含word且word至少占类别名50%)
  for (const [cat, info] of Object.entries(paths)) {
    if (word.includes(cat)) return { category: cat, ...info };
    if (cat.includes(word) && word.length >= Math.ceil(cat.length * 0.5)) return { category: cat, ...info };
  }
  // 激活术语匹配(术语至少3字)
  for (const [cat, info] of Object.entries(paths)) {
    if (info.activation_terms?.some(t => t.length >= 3 && (word.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(word.toLowerCase())))) {
      return { category: cat, ...info };
    }
  }
  return null;
}

// IDE模式: 错误模式→调试假说(Peirce溯因)
const ERROR_HYPOTHESES = {
  "undefined": ["变量未声明", "作用域错误", "异步时序", "拼写错误", "import缺失"],
  "null": ["空指针", "初始化遗漏", "条件分支未覆盖", "API返回空", "类型断言"],
  "报错": ["语法错误", "类型不匹配", "依赖缺失", "版本冲突", "环境差异"],
  "错误": ["逻辑错误", "边界条件", "竞态条件", "资源泄漏", "权限不足"],
  "接口": ["契约变更", "版本兼容", "超时", "幂等性", "认证失效"],
  "性能": ["瓶颈定位", "缓存命中率", "N+1查询", "内存泄漏", "并发度"],
  "崩溃": ["死锁", "栈溢出", "OOM", "未捕获异常", "信号量"],
  "卡顿": ["主线程阻塞", "GC压力", "IO瓶颈", "渲染阻塞", "事件循环"],
  "500": ["服务端异常", "数据库连接", "中间件错误", "配置错误", "依赖服务"],
  "404": ["路由未注册", "路径拼写", "部署遗漏", "重定向配置"],
  "超时": ["网络延迟", "数据库慢查询", "死循环", "资源竞争", "连接池耗尽"],
  "乱码": ["编码不一致", "UTF-8 BOM", "Content-Type缺失", "转义错误"],
  "重构": ["接口隔离", "依赖倒置", "单一职责", "策略模式", "事件驱动"],
  "耦合": ["依赖注入", "接口抽象", "事件总线", "微服务拆分", "模块边界"],
  "测试": ["单元测试", "集成测试", "mock隔离", "覆盖率", "回归测试"],
  "部署": ["CI/CD", "灰度发布", "回滚策略", "环境变量", "容器化"],
  "并发": ["锁粒度", "原子操作", "乐观锁", "消息队列", "Actor模型"],
  "内存": ["引用计数", "循环引用", "WeakRef", "大对象堆", "分代GC"],
  "类型": ["类型守卫", "泛型约束", "联合类型", "类型断言", "interface"],
  "异步": ["Promise链", "async/await", "回调地狱", "取消机制", "并发控制"],
  "函数": ["纯函数", "副作用", "闭包", "柯里化", "参数校验"],
  "数据库": ["索引优化", "事务隔离", "连接池", "分库分表", "读写分离"],
  "安全": ["XSS", "CSRF", "SQL注入", "输入校验", "权限控制"],
  "变量": ["作用域", "声明提升", "let/var/const", "闭包捕获", "命名规范"],
  "页面": ["首屏时间", "懒加载", "代码分割", "CDN缓存", "关键渲染路径"],
  "加载": ["预加载", "按需加载", "骨架屏", "资源压缩", "HTTP缓存"],
  "git": ["分支策略", "rebase", "cherry-pick", "merge冲突", "gitflow"],
  "冲突": ["三方合并", "冲突标记", "手动解决", "保留策略", "diff对比"],
  "正则": ["贪婪匹配", "捕获组", "零宽断言", "回溯爆炸", "字符类"],
  "设计": ["设计模式", "开闭原则", "依赖注入", "接口隔离", "组合优于继承"],
  "插件": ["钩子机制", "生命周期", "API暴露", "隔离沙箱", "版本管理"],
  "组件": ["单向数据流", "状态提升", "slot插槽", "生命周期", "虚拟DOM"],
  "样式": ["BEM命名", "CSS模块", "主题变量", "响应式", "暗色模式"],
  "路由": ["动态路由", "路由守卫", "懒加载", "嵌套路由", "状态持久化"],
  "状态": ["全局状态", "局部状态", "持久化", "状态机", "订阅发布"],
  "API": ["RESTful", "GraphQL", "版本控制", "限流", "文档生成"],
  "日志": ["结构化日志", "日志级别", "链路追踪", "采样率", "告警规则"],
  "监控": ["指标采集", "仪表盘", "告警阈值", "SLO/SLA", "故障演练"],
  "缓存": ["缓存策略", "失效机制", "穿透/雪崩", "热点Key", "多级缓存"],
  "网络": ["DNS解析", "TCP握手", "HTTP2", "WebSocket", "CDN"],
  "配置": ["环境隔离", "配置中心", "热更新", "灰度", "回滚"],
  "权限": ["RBAC", "JWT", "OAuth", "权限粒度", "最小权限"],
  "迁移": ["数据迁移", "平滑升级", "兼容层", "双写", "灰度切换"],
  "React": ["组件生命周期", "虚拟DOM对比", "Hooks依赖数组", "Suspense边界", "Server Components"],
  "Vue": ["响应式代理", "组合式API", "模板编译优化", "Pinia状态管理", "Teleport传送门"],
  "Angular": ["依赖注入容器", "Zone.js变更检测", "RxJS响应式流", "模块懒加载", "指令装饰器"],
  "Hooks": ["闭包陷阱规避", "自定义Hook封装", "useCallback记忆化", "useRef可变容器", "useReducer"],
  "CSS": ["Flexbox主轴对齐", "Grid轨道定义", "BFC块格式化", "层叠上下文", "包含块计算"],
  "动画": ["CSS过渡插值", "requestAnimationFrame", "FLIP动画", "合成层提升", "Web Animations"],
  "SSR": ["服务端渲染水合", "流式渲染分块", "边缘计算", "缓存失效策略", "SEO元数据注入"],
  "PWA": ["Service Worker缓存", "Web App Manifest", "离线优先设计", "后台同步", "推送通知"],
  "Webpack": ["Loader转换链", "Plugin生命周期", "Chunk分割策略", "模块联邦", "持久化缓存"],
  "Vite": ["ESM原生开发", "Rollup生产打包", "预构建依赖", "插件钩子", "环境变量注入"],
  "TypeScript": ["类型体操工具", "泛型约束推断", "声明合并", "严格空值检查", "类型守卫收窄"],
  "可访问性": ["ARIA语义角色", "键盘焦点顺序", "色彩对比度WCAG", "屏幕阅读器", "跳过导航"],
  "微前端": ["模块联邦共享", "沙箱隔离", "路由分发", "跨应用通信", "独立部署"],
  "GraphQL": ["Schema定义", "解析器链", "N+1问题", "DataLoader批处理", "订阅推送"],
  "gRPC": ["Protobuf序列化", "双向流通信", "拦截器中间件", "服务反射", "负载均衡"],
  "WebSocket": ["握手升级", "心跳保活", "消息帧分片", "断线重连退避", "房间广播"],
  "认证": ["JWT签名验证", "OAuth2授权码流", "PKCE挑战", "令牌刷新轮换", "会话固定防范"],
  "授权": ["RBAC角色权限", "ABAC属性权限", "权限继承传播", "资源级控制", "权限缓存失效"],
  "ORM": ["实体关系映射", "懒加载关联", "迁移版本管理", "查询构建器", "事务管理"],
  "消息队列": ["消费者组均衡", "死信队列", "消息幂等去重", "消费偏移", "背压控制"],
  "Serverless": ["冷启动优化", "函数超时控制", "事件触发绑定", "无状态约束", "并发限制"],
  "限流": ["令牌桶算法", "滑动窗口", "分布式限流", "客户端退避", "优先级降级"],
  "健康检查": ["存活探针", "就绪探针", "启动探针", "依赖链路检查", "检查端点安全"],
  "负载均衡": ["轮询加权", "最少连接", "一致性哈希", "会话粘性", "健康摘除"],
  "Docker": ["镜像分层缓存", "多阶段构建", "容器编排", "资源Cgroup限制", "健康检查指令"],
  "Kubernetes": ["Pod调度亲和", "资源请求限制", "滚动更新", "ConfigMap注入", "HPA自动扩缩"],
  "灾难恢复": ["RTO恢复时间", "RPO恢复点", "备份验证", "多地域热备", "故障切换"],
  "SOLID": ["单一职责边界", "开闭扩展封闭", "里氏替换契约", "接口隔离最小", "依赖倒置"],
  "技术债": ["债务利息复利", "偿还优先级", "债务可视化", "预防性架构", "偿债窗口"],
  "TDD": ["红绿重构循环", "最小实现", "测试即文档", "设计驱动", "测试先行"],
  "混沌工程": ["故障注入实验", "爆炸半径控制", "假设验证", "生产环境安全", "恢复能力"],
  "事件驱动": ["事件溯源存储", "CQRS命令查询", "领域事件设计", "事件总线解耦", "最终一致性"],
  "DDD": ["限界上下文", "聚合根一致性", "值对象不可变", "仓储模式", "反腐败层"],
  "索引": ["复合索引前缀", "覆盖索引避回表", "索引选择性", "部分索引", "维护成本"],
  "事务": ["ACID保证", "隔离级别权衡", "分布式两阶段", "乐观锁重试", "长事务风险"],
  "分布式": ["CAP定理", "最终一致性", "拜占庭容错", "向量时钟", "Paxos共识"],
  "XSS": ["输出编码上下文", "CSP内容安全", "DOM型防护", "输入白名单", "HttpOnly标志"],
  "SQL注入": ["参数化查询", "存储过程隔离", "最小权限账号", "输入校验", "WAF规则"],
  "可观测性": ["三支柱日志链路", "指标告警关联", "分布式追踪", "SLI/SLO/SLA", "平台统一"],
  "服务网格": ["Sidecar注入", "流量策略", "mTLS加密", "可观测增强", "服务发现"],
  "GitOps": ["声明式配置仓库", "自动同步", "Pull模式部署", "Diff可审计", "单一可信源"],
  "Monorepo": ["工作区依赖", "增量构建", "共享配置", "包发布自动化", "边界隔离"],
  "事件循环": ["宏任务微任务", "Promise优先级", "setTimeout延迟", "IO回调阶段", "nextTick"],
  "内存泄漏": ["闭包引用持有", "事件监听未移除", "全局变量积累", "循环引用", "WeakMap弱持有"],
  "特性标志": ["渐进式发布", "AB测试", "运营控制", "标志生命周期", "债务清理"],
  "正则表达式": ["贪婪懒惰量词", "回溯灾难ReDoS", "命名捕获组", "零宽断言", "Unicode属性"],
};

// Work模式: 任务类型→思维框架(Newell-Simon手段目标)
const WORK_FRAMEWORKS = {
  "会议": ["议程确认", "决策记录", "行动项", "时间控制", "跟进机制"],
  "计划": ["目标分解", "优先级矩阵", "里程碑", "依赖关系", "风险评估"],
  "汇报": ["结果量化", "问题清单", "下一步", "资源需求", "时间线"],
  "问题": ["根因分析", "5Why", "影响范围", "临时方案", "长期修复"],
  "需求": ["用户场景", "验收标准", "优先级", "技术可行性", "工期估算"],
  "review": ["代码规范", "安全审查", "性能影响", "测试覆盖", "文档更新"],
  "deadline": ["关键路径", "并行任务", "风险缓冲", "范围裁剪", "沟通升级"],
  "协作": ["职责边界", "信息同步", "阻塞升级", "共享文档", "定期对齐"],
  "决策": ["选项对比", "利弊分析", "可逆性", "数据支撑", "干系人"],
  "优化": ["基线度量", "瓶颈识别", "AB测试", "增量改进", "效果验证"],
  "开会": ["议程确认", "决策记录", "行动项", "时间控制", "跟进机制"],
  "OKR": ["关键结果", "衡量指标", "对齐上级", "季度复盘", "拉伸目标"],
  "KPI": ["指标定义", "权重分配", "数据来源", "周期对比", "异常分析"],
  "延期": ["风险通报", "范围裁剪", "时间线重排", "资源增补", "客户沟通"],
  "沟通": ["信息对齐", "预期管理", "反馈机制", "升级路径", "文档记录"],
  "带人": ["技能评估", "任务拆解", "pair编程", "代码review", "成长路径"],
  "实习": ["导师制", "上手任务", "文档阅读", "周报机制", "转正标准"],
  "汇报": ["结果量化", "问题清单", "下一步", "资源需求", "时间线"],
  "选型": ["评估维度", "POC验证", "社区活跃度", "学习成本", "长期维护"],
  "面试": ["技术评估", "系统设计", "行为面试", "文化匹配", "反馈校准"],
  "晋升": ["影响力", "技术深度", "业务价值", "跨团队协作", "述职准备"],
  "离职": ["交接清单", "知识转移", "权限回收", "关系维护", "反馈收集"],
  "排期": ["任务拆解", "工时估算", "buffer预留", "并行度", "依赖链"],
  "复盘": ["时间线还原", "根因分析", "改进措施", "责任归属", "Follow-up"],
  "迭代": ["故事点估算", "迭代目标承诺", "任务拆分粒度", "依赖项识别", "缓冲预留"],
  "Backlog": ["优先级WSJF", "用户故事拆分", "史诗分解", "验收标准明确", "估算层次"],
  "估算": ["三点估算法", "类比校准", "规划扑克", "不确定性锥", "历史速度参考"],
  "回顾": ["行动项SMART化", "心理安全氛围", "五问根因", "持续改进闭环", "上次验证"],
  "看板": ["WIP限制拉动", "流动效率", "累积流量图", "前置时间", "瓶颈暴露"],
  "用户故事": ["As-Who-So格式", "INVEST原则", "验收条件具体", "价值驱动", "故事拆分"],
  "风险": ["风险矩阵", "缓解措施", "风险登记册", "触发条件", "应急预案"],
  "变更": ["变更影响评估", "利益相关者沟通", "审批流程", "回滚计划", "变更日志"],
  "反馈": ["SBI情境行为影响", "及时性原则", "具体可行", "双向文化", "激进坦诚"],
  "谈判": ["BATNA最佳替代", "锚点效应", "价值创造", "让步节奏", "关系维护"],
  "演讲": ["金字塔结构", "听众需求分析", "故事化叙述", "数据可视化", "问答预演"],
  "绩效": ["OKR目标对齐", "360度反馈", "成就证据", "发展差距", "校准会议"],
  "导师": ["学员目标明确", "定期节奏", "知识迁移", "自主性培养", "关系边界"],
  "入职": ["90天计划", "文化融入", "早期胜利", "关键关系", "信息管理"],
  "ADR": ["决策背景", "备选方案对比", "选择理由", "影响范围", "时效标注"],
  "RACI": ["职责边界划清", "决策点识别", "跨团队协作", "问责链路", "更新维护"],
  "心理安全": ["失败学习文化", "异见安全表达", "实验鼓励", "指责消除", "领导示范"],
  "知识共享": ["工程博客", "内部Tech Talk", "代码审查学习", "结对轮换", "文档即代码"],
  "事故": ["指挥官角色", "时间线记录", "根因分析", "利益相关者通报", "行动项追踪"],
  "事后分析": ["无责文化", "时间线重建", "根因五问", "系统性改进", "学习传播"],
  "季度": ["优先级强排序", "资源容量匹配", "依赖项识别", "风险缓冲", "承诺与愿望"],
  "路线图": ["现状差距分析", "主题而非功能", "时间视野", "依赖里程碑", "动态更新"],
  "平台": ["开发者体验", "自助服务", "黄金路径", "护栏而非门禁", "平台产品化"],
  "康威定律": ["架构组织镜像", "团队边界", "沟通结构影响", "逆康威", "组织重构"],
  "团队拓扑": ["流式团队自治", "平台团队赋能", "赋能团队指导", "复杂子系统", "交互模式"],
  "站会": ["阻碍项暴露", "停车场话题", "时间盒控制", "信息辐射墙", "异步替代"],
  "巴士因子": ["关键知识扩散", "文档化防单点", "轮换培养", "交叉培训", "假期测试"],
};

// 技术概念联想(非错误场景的一般技术发散)
const TECH_ASSOCIATIONS = {
  "前端": ["组件化", "状态管理", "路由", "SSR", "性能优化", "响应式", "虚拟DOM"],
  "后端": ["API设计", "中间件", "ORM", "缓存策略", "消息队列", "微服务"],
  "算法": ["时间复杂度", "空间复杂度", "动态规划", "贪心", "分治", "图论"],
  "架构": ["分层", "领域驱动", "事件溯源", "CQRS", "六边形", "Clean"],
  "数据": ["ETL", "数据建模", "索引策略", "分区", "数据血缘", "质量监控"],
  "运维": ["监控告警", "日志聚合", "链路追踪", "容量规划", "故障演练"],
  "AI": ["特征工程", "模型选择", "超参调优", "过拟合", "数据增强", "推理优化"],
};

let _codingTerms = null;
function _loadCodingTerms() {
  if (_codingTerms) return _codingTerms;
  _codingTerms = new Set();
  const f = path.join(RES_DIR, "coding_terms.txt");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
      const w = line.trim();
      if (w) _codingTerms.add(w);
    }
  }
  return _codingTerms;
}

export function techDiverge(word, mode = "code") {
  const results = [];
  const dict = mode === "work" ? WORK_FRAMEWORKS : ERROR_HYPOTHESES;

  // ★ 诊断路径匹配(Gemini标注): 输出activation_terms而非普通词
  // 凛倾: "资深程序员会检查完整排查框架"
  if (mode === "code") {
    const diag = getDiagnosticPath(word);
    if (diag) {
      for (const term of (diag.activation_terms || []).slice(0, 3)) {
        results.push({ word: term, source: "diagnostic_path", mode, anchor: word, diagnostic: diag.category });
      }
      // 排查步骤第一步也作为激活信号
      if (diag.diagnostic_path?.[0]) {
        results.push({ word: diag.diagnostic_path[0], source: "diagnostic_step", mode, anchor: word });
      }
    }
  }

  // 精确匹配
  if (dict[word]) {
    for (const h of dict[word]) {
      results.push({ word: h, source: "tech_hypothesis", mode, anchor: word });
    }
  }

  // 子串匹配
  if (results.length === 0 || results.length < 3) {
    for (const [key, hyps] of Object.entries(dict)) {
      if (word.includes(key) || key.includes(word)) {
        for (const h of hyps.slice(0, 3)) {
          if (!results.some(r => r.word === h)) {
            results.push({ word: h, source: "tech_hypothesis", mode, anchor: key });
          }
        }
        break;
      }
    }
  }

  // 一般技术联想
  if (mode === "code") {
    for (const [key, assocs] of Object.entries(TECH_ASSOCIATIONS)) {
      if (word.includes(key) || key.includes(word)) {
        for (const a of assocs.slice(0, 3)) {
          if (!results.some(r => r.word === a)) {
            results.push({ word: a, source: "tech_association", mode, anchor: key });
          }
        }
        break;
      }
    }
  }

  return results;
}

const EN_STOP = new Set(["i","me","my","you","your","he","she","it","we","they","the","a","an","is","am","are","was","were","be","been","have","has","had","do","does","did","will","would","can","could","should","may","might","not","no","but","and","or","if","so","at","in","on","to","for","of","with","from","by","about","that","this","what","how","why","when","where","who","which","very","too","just","also","really","feel","think","know","want","need","like","dont","cant","t","s","ll","re","ve","d"]);

// 注意力机制版Tech检测(凛倾: "词性相加 + 注意力 + 连续截断")
// 每个词计算连续的"技术度"分数，全句sigmoid截断
const TECH_KEYWORDS = new Set(["undefined","null","NaN","async","await","const","import","export","function","class","interface","enum","throw","catch","try","debug","localhost","http","https","sudo","chmod","grep","curl","npm","yarn","pip","git","docker","kubectl"]);
const TECH_FRAMEWORKS = new Set(["React","Vue","Angular","Next","Nuxt","Svelte","Express","Django","Flask","Spring","Rails","Laravel","Webpack","Vite","Rollup","Docker","Kubernetes","Redis","MongoDB","PostgreSQL","MySQL","GraphQL","TypeScript","Node","Python","Java","Rust","Go","Swift","Kotlin"]);

export function techAttention(word) {
  if (ERROR_HYPOTHESES[word]) return 3.0;
  if (TECH_ASSOCIATIONS[word]) return 2.5;
  if (WORK_FRAMEWORKS[word]) return 2.0;
  const ZH_TECH = new Set(["代码","编程","程序","算法","接口","数据库","服务器","部署","调试","编译","框架","组件","模块","插件","缓存","索引","集群","容器","镜像","配置","脚本","终端","变量","函数","类型","对象","数组","字符串","布尔","循环","条件","递归","回调","协程","线程","进程","内核"]);
  if (ZH_TECH.has(word)) return 2.0;
  _loadCodingTerms();
  if (_codingTerms.has(word)) return 2.0;
  if (TECH_FRAMEWORKS.has(word)) return 3.0;
  if (TECH_KEYWORDS.has(word)) return 2.5;
  if (/^[A-Z][a-z]+[A-Z]/.test(word)) return 2.0;
  if (/^[a-z]+[A-Z]/.test(word)) return 2.0;
  if (/Error$|Exception$/.test(word)) return 2.5;
  if (/^[A-Z]{2,}$/.test(word) && word.length >= 2 && word.length <= 6) return 1.5;
  if (/\d/.test(word) && /[a-zA-Z]/.test(word)) return 0.5;
  return 0;
}

export function isTechContext(words) {
  let totalScore = 0;
  for (const w of words) totalScore += techAttention(w);
  const sigmoid = 1 / (1 + Math.exp(-(totalScore - 3.0)));
  return sigmoid > 0.6;
}
