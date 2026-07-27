/**
 * v2ex.mjs — V2EX 平台适配器（原生 JS，零配置）
 *
 * V2EX 公开 API，无需认证。
 * 限制：公开 API 无全文搜索端点。
 */

const BASE = "https://www.v2ex.com/api";
const UA = "beilu-reach/1.0";
const TIMEOUT = 10_000;

async function _get(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`V2EX API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

const actions = {
  async hot(_query, opts) {
    const limit = opts?.limit ?? 20;
    const data = await _get(`${BASE}/topics/hot.json`);
    return data.slice(0, limit).map((t) => ({
      id: t.id, title: t.title, url: `https://www.v2ex.com/t/${t.id}`,
      replies: t.replies, node: t.node?.title || t.node_name,
      content: (t.content || "").slice(0, 200),
    }));
  },

  async node(nodeName, opts) {
    const limit = opts?.limit ?? 20;
    const data = await _get(`${BASE}/topics/show.json?node_name=${encodeURIComponent(nodeName)}&page=1`);
    return data.slice(0, limit).map((t) => ({
      id: t.id, title: t.title, url: `https://www.v2ex.com/t/${t.id}`,
      replies: t.replies, node: t.node?.title || nodeName,
      content: (t.content || "").slice(0, 200),
    }));
  },

  async topic(topicId) {
    const [topics, replies] = await Promise.all([
      _get(`${BASE}/topics/show.json?id=${topicId}`),
      _get(`${BASE}/replies/show.json?topic_id=${topicId}&page=1`),
    ]);
    const t = topics[0];
    if (!t) throw new Error(`Topic ${topicId} not found`);
    return {
      id: t.id, title: t.title, url: `https://www.v2ex.com/t/${t.id}`,
      content: t.content, author: t.member?.username,
      replies_count: t.replies,
      replies: replies.slice(0, 50).map((r) => ({
        author: r.member?.username, content: r.content,
      })),
    };
  },

  async user(username) {
    const data = await _get(`${BASE}/members/show.json?username=${encodeURIComponent(username)}`);
    return {
      id: data.id, username: data.username,
      url: `https://www.v2ex.com/member/${data.username}`,
      bio: data.bio, github: data.github, twitter: data.twitter,
      website: data.website, avatar: data.avatar_large,
    };
  },
};

export default {
  name: "v2ex",

  async execute(action, query, opts) {
    const fn = actions[action];
    if (!fn) throw new Error(`v2ex: unknown action "${action}". Available: ${Object.keys(actions).join(", ")}`);
    return fn(query, opts);
  },
};
