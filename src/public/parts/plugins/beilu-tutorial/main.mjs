import info from './info.json' with { type: 'json' };
import fs from "node:fs";
import path from "node:path";

// 教程脚本存储: data/tutorials/<id>.json (全局共享,不per-user)
const _tutDir = () => path.join(import.meta.dirname, "..", "..", "..", "..", "..", "data", "tutorials");
const _validId = (id) => typeof id === "string" && /^[\w\-]{1,64}$/.test(id);

// tuesday-js块模型: 保留键之外的数组键=block, 步数=全block的dialogs总数
// (与引擎startTutorial的reserved判定同源; 旧{steps:[]}格式兼容计数)
const _RESERVED = new Set(["id", "title", "version", "character", "parameters"]);
function _countDialogs(d) {
  if (Array.isArray(d.steps)) return d.steps.length; // legacy
  let n = 0;
  for (const k of Object.keys(d)) {
    if (_RESERVED.has(k) || !Array.isArray(d[k])) continue;
    for (const scene of d[k]) n += Array.isArray(scene?.dialogs) ? scene.dialogs.length : 0;
  }
  return n;
}

function _listAll() {
  const dir = _tutDir();
  if (!fs.existsSync(dir)) return [];
  // 下划线开头=系统文件(_defaults.json 覆盖层), 不进教程列表
  return fs.readdirSync(dir).filter(f => f.endsWith(".json") && !f.startsWith("_")).map(f => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      return { id: d.id || f.replace(".json", ""), title: d.title || "", stepCount: _countDialogs(d), character: d.character || "" };
    } catch { return null; }
  }).filter(Boolean);
}

function _read(id) {
  const fp = path.join(_tutDir(), id + ".json");
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8"));
}

function _write(id, data) {
  const dir = _tutDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ ...data, id }, null, 2));
}

