/**
 * rss.mjs — RSS/Atom 订阅源读取适配器（原生 JS，零配置）
 *
 * 简单 XML 解析，不依赖外部库。
 */

const TIMEOUT = 15_000;

export default {
  name: "rss",

  async execute(action, feedUrl, opts) {
    if (action !== "read") throw new Error(`rss: only "read" action is supported`);
    if (!feedUrl || !feedUrl.startsWith("http")) throw new Error(`rss: invalid feed URL`);

    const limit = opts?.limit ?? 10;

    const resp = await fetch(feedUrl, {
      headers: { "User-Agent": "beilu-reach/1.0" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!resp.ok) throw new Error(`RSS fetch ${resp.status}: ${resp.statusText}`);

    const xml = await resp.text();
    return _parseRSS(xml, limit);
  },
};

function _parseRSS(xml, limit) {
  const items = [];

  // RSS 2.0: <item>
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  // Atom: <entry>
  const atomItems = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const rawItems = rssItems.length > 0 ? rssItems : atomItems;

  for (const raw of rawItems.slice(0, limit)) {
    items.push({
      title: _tag(raw, "title"),
      link: _tag(raw, "link") || _attr(raw, "link", "href"),
      description: _stripHtml(_tag(raw, "description") || _tag(raw, "summary") || "").slice(0, 300),
      pubDate: _tag(raw, "pubDate") || _tag(raw, "published") || _tag(raw, "updated"),
    });
  }

  const feedTitle = _tag(xml, "title");
  return { title: feedTitle, items };
}

function _tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>`, "i"))
    || xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? m[1].trim() : null;
}

function _attr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

function _stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
}
