'use strict';
/**
 * 深秋歌会 · 包装切换台（服务端）
 *
 * 对应架构里的控制域与合成域：
 *   P2 通道状态机   —— 本文件 state 与 cmd()
 *   P3 cue 发射器   —— broadcast()，带递增 tick
 *   P4 快照服务     —— GET /api/state 与 SSE 首帧
 *   P14 vMix 控制   —— POST /api/vmix，转发到 vMix HTTP API
 *
 * 只监听 127.0.0.1，不依赖任何第三方包。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

function createConcertServer({ dataDirectory, project = path.resolve(__dirname, '..') }) {
  const DATA_DIR = path.resolve(dataDirectory);
  const PUBLIC_DIR = path.join(project, 'ui/concert');
  const ASSET_DIRS = [path.join(project, 'packages/autumn/assets')];
  const FONT_DIRS = [path.join(project, 'packages/autumn/assets/fonts')];
  const FONT_FAMILY = 'Shanggu Sans SC';
  const FONT_RE_ALLOWED = /^ShangguSansSC-[A-Za-z]+\.ttf$/;
  const HOST = '127.0.0.1';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const name of ['config', 'credits', 'lyrics', 'songs']) {
    const destination = path.join(DATA_DIR, name + '.json');
    if (!fs.existsSync(destination)) {
      fs.copyFileSync(path.join(project, 'packages/autumn/data', name + '.json'), destination);
    }
  }
  let stopped = false;
  const standbyTimers = new Set();
  const pingTimers = new Map();

  function cancelHandoff() {
    for (const timer of standbyTimers) clearTimeout(timer);
    standbyTimers.clear();
  }

  // 互斥通道：同一时刻只允许一个开着
  const EXCLUSIVE = ['announce', 'lyric', 'qualify', 'credits'];
  // 角标与主视觉不参与互斥，各自独立开关

  // 文字元素的默认排版（每个元素都可以在监视页单独覆盖）
  const TEXT_DEFAULT = {
    font: FONT_FAMILY,
    size: 64,
    weight: 700,
    lh: 1.2,
    color: '#ffffff',
    align: 'center',
    // 阴影：偏移 + 模糊 + 颜色 + 透明度
    shadow: true,
    shadowX: 0,
    shadowY: 3,
    shadowBlur: 10,
    shadowColor: '#000000',
    shadowOpacity: 55,
    // 发光：模糊 + 颜色 + 透明度
    glow: false,
    glowBlur: 24,
    glowColor: '#ffffff',
    glowOpacity: 35,
  };

  // 默认位置按背景素材的实际内容区校准：
  //   报幕卡在画面左下（约 320,635 - 890,930），歌词圆球在中上（约 800,250 - 1140,610）
  function textRect(x, y, w, h, size, extra) {
    return Object.assign({ x, y, w, h }, TEXT_DEFAULT, { size }, extra || {});
  }

  const DEFAULT_LAYOUT = {
    announceBg: { x: 0, y: 0, w: 1920, h: 1080 },
    announceText: textRect(330, 650, 550, 270, 52),
    lyricBg: { x: 0, y: 0, w: 1920, h: 1080 },
    lyricText: textRect(510, 700, 900, 210, 60),
    qualifyBg: { x: 1010, y: 250, w: 760, h: 420 },
    qualifyTitle: textRect(1020, 262, 740, 72, 38),
    qualifyText: textRect(1020, 344, 740, 300, 48),
    creditsBg: { x: 0, y: 0, w: 1920, h: 1080 },
    creditsText: textRect(560, 90, 800, 900, 34, { lh: 1.9, font: FONT_FAMILY }),
    badge: { x: 0, y: 0, w: 1920, h: 1080 },
  };

  const TEXT_IDS = Object.keys(DEFAULT_LAYOUT).filter((id) => DEFAULT_LAYOUT[id].size != null);

  const DEFAULT_FONT = {
    family: FONT_FAMILY,
    weight: 700,
    shadow: true,
  };

  const DEFAULT_STATE = {
    version: 1,
    tick: 0,
    layout: DEFAULT_LAYOUT,
    channels: {
      announce: { on: false, text: '' },
      lyric: { on: false, index: 0, text: '', auto: true, hold: 9 },
      qualify: { on: false, title: '晋级', text: '' },
      credits: { on: false, paused: false, offset: 0, speed: 40 },
      badge: { on: false },
      visual: { on: false },
    },
    updatedAt: null,
  };

  // ---------- 文件读写 ----------

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJsonAtomic(file, value) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  ensureDir(DATA_DIR);

  // 用户导入的素材单独放一个目录，与内置素材并列
  const IMPORT_DIR = path.join(DATA_DIR, 'assets');
  ensureDir(IMPORT_DIR);

  const ASSET_EXTS = ['.webm', '.mp4', '.mov', '.png', '.jpg', '.jpeg', '.webp'];
  const BACKGROUND_CHANNELS = ['announce', 'lyric', 'qualify', 'badge', 'credits'];
  const DEFAULT_BACKGROUNDS = {
    announce: '报幕1',
    lyric: '歌词',
    qualify: '',
    badge: '角标',
    credits: '',
  };

  function assetMode(file) {
    return /报幕[12]\.webm$/i.test(file) ? 'once' : 'loop';
  }

  function listAssets() {
    const out = [];
    // 同名素材只留一份：先出现的目录优先（自带 assets 高于开发工作区）
    const seen = new Set();
    const dirs = ASSET_DIRS.map((dir) => [dir, true]).concat([[IMPORT_DIR, false]]);
    for (const [dir, builtin] of dirs) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (seen.has(name)) continue;
        const ext = path.extname(name).toLowerCase();
        if (!ASSET_EXTS.includes(ext)) continue;
        let st;
        try {
          st = fs.statSync(path.join(dir, name));
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        seen.add(name);
        out.push({
          key: path.basename(name, path.extname(name)),
          file: name,
          bytes: st.size,
          mtime: Math.round(st.mtimeMs),
          builtin,
          url: '/assets/' + encodeURIComponent(name),
        });
      }
    }
    return out.sort(
      (a, b) => Number(b.builtin) - Number(a.builtin) || a.file.localeCompare(b.file, 'zh'),
    );
  }

  function findAsset(file) {
    if (!file) return null;
    return listAssets().find((a) => a.file === file) || null;
  }

  let manifest = { assets: {}, channels: {} };
  const lyricDoc = readJson(path.join(DATA_DIR, 'lyrics.json'), { lines: [] });
  let lyrics = Array.isArray(lyricDoc)
    ? lyricDoc.slice()
    : Array.isArray(lyricDoc.lines)
      ? lyricDoc.lines.slice()
      : [];

  let config = readJson(path.join(DATA_DIR, 'config.json'), {
    vmix: { enabled: false, host: '127.0.0.1', port: 8088, input: 'MainVisual', overlay: 1 },
  });
  if (!config.vmix) {
    config.vmix = {
      enabled: false,
      host: '127.0.0.1',
      port: 8088,
      input: 'MainVisual',
      overlay: 1,
    };
  }
  if (config.fadeIn == null) config.fadeIn = 320;
  if (config.fadeOut == null) config.fadeOut = 240;
  if (!config.font || typeof config.font !== 'object') config.font = { ...DEFAULT_FONT };
  config.font = { ...DEFAULT_FONT, ...config.font };
  if (config.font.family === 'Microsoft YaHei') {
    config.font.family = FONT_FAMILY;
    writeJsonAtomic(path.join(DATA_DIR, 'config.json'), config);
  }
  if (!config.backgrounds || typeof config.backgrounds !== 'object') {
    config.backgrounds = { ...DEFAULT_BACKGROUNDS };
  }
  for (const ch of BACKGROUND_CHANNELS) {
    if (config.backgrounds[ch] == null) config.backgrounds[ch] = DEFAULT_BACKGROUNDS[ch];
  }

  // 素材清单与通道背景绑定，随快照下发给渲染器
  function buildManifest() {
    const assets = {};
    for (const a of listAssets()) {
      assets[a.key] = { file: a.file, mode: assetMode(a.file), builtin: a.builtin };
    }
    return {
      assets,
      backgrounds: { ...config.backgrounds },
      channels: {
        announce: { assets: ['announce1', 'announce2'] },
        lyric: {},
        qualify: {},
        badge: {},
        credits: {},
      },
    };
  }

  let creditsDoc = readJson(path.join(DATA_DIR, 'credits.json'), {
    groups: [
      { role: '主办', names: ['深秋歌会组委会'] },
      { role: '导演', names: ['—'] },
      { role: '灯光', names: ['—'] },
      { role: '音响', names: ['—'] },
      { role: '摄影', names: ['—'] },
      { role: '特别鸣谢', names: ['—'] },
    ],
  });

  // 歌曲清单：每首歌带自己的歌词，选中后成为当前歌词
  let songsDoc = readJson(path.join(DATA_DIR, 'songs.json'), { songs: [], currentId: null });
  if (!Array.isArray(songsDoc.songs)) songsDoc.songs = [];
  if (songsDoc.currentId == null)
    songsDoc.currentId = songsDoc.songs.length ? songsDoc.songs[0].id : null;

  let state = readJson(path.join(DATA_DIR, 'state.json'), structuredClone(DEFAULT_STATE));
  let layoutCleaned = false;
  // 晋级文字拆成“标题 / 内容”之前，旧数据里只有一个 qualifyText
  const hadQualifyTitle = !!(state.layout && state.layout.qualifyTitle);
  const legacyQualify =
    state.layout && state.layout.qualifyText ? { ...state.layout.qualifyText } : null;
  // 布局升级：旧版本没有字号/字体字段，且默认坐标未对齐素材，升级时重置一次
  const LAYOUT_VERSION = 3;
  if (!state.layout || state.layoutVersion !== LAYOUT_VERSION) {
    state.layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
    state.layoutVersion = LAYOUT_VERSION;
  }
  // 兼容旧文件：补齐缺失字段
  for (const key of Object.keys(DEFAULT_LAYOUT)) {
    state.layout[key] = { ...DEFAULT_LAYOUT[key], ...(state.layout[key] || {}) };
  }
  // 晋级：旧数据没有标题元素时补一个。没动过位置的用新默认，
  // 动过的把标题放到原内容上方，避免两块文字叠在一起。
  if (!hadQualifyTitle && legacyQualify) {
    const untouched =
      legacyQualify.x === 1020 &&
      legacyQualify.y === 268 &&
      legacyQualify.w === 740 &&
      legacyQualify.h === 384;
    if (untouched) {
      state.layout.qualifyText = { ...state.layout.qualifyText, y: 344, h: 300, size: 48 };
    } else {
      state.layout.qualifyTitle = {
        ...state.layout.qualifyTitle,
        x: legacyQualify.x,
        w: legacyQualify.w,
        y: Math.max(0, legacyQualify.y - 82),
      };
    }
    layoutCleaned = true;
  }
  // 缩放只属于背景：清掉文字元素上残留的旧 scale
  for (const key of TEXT_IDS) {
    if (state.layout[key] && state.layout[key].scale != null) {
      delete state.layout[key].scale;
      layoutCleaned = true;
    }
  }
  // 网页统一用工作区自带的尚古黑体：换掉旧数据里的雅黑
  for (const key of TEXT_IDS) {
    const item = state.layout[key];
    if (item && (!item.font || item.font === 'Microsoft YaHei')) {
      item.font = FONT_FAMILY;
      layoutCleaned = true;
    }
  }
  if (!state.channels) state.channels = { ...DEFAULT_STATE.channels };
  for (const key of Object.keys(DEFAULT_STATE.channels)) {
    if (!state.channels[key]) state.channels[key] = { ...DEFAULT_STATE.channels[key] };
  }
  // A restored announcement starts a fresh renderer playback session.
  if (state.channels.announce.on) state.channels.announce.playbackId = randomUUID();
  if (layoutCleaned) {
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'state.json'), state);
    } catch (err) {
      console.error('[state] 清理缩放后保存失败:', err.message);
    }
  }

  // ---------- 事件广播 ----------

  const clients = new Set();
  const STARTED_AT = Date.now();

  function broadcast(event) {
    const line = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const res of clients) {
      try {
        res.write(line);
      } catch {
        clients.delete(res);
      }
    }
  }

  let saveTimer = null;
  function markDirty() {
    if (stopped) return;
    state.updatedAt = new Date().toISOString();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        writeJsonAtomic(path.join(DATA_DIR, 'state.json'), state);
      } catch (err) {
        console.error('[state] 保存失败:', err.message);
      }
    }, 300);
  }

  function snapshot() {
    return {
      version: state.version,
      tick: state.tick,
      now: Date.now(),
      startedAt: STARTED_AT,
      clients: clients.size,
      layout: state.layout,
      channels: state.channels,
      lyrics,
      credits: creditsDoc,
      songs: songsDoc,
      assets: listAssets(),
      manifest: buildManifest(),
      config: {
        vmix: { ...config.vmix, enabled: !!config.vmix.enabled },
        backgrounds: { ...config.backgrounds },
        fadeIn: config.fadeIn != null ? Number(config.fadeIn) : 320,
        fadeOut: config.fadeOut != null ? Number(config.fadeOut) : 240,
        font: { ...config.font },
      },
    };
  }

  function nextTick() {
    state.tick += 1;
    return state.tick;
  }

  // 歌词停留计时：到点自动下（状态机仍是唯一事实源）

  // ---------- 通道命令 ----------

  function closeExclusive(except) {
    for (const key of EXCLUSIVE) {
      if (key !== except && state.channels[key].on) {
        state.channels[key].on = false;
        broadcast({
          type: 'cue',
          tick: nextTick(),
          channel: key,
          action: 'off',
          payload: {},
          reason: 'exclusive',
        });
      }
    }
  }

  // 报幕结束后把歌词接上：每首歌的歌词数据第一行就是空行，
  // 所以 index = 0、text 为空，屏幕上只有背景，等操作员点「下一句」再出第一句。
  // 只在报幕视频播完自动下屏时接管；手动点下屏不抢操作员的节奏。
  function standByLyric() {
    if (!lyrics.length) return;
    state.channels.lyric = { on: true, index: 0, text: '', auto: false, hold: 0 };
    broadcast({
      type: 'cue',
      tick: nextTick(),
      channel: 'lyric',
      action: 'on',
      payload: { index: 0, text: '', auto: false, total: lyrics.length },
    });
    markDirty();
  }

  function setChannelOff(channel, reason) {
    if (!state.channels[channel] || !state.channels[channel].on) return;
    state.channels[channel].on = false;
    if (channel === 'visual') {
      void vmixCall('OverlayInput' + config.vmix.overlay + 'Out', null);
    }
    broadcast({
      type: 'cue',
      tick: nextTick(),
      channel,
      action: 'off',
      payload: {},
      reason: reason || 'manual',
    });
    markDirty();
    // 只有在报幕视频播完、自动下屏时才把歌词接上；手动下屏不动歌词。
    // 延迟 350ms：等报幕的淡出走完，再让歌词背景进场，避免两个过渡挤在一起。
    if (channel === 'announce' && reason === 'media-ended') {
      const timer = setTimeout(() => {
        standbyTimers.delete(timer);
        if (stopped) return;
        if (!state.channels.announce || !state.channels.announce.on) standByLyric();
      }, 350);
      standbyTimers.add(timer);
    }
  }

  async function vmixCall(fn, input) {
    if (!config.vmix.enabled) return { skipped: true, reason: 'vMix 未启用' };
    const base = 'http://' + config.vmix.host + ':' + config.vmix.port + '/api/';
    const q = new URLSearchParams({ Function: fn });
    if (input) q.set('Input', input);
    try {
      const res = await fetch(base + '?' + q.toString(), { signal: AbortSignal.timeout(2500) });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 执行一条切换台命令。
   * @returns {Promise<object>} 供 HTTP 响应回显
   */
  async function command(channel, action, payload = {}) {
    if (!state.channels[channel]) {
      return { ok: false, error: '未知通道: ' + channel };
    }
    if (EXCLUSIVE.includes(channel)) cancelHandoff();

    if (action === 'off') {
      setChannelOff(channel, 'manual');
      return { ok: true };
    }

    if (channel === 'announce') {
      closeExclusive('announce');
      const text = payload.text != null ? String(payload.text) : state.channels.announce.text || '';
      const playbackId = randomUUID();
      state.channels.announce = { on: true, text, playbackId };
      broadcast({
        type: 'cue',
        tick: nextTick(),
        channel: 'announce',
        action: 'on',
        payload: { text, video: config.backgrounds.announce || null, playbackId },
      });
      markDirty();
      return { ok: true };
    }

    if (channel === 'lyric') {
      closeExclusive('lyric');
      const ch = state.channels.lyric || {};
      // 空行是正常行（每首歌第一行就是空行），所以索引范围是 0..len-1
      const cur = Number.isInteger(ch.index) ? ch.index : 0;
      let index = Number.isInteger(payload.index) ? payload.index : cur;
      if (action === 'next') index = Math.min(lyrics.length - 1, cur + 1);
      if (action === 'prev') index = Math.max(0, cur - 1);
      index = Math.min(Math.max(0, index), Math.max(0, lyrics.length - 1));
      const text = payload.text != null ? String(payload.text) : lyrics[index] || '';
      // 歌词不再按停留秒数自动下屏：下一句会替换上一句，收尾由手动下屏
      const auto = false;
      state.channels.lyric = { on: true, index, text, auto, hold: 0 };
      broadcast({
        type: 'cue',
        tick: nextTick(),
        channel: 'lyric',
        action: action === 'next' || action === 'prev' ? 'cue' : 'on',
        payload: { index, text, auto, total: lyrics.length },
      });
      markDirty();
      return { ok: true, index, text };
    }

    if (channel === 'qualify') {
      closeExclusive('qualify');
      const text = payload.text != null ? String(payload.text) : state.channels.qualify.text;
      const title = payload.title != null ? String(payload.title) : state.channels.qualify.title;
      state.channels.qualify = { on: true, title, text };
      broadcast({
        type: 'cue',
        tick: nextTick(),
        channel: 'qualify',
        action: 'on',
        payload: { title, text },
      });
      markDirty();
      return { ok: true };
    }

    if (channel === 'credits') {
      if (action === 'pause') {
        state.channels.credits.paused = true;
        broadcast({
          type: 'cue',
          tick: nextTick(),
          channel: 'credits',
          action: 'pause',
          payload: {},
        });
        markDirty();
        return { ok: true };
      }
      if (action === 'resume') {
        state.channels.credits.paused = false;
        broadcast({
          type: 'cue',
          tick: nextTick(),
          channel: 'credits',
          action: 'resume',
          payload: {},
        });
        markDirty();
        return { ok: true };
      }
      closeExclusive('credits');
      const speed = Number(payload.speed) || state.channels.credits.speed || 40;
      state.channels.credits = { on: true, paused: false, offset: 0, speed };
      broadcast({
        type: 'cue',
        tick: nextTick(),
        channel: 'credits',
        action: 'on',
        payload: { speed, offset: 0 },
      });
      markDirty();
      return { ok: true };
    }

    if (channel === 'badge') {
      state.channels.badge = { on: action !== 'off' };
      broadcast({ type: 'cue', tick: nextTick(), channel: 'badge', action: 'on', payload: {} });
      markDirty();
      return { ok: true };
    }

    if (channel === 'visual') {
      state.channels.visual = { on: true };
      const result = await vmixCall('OverlayInput' + config.vmix.overlay + 'In', config.vmix.input);
      broadcast({
        type: 'cue',
        tick: nextTick(),
        channel: 'visual',
        action: 'on',
        payload: { vmix: result },
      });
      markDirty();
      return { ok: true, vmix: result };
    }

    return { ok: false, error: '未实现的动作: ' + channel + '/' + action };
  }

  // ---------- HTTP ----------

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webm': 'video/webm',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };

  function sendJson(res, code, value) {
    const body = JSON.stringify(value);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(new Error('JSON 解析失败: ' + err.message));
        }
      });
      req.on('error', reject);
    });
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // 命令行/同源表单
    try {
      const u = new URL(origin);
      return u.host === req.headers.host;
    } catch {
      return false;
    }
  }

  function serveStatic(req, res, pathname) {
    let filePath;
    if (pathname.startsWith('/fonts/')) {
      const rel = decodeURIComponent(pathname.slice('/fonts/'.length));
      if (!FONT_RE_ALLOWED.test(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      let found = null;
      for (const dir of [...FONT_DIRS]) {
        const candidate = path.resolve(dir, rel);
        if (!candidate.startsWith(dir + path.sep)) continue;
        try {
          if (fs.statSync(candidate).isFile()) {
            found = candidate;
            break;
          }
        } catch {
          /* 继续找下一个目录 */
        }
      }
      filePath = found;
    } else if (pathname.startsWith('/assets/')) {
      const rel = decodeURIComponent(pathname.slice('/assets/'.length));
      let found = null;
      for (const dir of [IMPORT_DIR, ...ASSET_DIRS]) {
        const candidate = path.resolve(dir, rel);
        if (!candidate.startsWith(dir + path.sep)) continue;
        try {
          if (fs.statSync(candidate).isFile()) {
            found = candidate;
            break;
          }
        } catch {
          /* 继续找下一个目录 */
        }
      }
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      filePath = found;
    } else {
      const rel =
        pathname === '/' ? 'control.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
      filePath = path.resolve(PUBLIC_DIR, rel);
      if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
        return sendJson(res, 403, { error: '禁止访问' });
      }
    }
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': ext === '.webm' || ext === '.ttf' ? 'public, max-age=604800' : 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || HOST));
    const pathname = url.pathname;

    // SSE：渲染器与控制台都从这里取 cue
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 1500\n\n');
      res.write('data: ' + JSON.stringify({ type: 'snapshot', state: snapshot() }) + '\n\n');
      clients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* 连接已断开，交给 close 处理 */
        }
      }, 20000);
      pingTimers.set(res, ping);
      req.on('close', () => {
        clearInterval(ping);
        pingTimers.delete(res);
        clients.delete(res);
      });
      return;
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, snapshot());
    }

    if (pathname === '/api/manifest' && req.method === 'GET') {
      return sendJson(res, 200, buildManifest());
    }

    if (pathname === '/api/assets' && req.method === 'GET') {
      return sendJson(res, 200, {
        assets: listAssets(),
        backgrounds: config.backgrounds,
        importDir: IMPORT_DIR,
      });
    }

    if (pathname === '/api/songs' && req.method === 'GET') {
      return sendJson(res, 200, songsDoc);
    }

    if (pathname === '/api/credits' && req.method === 'GET') {
      return sendJson(res, 200, creditsDoc);
    }

    if (req.method === 'POST') {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: '来源不合法' });

      if (pathname === '/api/assets/import') {
        try {
          const body = await readBody(req, 512 * 1024 * 1024);
          const rawName = String(body.name || '').trim();
          const dataUrl = String(body.dataUrl || '');
          if (!rawName || !dataUrl) return sendJson(res, 400, { error: '缺少文件名或内容' });
          const ext = path.extname(rawName).toLowerCase();
          if (!ASSET_EXTS.includes(ext)) {
            return sendJson(res, 400, { error: '不支持的格式：' + (ext || '无扩展名') });
          }
          const base = (
            path
              .basename(rawName, ext)
              .replace(/[\\/:*?"<>|]/g, '_')
              .trim() || 'asset'
          ).slice(0, 80);
          let finalName = base + ext;
          let n = 2;
          const busy = (name) =>
            fs.existsSync(path.join(IMPORT_DIR, name)) ||
            ASSET_DIRS.some((dir) => fs.existsSync(path.join(dir, name)));
          while (busy(finalName)) {
            finalName = base + '-' + n + ext;
            n += 1;
          }
          const match = /^data:([^;]*);base64,(.*)$/s.exec(dataUrl);
          if (!match) return sendJson(res, 400, { error: '内容不是 base64 data URL' });
          const buf = Buffer.from(match[2], 'base64');
          if (!buf.length) return sendJson(res, 400, { error: '文件为空' });
          fs.writeFileSync(path.join(IMPORT_DIR, finalName), buf);
          return sendJson(res, 200, { ok: true, asset: findAsset(finalName), bytes: buf.length });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/assets/delete') {
        try {
          const body = await readBody(req);
          const file = path.basename(String(body.file || ''));
          const target = path.join(IMPORT_DIR, file);
          if (!target.startsWith(IMPORT_DIR + path.sep) || !fs.existsSync(target)) {
            return sendJson(res, 400, { error: '只能删除导入的素材' });
          }
          for (const ch of BACKGROUND_CHANNELS) {
            if (config.backgrounds[ch] === file) config.backgrounds[ch] = '';
          }
          fs.unlinkSync(target);
          writeJsonAtomic(path.join(DATA_DIR, 'config.json'), config);
          broadcast({ type: 'snapshot', state: snapshot() });
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/backgrounds') {
        try {
          const body = await readBody(req);
          const ch = String(body.channel || '');
          if (!BACKGROUND_CHANNELS.includes(ch)) return sendJson(res, 400, { error: '未知通道' });
          const file = String(body.file || '').trim();
          if (file && !findAsset(file)) return sendJson(res, 400, { error: '素材不存在' });
          config.backgrounds[ch] = file;
          writeJsonAtomic(path.join(DATA_DIR, 'config.json'), config);
          broadcast({ type: 'snapshot', state: snapshot() });
          return sendJson(res, 200, { ok: true, backgrounds: config.backgrounds });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/songs') {
        try {
          const body = await readBody(req);
          if (!Array.isArray(body.songs)) return sendJson(res, 400, { error: 'songs 必须是数组' });
          const songs = body.songs.slice(0, 200).map((s, i) => {
            // 空行是歌词的一部分（句间留白），首行固定补一个空行
            const lines = Array.isArray(s.lyrics)
              ? s.lyrics.map((l) => String(l).slice(0, 200))
              : [];
            while (lines.length && !lines[lines.length - 1]) lines.pop();
            const lyrics = lines.length && lines[0] === '' ? lines : [''].concat(lines);
            return {
              id: String(s.id || 's' + (i + 1)),
              round: String(s.round || '').slice(0, 40),
              order: Number(s.order) || 0,
              title: String(s.title || '').slice(0, 80),
              performer: String(s.performer || '').slice(0, 80),
              version: String(s.version || '').slice(0, 60),
              note: String(s.note || '').slice(0, 200),
              lyrics,
            };
          });
          songsDoc = {
            songs,
            currentId: body.currentId != null ? String(body.currentId) : songsDoc.currentId,
          };
          writeJsonAtomic(path.join(DATA_DIR, 'songs.json'), songsDoc);
          broadcast({ type: 'snapshot', state: snapshot() });
          return sendJson(res, 200, { ok: true, songs: songsDoc.songs });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/songs/select') {
        try {
          const body = await readBody(req);
          const id = String(body.id || '');
          const song = songsDoc.songs.find((s) => s.id === id);
          if (!song) return sendJson(res, 400, { error: '歌曲不存在' });
          songsDoc.currentId = id;
          lyrics = (song.lyrics || []).map((l) => String(l));
          // 数据约定：歌词第一行固定是空行，屏幕上先只有背景
          if (!lyrics.length) lyrics = [''];
          else if (lyrics[0] !== '') lyrics.unshift('');
          // 切节目回到第一句；如果歌词正在上屏，同步替换成新节目的第一句
          const lch = state.channels.lyric;
          const wasOn = !!(lch && lch.on);
          state.channels.lyric = {
            on: wasOn,
            index: 0,
            text: lyrics[0] || '',
            auto: false,
            hold: 0,
          };
          // 报幕文本跟着节目走：只给曲名和演唱者，不加「第 x 个节目」
          const annLines = ['《' + song.title + '》'];
          if (song.performer) annLines.push('演唱：' + song.performer);
          const annText = annLines.join('\n');
          const ach = state.channels.announce || {};
          cancelHandoff();
          state.channels.announce = {
            ...ach,
            text: annText,
            playbackId: ach.on ? randomUUID() : ach.playbackId,
          };
          writeJsonAtomic(path.join(DATA_DIR, 'songs.json'), songsDoc);
          writeJsonAtomic(path.join(DATA_DIR, 'lyrics.json'), { lines: lyrics });
          markDirty();
          if (ach.on) {
            broadcast({
              type: 'cue',
              tick: nextTick(),
              channel: 'announce',
              action: 'cue',
              payload: { text: annText, playbackId: state.channels.announce.playbackId },
            });
          }
          if (wasOn) {
            broadcast({
              type: 'cue',
              tick: nextTick(),
              channel: 'lyric',
              action: 'cue',
              payload: { index: 0, text: lyrics[0] || '', auto: false, total: lyrics.length },
            });
          }
          broadcast({ type: 'snapshot', state: snapshot() });
          return sendJson(res, 200, { ok: true, song });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/command') {
        try {
          const body = await readBody(req);
          const result = await command(body.channel, body.action || 'on', body.payload || {});
          return sendJson(res, result.ok === false ? 400 : 200, result);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/layout') {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body.items) ? body.items : [body];
          const applied = [];
          for (const item of items) {
            const patch = applyLayoutPatch(item);
            if (patch.error) return sendJson(res, 400, { error: patch.error });
            applied.push(item.id);
          }
          markDirty();
          broadcast({ type: 'layout', tick: nextTick(), layout: state.layout });
          return sendJson(res, 200, { ok: true, applied, layout: state.layout });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/layout/reset') {
        state.layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
        markDirty();
        broadcast({ type: 'layout', tick: nextTick(), layout: state.layout });
        return sendJson(res, 200, { ok: true, layout: state.layout });
      }

      if (pathname === '/api/preview') {
        try {
          const body = await readBody(req);
          const raw = Array.isArray(body.ids) ? body.ids : [body.id];
          const ids = raw.map((v) => String(v || '')).filter(Boolean);
          if (!ids.length) {
            return sendJson(res, 400, { error: '缺少元素 id' });
          }
          const unknown = ids.find(
            (id) => !Object.prototype.hasOwnProperty.call(DEFAULT_LAYOUT, id),
          );
          if (unknown) {
            return sendJson(res, 400, { error: '未知元素：' + unknown });
          }
          const on = body.on !== false;
          // target 是「当前正在编辑的那一个」，预监里据此自动选中，
          // 这样右侧点完选择对象后，预览里的方向键微调能直接作用到它。
          const target =
            body.target && Object.prototype.hasOwnProperty.call(DEFAULT_LAYOUT, body.target)
              ? String(body.target)
              : null;
          broadcast({ type: 'preview', tick: nextTick(), ids, on, target });
          return sendJson(res, 200, { ok: true, ids, on, target });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/lyrics') {
        try {
          const body = await readBody(req);
          const list = Array.isArray(body.lines)
            ? body.lines
            : Array.isArray(body.lyrics)
              ? body.lyrics
              : null;
          if (!list) return sendJson(res, 400, { error: 'lines 必须是数组' });
          // 空行保留：歌词里用空行做句间留白；首行同样固定补一个空行
          const kept = list.map((s) => String(s).trim()).filter((line) => !/^[\[【(（]/.test(line));
          while (kept.length && !kept[kept.length - 1]) kept.pop();
          lyrics = kept.length && kept[0] === '' ? kept : [''].concat(kept);
          writeJsonAtomic(path.join(DATA_DIR, 'lyrics.json'), { lines: lyrics });
          state.channels.lyric.index = Math.min(
            state.channels.lyric.index,
            Math.max(0, lyrics.length - 1),
          );
          markDirty();
          broadcast({ type: 'lyrics', tick: nextTick(), lyrics });
          return sendJson(res, 200, { ok: true, count: lyrics.length });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/credits') {
        try {
          const body = await readBody(req);
          if (!Array.isArray(body.groups))
            return sendJson(res, 400, { error: 'groups 必须是数组' });
          creditsDoc = {
            groups: body.groups.map((g) => ({
              role: String(g.role || '').trim() || '名单',
              names: (Array.isArray(g.names) ? g.names : [])
                .map((n) => String(n).trim())
                .filter(Boolean),
            })),
          };
          writeJsonAtomic(path.join(DATA_DIR, 'credits.json'), creditsDoc);
          broadcast({ type: 'credits', tick: nextTick(), credits: creditsDoc });
          return sendJson(res, 200, { ok: true, groups: creditsDoc.groups.length });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/config') {
        try {
          const body = await readBody(req);
          let changed = false;
          if (body.vmix && typeof body.vmix === 'object') {
            config.vmix = { ...config.vmix, ...body.vmix, enabled: !!body.vmix.enabled };
            changed = true;
          }
          if (body.fadeIn != null) {
            config.fadeIn = clampNum(body.fadeIn, config.fadeIn, 0, 3000);
            changed = true;
          }
          if (body.fadeOut != null) {
            config.fadeOut = clampNum(body.fadeOut, config.fadeOut, 0, 3000);
            changed = true;
          }
          if (body.font && typeof body.font === 'object') {
            if (typeof body.font.family === 'string' && FONT_RE.test(body.font.family.trim())) {
              config.font.family = body.font.family.trim();
              changed = true;
            }
            if (body.font.weight != null) {
              config.font.weight = clampNum(body.font.weight, config.font.weight, 100, 900);
              changed = true;
            }
            if (body.font.shadow != null) {
              config.font.shadow = !!body.font.shadow;
              changed = true;
            }
          }
          if (!changed) return sendJson(res, 400, { error: '没有可更新的字段' });
          writeJsonAtomic(path.join(DATA_DIR, 'config.json'), config);
          broadcast({ type: 'config', tick: nextTick(), config: snapshot().config });
          return sendJson(res, 200, { ok: true, config: snapshot().config });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      // 渲染器上报事件：目前只有“背景视频播完”
      if (pathname === '/api/event') {
        try {
          const body = await readBody(req);
          if (body.type === 'media-ended' && body.channel === 'announce') {
            if (
              state.channels.announce.on &&
              typeof body.playbackId === 'string' &&
              body.playbackId === state.channels.announce.playbackId
            )
              setChannelOff('announce', 'media-ended');
          }
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/vmix') {
        try {
          const body = await readBody(req);
          const fn = String(body.function || '');
          if (!/^[A-Za-z0-9]+$/.test(fn)) return sendJson(res, 400, { error: '函数名不合法' });
          const result = await vmixCall(fn, body.input || config.vmix.input);
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      return sendJson(res, 404, { error: '未知接口' });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405');
  });

  const FONT_RE = /^[A-Za-z0-9\u4e00-\u9fa5 ,'"\-_.]{1,64}$/;
  const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

  /** 校验并写入一个元素的布局与排版，返回 { id } 或 { error } */
  function applyLayoutPatch(body) {
    const id = String((body && body.id) || '');
    if (!DEFAULT_LAYOUT[id]) return { error: '未知元素: ' + id };
    const current = state.layout[id] || { ...DEFAULT_LAYOUT[id] };
    const next = { ...current };
    // 允许负坐标：全屏背景可以整块平移（带着文字一起走），只要不无限跑掉
    if (body.x != null) next.x = clampNum(body.x, current.x, -4000, 4000);
    if (body.y != null) next.y = clampNum(body.y, current.y, -4000, 4000);
    if (body.w != null) next.w = clampNum(body.w, current.w, 20, 4000);
    if (body.h != null) next.h = clampNum(body.h, current.h, 20, 4000);
    // 缩放只对背景成立：文字的大小由字号决定，不接受 scale
    if (body.scale != null && !TEXT_IDS.includes(id)) {
      const s = Math.round((Number(body.scale) || 1) * 100) / 100;
      next.scale = Math.min(3, Math.max(0.1, s));
    }
    if (current.size != null) {
      if (typeof body.font === 'string' && FONT_RE.test(body.font.trim()))
        next.font = body.font.trim();
      if (body.size != null) next.size = clampNum(body.size, current.size, 12, 400);
      if (body.weight != null) next.weight = clampNum(body.weight, current.weight, 100, 900);
      if (body.lh != null) next.lh = Math.min(3, Math.max(0.8, Number(body.lh) || current.lh));
      if (typeof body.color === 'string' && COLOR_RE.test(body.color)) next.color = body.color;
      if (['left', 'center', 'right'].includes(body.align)) next.align = body.align;
      if (body.shadow != null) next.shadow = !!body.shadow;
      if (body.shadowX != null) next.shadowX = clampNum(body.shadowX, current.shadowX, -40, 40);
      if (body.shadowY != null) next.shadowY = clampNum(body.shadowY, current.shadowY, -40, 40);
      if (body.shadowBlur != null)
        next.shadowBlur = clampNum(body.shadowBlur, current.shadowBlur, 0, 80);
      if (typeof body.shadowColor === 'string' && COLOR_RE.test(body.shadowColor))
        next.shadowColor = body.shadowColor;
      if (body.shadowOpacity != null)
        next.shadowOpacity = clampNum(body.shadowOpacity, current.shadowOpacity, 0, 100);
      if (body.glow != null) next.glow = !!body.glow;
      if (body.glowBlur != null) next.glowBlur = clampNum(body.glowBlur, current.glowBlur, 0, 120);
      if (typeof body.glowColor === 'string' && COLOR_RE.test(body.glowColor))
        next.glowColor = body.glowColor;
      if (body.glowOpacity != null)
        next.glowOpacity = clampNum(body.glowOpacity, current.glowOpacity, 0, 100);
    }
    state.layout[id] = next;
    return { id };
  }

  function clampNum(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  server.pauseClocks = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(saveTimer);
    saveTimer = null;
    cancelHandoff();
    for (const [response, timer] of pingTimers) {
      clearInterval(timer);
      response.end();
    }
    pingTimers.clear();
    clients.clear();
    writeJsonAtomic(path.join(DATA_DIR, 'state.json'), state);
  };
  server.on('close', server.pauseClocks);
  return server;
}

module.exports = { createConcertServer };
