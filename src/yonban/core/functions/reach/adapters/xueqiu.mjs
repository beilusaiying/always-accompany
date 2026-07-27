/**
 * xueqiu.mjs — 雪球平台适配器（原生 JS）
 *
 * 需要登录态 Cookie（xq_a_token）才能调用 stock API。
 * Cookie 每次调用从 opts.config.xueqiuCookie 读（execute.mjs 统一透传）——
 * 原 setCookie 模块态旁路已删：写侧 _syncCredentials 只在 SetData 时同步，
 * 重启后读侧拿不到 = 读写不同源。
 */

const TIMEOUT = 10_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function _get(url, cookie) {
  const headers = { "User-Agent": UA, Referer: "https://xueqiu.com/" };
  if (cookie) headers.Cookie = cookie;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!resp.ok) throw new Error(`Xueqiu API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

const actions = {
  async quote(symbol, opts) {
    const json = await _get(`https://stock.xueqiu.com/v5/stock/batch/quote.json?symbol=${encodeURIComponent(symbol)}`, opts?.config?.xueqiuCookie);
    const items = json?.data?.items || [];
    if (items.length === 0) throw new Error(`No data for symbol "${symbol}"`);
    const q = items[0].quote;
    return {
      symbol: q.symbol, name: q.name, current: q.current,
      percent: q.percent, chg: q.chg, high: q.high, low: q.low,
      open: q.open, last_close: q.last_close, volume: q.volume,
      amount: q.amount, market_capital: q.market_capital,
      pe_ttm: q.pe_ttm, turnover_rate: q.turnover_rate,
    };
  },

  async "search-stock"(query, opts) {
    const limit = opts?.limit ?? 10;
    const json = await _get(`https://xueqiu.com/stock/search.json?code=${encodeURIComponent(query)}&size=${limit}`, opts?.config?.xueqiuCookie);
    return (json?.stocks || []).map((s) => ({
      symbol: s.code, name: s.name, exchange: s.exchange,
    }));
  },

  async "hot-posts"(_, opts) {
    const json = await _get("https://xueqiu.com/v4/statuses/public_timeline_by_category.json?since_id=-1&max_id=-1&count=20&category=-1", opts?.config?.xueqiuCookie);
    const items = (json?.list || []).slice(0, opts?.limit ?? 20);
    return items.map((item) => {
      let data;
      try { data = typeof item.data === "string" ? JSON.parse(item.data) : item.data; } catch { data = {}; }
      return {
        id: data.id, title: data.title || (data.text || "").slice(0, 80),
        text: (data.text || "").slice(0, 200), author: data.user?.screen_name,
        url: data.target ? `https://xueqiu.com${data.target}` : null,
      };
    });
  },

  async "hot-stocks"(_, opts) {
    const limit = opts?.limit ?? 10;
    const type = opts?.stock_type ?? 10;
    const json = await _get(`https://stock.xueqiu.com/v5/stock/hot_stock/list.json?size=${limit}&type=${type}`, opts?.config?.xueqiuCookie);
    return (json?.data?.items || []).map((s) => ({
      symbol: s.symbol, name: s.name, current: s.current,
      percent: s.percent, rank: s.rank,
    }));
  },
};

export default {
  name: "xueqiu",
  async execute(action, query, opts) {
    const fn = actions[action];
    if (!fn) throw new Error(`xueqiu: unknown action "${action}". Available: quote, search-stock, hot-posts, hot-stocks`);
    return fn(query, opts);
  },
};
