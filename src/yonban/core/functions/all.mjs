/**
 * functions/all.mjs — 功能节点全量装载清单（中间站桥自举件）
 *
 * 【功能链】
 *   import 本文件（副作用）→ 18 个 functions:* facade + 4 出口节点各自 register 进 registry
 *   → dispatch 可派发全部节点。消费方：web_server/yonban_bridge.mjs（桥首次请求惰性 import）。
 *
 * 【why】
 *   facade 注册靠 import 副作用（registry 纯内存派生视图，裁决6），此前无全量装载单点——
 *   主链只自举了菜单点到的节点（shadowBuild 顶部 import，经验13"影子件自举"）。
 *   桥暴露全部 functions:* 节点，注册面必须完整且单点可数——新节点入住时在此追加一行，
 *   漏加=桥上 E_NODE fail loud（不静默）。
 *   remote:yonban（transport/remoteNodes.mjs）不进本清单：桥按命名空间只放行 functions:*，
 *   remote 档由 IDE 通道自治装载。
 */
// 出口节点必须在所有 functions 节点之前注册：functions 的 Init 可能在 import 副作用阶段就 dispatch bus:broadcast
import "../dispatch/exits.mjs";
import "./memory/index.mjs";
import "./prompt/index.mjs";
import "./api/index.mjs";
import "./render/index.mjs";
import "./regex/index.mjs";
import "./hide/index.mjs";
import "./macro/index.mjs";
import "./image/index.mjs";
import "./mcp/index.mjs";
import "./web/index.mjs";
import "./notification/index.mjs";
import "./screenshot/index.mjs";
import "./security/index.mjs";
import "./sandbox/index.mjs";
import "./rollback/index.mjs";
import "./files/index.mjs";
import "./registry/index.mjs"; // 只读自省节点 functions:registry（25 批12）：面板经桥取 registry 快照+dispatch 活跃度，纯只读无副作用
import "./injectTexts/index.mjs"; // AI 注入文本配置链（铁律【代码禁产生进对话文本】收口）：目录单源+覆盖层，前端设置面板经桥编辑
import "./reach/index.mjs"; // 平台触达：15+ 互联网平台结构化数据获取（V2EX/GitHub/Twitter/Bilibili/YouTube 等）