function _remove(id) {
  const fp = path.join(_tutDir(), id + ".json");
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

export default {
  info,

  Load: async ({ router }) => {
    // 教程列表
    router.get('/api/parts/plugins\\:beilu-tutorial/tutorials', (_req, res) => {
      try { res.json(_listAll()); }
      catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 读取单个教程
    router.get('/api/parts/plugins\\:beilu-tutorial/tutorials/:id', (req, res) => {
      try {
        const id = req.params.id;
        if (!_validId(id)) return res.status(400).json({ error: "Invalid id" });
        const data = _read(id);
        if (!data) return res.status(404).json({ error: "Not found" });
        res.json(data);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 保存教程(新建或更新)
    router.put('/api/parts/plugins\\:beilu-tutorial/tutorials/:id', (req, res) => {
      try {
        const id = req.params.id;
        if (!_validId(id)) return res.status(400).json({ error: "Invalid id" });
        _write(id, req.body);
        res.json({ success: true, id });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 删除教程
    router.delete('/api/parts/plugins\\:beilu-tutorial/tutorials/:id', (req, res) => {
      try {
        const id = req.params.id;
        if (!_validId(id)) return res.status(400).json({ error: "Invalid id" });
        _remove(id);
        res.json({ success: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 能力/限值单源下发(pet_capabilities.json同款机制, 凛倾0715"看机制"):
    // 出厂能力(编辑器滑条限值/行为默认)在后端单点 ← data/tutorials/_defaults.json 用户逐键覆盖 → 前端只消费不自带值域
    const TUTORIAL_CAPABILITIES = {
      // 编辑器滑条限值 [min, max] — 对应教程JSON parameters.text_panel 各键
      editor_limits: {
        opacity: [10, 100], size_text: [10, 32], radius: [0, 28],
        width: [30, 100], bottom: [0, 300], dialog_speed: [5, 100],
        pause_full: [1, 20], pause_half: [1, 12], // 字符节点演出: 标点呼吸停顿倍数
        choice_size: [12, 40], choice_dim: [0, 80], choice_blur: [0, 20], // 选项"选择时刻"层
      },
      // 新增立绘出厂位置/尺寸(tuesday-js数组格式)
      art_default_pos: ["25%", "0", "10%", "0"],
      art_default_size: ["40%", "auto"],
      // 立绘缩放拉条值域(%)
      art_scale_limits: [5, 100],
    };
    router.get('/api/parts/plugins\\:beilu-tutorial/defaults', (_req, res) => {
      try {
        const fp = path.join(_tutDir(), "_defaults.json");
        const user = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, "utf-8")) : {};
        // 浅合并+editor_limits逐键合并(用户只覆盖想改的键)
        res.json({
          ...TUTORIAL_CAPABILITIES, ...user,
          editor_limits: { ...TUTORIAL_CAPABILITIES.editor_limits, ...(user.editor_limits || {}) },
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 系统声音库 — 两层(GitHub发布许可分层, 与_defaults覆盖层同范式):
    //   出厂层=插件内 sounds/(CC0/CC-BY素材, 随仓库分发, 致谢见README与_SOURCES.md)
    //   用户层=data/tutorials/sounds/(在.gitignore的/data内不进git — 用户自购/仅限本地许可的素材
    //     如効果音ラボ"禁素材集再分发"条款的文件放这层, 本地合法用不随包发)
    //   列表=并集(用户层同名覆盖出厂), serve=用户层优先查找
    const _sndDirs = () => [path.join(import.meta.dirname, "sounds"), path.join(_tutDir(), "sounds")];
    const _SND_EXT = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);
    const _sndOk = (f) => !f.startsWith("_") && _SND_EXT.has(path.extname(f).toLowerCase()); // "_"=元文件不入列表
    router.get('/api/parts/plugins\\:beilu-tutorial/sounds', (_req, res) => {
      try {
        const seen = new Set();
        for (const dir of _sndDirs()) {
          if (!fs.existsSync(dir)) continue;
          for (const f of fs.readdirSync(dir)) if (_sndOk(f)) seen.add(f);
        }
        res.json([...seen].sort());
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    router.get('/api/parts/plugins\\:beilu-tutorial/sounds/:file', (req, res) => {
      try {
        const f = req.params.file;
        // 纯文件名白名单(防路径穿越), 扩展名白名单
        if (!/^[^/\\]+$/.test(f) || !_SND_EXT.has(path.extname(f).toLowerCase())) return res.status(400).json({ error: "Invalid file" });
        // 用户层优先(同名覆盖出厂)
        for (const dir of [..._sndDirs()].reverse()) {
          const fp = path.join(dir, f);
          if (fs.existsSync(fp)) return res.sendFile(fp);
        }
        res.status(404).json({ error: "Not found" });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 音效库自动下载(凛倾: 音效库不进github, 打开就自己下载): 効果音ラボ许可=各用户自行下载
    // 使用合法但禁随仓库再分发 → 仓库不带文件, 前端打开教程编辑器时自动调此端点补齐到用户层
    // (data/不进git)。清单=出厂默认单点; 已存在跳过(幂等); 逐个100ms节流不轰炸对方服务器。
    const _SFXLAB = (() => {
      const b = "https://soundeffect-lab.info/sound/button/mp3/";
      const v = "https://soundeffect-lab.info/sound/voice/mp3/info-girl1/";
      const rb = "https://soundeffect-lab.info/sound/button/";
      const rv = "https://soundeffect-lab.info/sound/voice/";
      const btn = ["decision1", "decision2", "decision3", "decision12", "decision18", "cursor1", "cursor5", "cursor7",
        "cancel1", "cancel3", "cancel6", "warning1", "warning2", "message-display1", "message-display2",
        "message-display3", "beep1", "beep2", "menu1", "menu2", "success1", "data-display1", "data-display2"];
      const girl = ["youkoso1", "omedetou1", "seikai1", "zannen1", "pinponpinpon1", "bubu1", "good1", "excellent1", "start1", "goal1"];
      return [
        ...btn.map(n => ({ file: `${n}.mp3`, url: `${b}${n}.mp3`, referer: rb })),
        ...girl.map(n => ({ file: `info-girl1-${n}.mp3`, url: `${v}info-girl1-${n}.mp3`, referer: rv })),
      ];
    })();
    let _sndDlBusy = false; // 并发守卫: 多窗口同时打开只跑一趟
    router.post('/api/parts/plugins\\:beilu-tutorial/sounds-download', async (_req, res) => {
      try {
        if (_sndDlBusy) return res.json({ success: true, busy: true });
        _sndDlBusy = true;
        try {
          const dir = path.join(_tutDir(), "sounds");
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          let downloaded = 0, skipped = 0; const failed = [];
          for (const it of _SFXLAB) {
            const fp = path.join(dir, it.file);
            if (fs.existsSync(fp)) { skipped++; continue; }
            try {
              const r = await fetch(it.url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": it.referer } });
              if (!r.ok) { failed.push(it.file); continue; }
              const buf = new Uint8Array(await r.arrayBuffer());
              if (buf.length < 1000) { failed.push(it.file); continue; }
              fs.writeFileSync(fp, buf);
              downloaded++;
            } catch { failed.push(it.file); }
            await new Promise(r2 => setTimeout(r2, 100));
          }
          res.json({ success: true, downloaded, skipped, failed });
        } finally { _sndDlBusy = false; }
      } catch (e) { _sndDlBusy = false; res.status(500).json({ error: e.message }); }
    });

    // 图片包列表: 不在此重复实现 — 既有 /api/eye/imagepacks(endpoints.mjs:1423)是唯一权威
    // (含无pack.json目录自动物化), 前端 tutorialEngine.listImagepacks 拉线该端点+pack.json组装
  },

  interfaces: {
    config: {
      GetData: async () => ({ tutorials: _listAll() }),
      SetData: async (data) => {
        if (!data || !data._action) return;
        if (data._action === "save" && data.tutorial) {
          const id = data.tutorial.id;
          if (_validId(id)) _write(id, data.tutorial);
        }
        if (data._action === "delete" && data.id) {
          if (_validId(data.id)) _remove(data.id);
        }
      },
    },
  },
};
