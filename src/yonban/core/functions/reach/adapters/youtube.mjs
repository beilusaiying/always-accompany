/**
 * youtube.mjs — YouTube 平台适配器（CLI 桥接 yt-dlp）
 *
 * 能力：视频元数据、字幕提取、搜索。
 * ytCookiesFrom 配置（--cookies-from-browser）用于年龄限制/会员内容。
 * 转写能力已删（2026-07-22 凛倾拍板）：依赖第三方 Whisper API 注册，beilu 自有语音识别，不推广第三方。
 */

import { execCLI } from "../bridge.mjs";

/** ytCookiesFrom 接线：yt-dlp 官方参数 --cookies-from-browser（此前该配置收了没消费=死配置） */
function _cookieArgs(opts) {
  const from = opts?.config?.ytCookiesFrom;
  return from ? ["--cookies-from-browser", from] : [];
}

export default {
  name: "youtube",

  async execute(action, query, opts) {
    switch (action) {
      case "info":
        return _info(query, opts);
      case "subtitle":
        return _subtitle(query, opts);
      case "search":
        return _search(query, opts);
      default:
        throw new Error(`youtube: unknown action "${action}". Available: info, subtitle, search`);
    }
  },
};

async function _info(url, opts) {
  const r = await execCLI("yt-dlp", ["--dump-json", ..._cookieArgs(opts), url], { parseAs: "json", timeout: 30000 });
  if (!r.ok) throw new Error(`yt-dlp info: ${r.stderr}`);
  const d = r.data;
  return {
    id: d.id, title: d.title, url: d.webpage_url,
    duration: d.duration, channel: d.channel, upload_date: d.upload_date,
    view_count: d.view_count, description: (d.description || "").slice(0, 500),
  };
}

async function _subtitle(url, opts) {
  const langs = opts?.langs || "zh-Hans,zh,en";
  const tmpDir = opts?.tmpDir || (typeof Deno !== "undefined" ? Deno.env.get("TEMP") || "/tmp" : process.env.TEMP || "/tmp");
  const outTemplate = `${tmpDir}/beilu-reach-%(id)s`;

  const r = await execCLI("yt-dlp", [
    "--write-sub", "--write-auto-sub", "--sub-lang", langs,
    "--skip-download", "-o", outTemplate, ..._cookieArgs(opts), url,
  ], { timeout: 30000 });

  if (!r.ok) throw new Error(`yt-dlp subtitle: ${r.stderr}`);

  // yt-dlp 输出到文件，读取 .vtt 文件内容
  const idMatch = r.data.match(/\[info\]\s+(\S+):/);
  if (!idMatch) return { url, subtitles: null, message: "No subtitle file generated" };

  const fs = typeof Deno !== "undefined" ? { readTextFile: Deno.readTextFile } : await import("node:fs/promises");
  const path = typeof Deno !== "undefined" ? (await import("node:path")) : await import("node:path");
  const glob = typeof Deno !== "undefined" ? Deno.readDirSync : null;

  try {
    const dir = path.dirname(outTemplate.replace("%(id)s", idMatch[1]));
    const prefix = `beilu-reach-${idMatch[1]}`;
    let subtitleContent = "";

    if (typeof Deno !== "undefined") {
      for (const entry of Deno.readDirSync(dir)) {
        if (entry.name.startsWith(prefix) && entry.name.endsWith(".vtt")) {
          subtitleContent = await Deno.readTextFile(path.join(dir, entry.name));
          break;
        }
      }
    } else {
      const fsp = await import("node:fs/promises");
      const files = await fsp.readdir(dir);
      for (const f of files) {
        if (f.startsWith(prefix) && f.endsWith(".vtt")) {
          subtitleContent = await fsp.readFile(path.join(dir, f), "utf-8");
          break;
        }
      }
    }

    if (!subtitleContent) return { url, subtitles: null, message: "Subtitle file not found after download" };

    // VTT → 纯文本（去时间戳和重复行）
    const lines = subtitleContent.split("\n")
      .filter((l) => !l.match(/^\d{2}:\d{2}/) && !l.match(/^WEBVTT/) && !l.match(/^NOTE/) && l.trim())
      .filter((l, i, arr) => l !== arr[i - 1]);
    return { url, subtitles: lines.join("\n") };
  } catch {
    return { url, subtitles: null, message: "Failed to read subtitle file" };
  }
}

async function _search(query, opts) {
  const limit = opts?.limit ?? 5;
  const r = await execCLI("yt-dlp", ["--dump-json", ..._cookieArgs(opts), `ytsearch${limit}:${query}`], { parseAs: "text", timeout: 30000 });
  if (!r.ok) throw new Error(`yt-dlp search: ${r.stderr}`);
  const results = r.data.split("\n").filter(Boolean).map((line) => {
    try {
      const d = JSON.parse(line);
      return { id: d.id, title: d.title, url: d.webpage_url, channel: d.channel, duration: d.duration };
    } catch { return null; }
  }).filter(Boolean);
  return results;
}
