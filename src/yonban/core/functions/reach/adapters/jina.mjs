/**
 * jina.mjs — Jina Reader 通用网页读取适配器（原生 JS，零配置）
 *
 * 将任意 URL 通过 r.jina.ai 代理读取，返回 Markdown 格式纯文本。
 */

const TIMEOUT = 30_000;

export default {
  name: "jina",

  async execute(action, url, opts) {
    if (action !== "read") throw new Error(`jina: only "read" action is supported`);
    if (!url || !url.startsWith("http")) throw new Error(`jina: invalid URL "${url}"`);

    const maxLength = opts?.maxLength ?? 8000;
    const jinaUrl = `https://r.jina.ai/${url}`;

    const resp = await fetch(jinaUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; beilu-reach/1.0)",
        Accept: "text/plain",
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!resp.ok) throw new Error(`Jina Reader ${resp.status}: ${resp.statusText}`);

    let text = await resp.text();
    if (text.length > maxLength) text = text.slice(0, maxLength) + "\n...(truncated)";
    return { url, content: text, length: text.length };
  },
};
