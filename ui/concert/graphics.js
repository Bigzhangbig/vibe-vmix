'use strict';
/**
 * 深秋歌会 · 上屏渲染器（P6 主壳 + P7 背景 + P8 排版 + P9 歌词 + P10 滚动 + P11 遮罩）
 *
 * 页面用途：
 *   ?preview=1  预监（控制台/监视页内嵌）
 *   ?edit=1     位置编辑（拖动元素，坐标直接写回服务端）
 *   ?clean=1    隐藏连接提示，给 vMix 用
 */
(function () {
  const params = new URLSearchParams(location.search);
  const EDIT = params.get('edit') === '1';
  const CLEAN = params.get('clean') === '1';
  const PREVIEW = params.get('preview') === '1';
  const OBSERVER = PREVIEW || params.get('observer') === '1';
  if (PREVIEW) document.documentElement.classList.add('layout-editor');

  const stage = document.getElementById('stage');
  const hud = document.getElementById('editHud');
  const conn = document.getElementById('conn');

  const els = {};
  document.querySelectorAll('.el').forEach((el) => {
    els[el.dataset.el] = el;
  });

  // 拖动背景时一起走的文字元素
  const GROUPS = {
    announce: ['announceBg', 'announceText'],
    lyric: ['lyricBg', 'lyricText'],
    qualify: ['qualifyBg', 'qualifyTitle', 'qualifyText'],
  };
  const GROUP_OF = {};
  for (const key of Object.keys(GROUPS)) {
    for (const id of GROUPS[key]) GROUP_OF[id] = key;
  }

  let layout = {};
  let manifest = { assets: {}, channels: {} };
  let channels = {};
  let announcePlaybackId = '';
  let config = { fadeIn: 320, fadeOut: 240, font: { family: 'Shanggu Sans SC', weight: 700, shadow: true } };
  let editSelected = null;

  // ---------- 画布适配 ----------

  function stageScale() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    return s > 0 ? s : 1;
  }

  function fitStage() {
    const s = stageScale();
    stage.style.transform = 'scale(' + s + ')';
    stage.style.left = ((window.innerWidth - 1920 * s) / 2) + 'px';
    stage.style.top = ((window.innerHeight - 1080 * s) / 2) + 'px';
  }

  window.addEventListener('resize', () => {
    fitStage();
    refitAll();
  });

  function refitAll() {
    for (const id of Object.keys(els)) {
      const box = els[id];
      if (box && box.classList.contains('text-box')) fitText(box, box.querySelector('.text-inner'));
    }
  }

  // ---------- 配置与布局 ----------

  function applyConfig(cfg) {
    if (!cfg) return;
    config = Object.assign({}, config, cfg);
    const root = document.documentElement;
    root.style.setProperty('--in-ms', (Number(config.fadeIn) || 0) + 'ms');
    root.style.setProperty('--out-ms', (Number(config.fadeOut) || 0) + 'ms');
    if (config.font && config.font.family) {
      root.style.setProperty('--stage-font', '"' + config.font.family + '", "Shanggu Sans SC", "Microsoft YaHei", sans-serif');
    }
  }

  /**
   * 预监「显示」：只在 ?preview=1 的实例里把某个元素临时点亮，
   * 用来在编辑页对照位置，不影响正式上屏状态。
   */
  const BG_ID_TO_CHANNEL = {
    announceBg: 'announce',
    lyricBg: 'lyric',
    qualifyBg: 'qualify',
    badge: 'badge',
    creditsBg: 'credits',
  };

  // 文字元素预览时的占位样例：没有内容也能看出字号、字体、位置
  const SAMPLE_TEXT = {
    announceText: '第 1 个节目\n《示例曲目》\n演唱：示例歌手',
    lyricText: '这一句是歌词的效果预览',
    qualifyTitle: '晋级名单',
    qualifyText: '示例选手 · 示例曲目',
    creditsText: '主办：示例单位\n导演：示例姓名',
  };

  let soloIds = new Set();

  // 编辑模式下只让「正在编辑的对象」可见，其余全部隐藏
  function applySolo() {
    if (!EDIT) return;
    for (const id of Object.keys(els)) {
      const box = els[id];
      if (box) box.classList.toggle('solo', soloIds.has(id));
    }
  }

  function playBg(el, channel) {
    const key = bgFile(channel);
    const asset = key ? assetOf(key) : {};
    const file = asset.file || key;
    if (!file) return;
    const src = '/assets/' + encodeURIComponent(file);
    if (el.dataset.src !== src) {
      el.dataset.src = src;
      el.src = src;
      el.load();
    }
    el.loop = true;
    const p = el.play();
    if (p && p.catch) p.catch(() => { /* 自动播放被拦，忽略 */ });
  }

  function setPreview(input, on, target) {
    const ids = Array.isArray(input) ? input : [input];

    if (EDIT) {
      soloIds = on ? new Set(ids) : new Set();
      applySolo();
      if (on) {
        for (const id of ids) {
          const ch = BG_ID_TO_CHANNEL[id];
          if (ch && els[id]) playBg(els[id], ch);
        }
        // 预监里自动选中正在编辑的对象：右侧面板选好对象后，
        // 直接把焦点交给它，方向键就能微调，不用先在画面里点一下。
        const focusId = ids.includes(target) ? target : ids.find((id) => els[id]);
        if (focusId && els[focusId] && focusId !== editSelected) selectEl(focusId);
      }
    }

    for (const id of ids) {
      const el = els[id];
      if (!el) continue;
      const channel = BG_ID_TO_CHANNEL[id];
      const inner = el.querySelector('.text-inner');

      if (on) {
        el.classList.add('preview-on');
        if (channel && !EDIT) playBg(el, channel);
        const sample = SAMPLE_TEXT[id];
        if (sample && inner && !inner.textContent.trim()) {
          inner.textContent = sample;
          inner.dataset.previewSample = '1';
          fitText(el, inner);
        }
        continue;
      }

      el.classList.remove('preview-on');
      if (inner && inner.dataset.previewSample) {
        inner.textContent = '';
        delete inner.dataset.previewSample;
      }
      if (channel) {
        const ch = channels[channel];
        if (!(ch && ch.on)) {
          try {
            el.pause();
          } catch {
            /* 忽略 */
          }
        }
      }
    }

    // 编辑模式：把没被 solo 的背景视频停掉，省资源
    if (EDIT && on) {
      for (const id of Object.keys(els)) {
        if (!BG_ID_TO_CHANNEL[id] || soloIds.has(id)) continue;
        try {
          els[id].pause();
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  function applyLayout() {
    for (const id of Object.keys(els)) {
      const box = els[id];
      const rect = layout[id];
      if (!box || !rect) continue;
      box.style.left = rect.x + 'px';
      box.style.top = rect.y + 'px';
      box.style.width = rect.w + 'px';
      box.style.height = rect.h + 'px';
      const sc = rect.scale != null ? Number(rect.scale) : 1;
      box.style.transform = sc && sc !== 1 ? 'scale(' + sc + ')' : '';
      // 全屏元素在编辑模式下会盖住所有东西，标记出来让点击能穿透
      // （除非它正被选中，那时才允许拖）
      box.classList.toggle('blocking', rect.w >= 1920 && rect.h >= 1080);
      applyTextStyle(box, rect);
    }
    requestAnimationFrame(() => {
      refitAll();
      if (editSelected && els[editSelected]) updateHud(editSelected);
    });
  }

  function applyTextStyle(box, rect) {
    if (rect.size == null) return;
    const inner = box.querySelector('.text-inner');
    if (!inner) return;
    const family = rect.font || (config.font && config.font.family) || 'Shanggu Sans SC';
    inner.style.fontFamily = '"' + family + '", "Shanggu Sans SC", "Microsoft YaHei", sans-serif';
    inner.style.fontWeight = String(rect.weight || 700);
    inner.style.lineHeight = String(rect.lh || 1.2);
    inner.style.color = rect.color || '#ffffff';
    const align = rect.align || 'center';
    inner.style.textAlign = align;
    // 文字块宽度随内容收缩，光靠 text-align 看不出左右对齐，
    // 还要把 flex 主轴对齐一起改掉
    if (box.classList.contains('text-box')) {
      box.style.justifyContent = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
    }
    inner.classList.toggle('shadow', rect.shadow !== false);
    inner.style.textShadow = buildTextShadow(rect);
    inner.dataset.maxSize = String(rect.size || 64);
  }

  /** #rrggbb + 0-100 的不透明度 → rgba() */
  function hexToRgba(hex, percent) {
    const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(hex || ''));
    let r = 0;
    let g = 0;
    let b = 0;
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
    const a = Math.min(100, Math.max(0, Number(percent == null ? 100 : percent))) / 100;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
  }

  /** 把阴影与发光拼成一条 text-shadow */
  function buildTextShadow(rect) {
    const parts = [];
    if (rect.shadow !== false) {
      const color = hexToRgba(rect.shadowColor || '#000000', rect.shadowOpacity == null ? 55 : rect.shadowOpacity);
      const x = Number(rect.shadowX || 0);
      const y = Number(rect.shadowY == null ? 3 : rect.shadowY);
      const blur = Number(rect.shadowBlur == null ? 10 : rect.shadowBlur);
      parts.push(x + 'px ' + y + 'px ' + blur + 'px ' + color);
      // 再叠一层极小的贴边阴影，让笔画边缘更实
      parts.push('0 0 2px ' + color);
    }
    if (rect.glow) {
      const glow = hexToRgba(rect.glowColor || '#ffffff', rect.glowOpacity == null ? 35 : rect.glowOpacity);
      const blur = Math.max(1, Number(rect.glowBlur == null ? 24 : rect.glowBlur));
      // 单层发光在白字上几乎看不出来，叠三层由内到外才有明显的光晕
      parts.push('0 0 ' + Math.round(blur * 0.4) + 'px ' + glow);
      parts.push('0 0 ' + Math.round(blur) + 'px ' + glow);
      parts.push('0 0 ' + Math.round(blur * 1.8) + 'px ' + glow);
    }
    return parts.length ? parts.join(', ') : 'none';
  }

  function updateHud(id) {
    if (!hud) return;
    const rect = layout[id] || {};
    hud.textContent = id + '  x=' + Math.round(rect.x || 0) + '  y=' + Math.round(rect.y || 0) +
      '  w=' + Math.round(rect.w || 0) + '  h=' + Math.round(rect.h || 0);
  }

  // ---------- 文字排版（P8） ----------

  /**
   * 字号就是“设多大就多大”：先按设定值铺满，只有在横向放不下时才按宽度收缩。
   * 纵向不再压缩，所以调大字号能立刻看见变化（容器只当定位框用）。
   */
  function fitText(box, inner) {
    if (!box || !inner) return;
    const maxSize = Number(inner.dataset.maxSize) || 64;
    const text = (inner.textContent || '').trim();
    inner.style.fontSize = maxSize + 'px';
    if (!text) return;
    const limitW = box.clientWidth - 8;
    if (limitW <= 0) return;
    if (inner.scrollWidth <= limitW) return;

    let lo = 12;
    let hi = maxSize;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      inner.style.fontSize = mid + 'px';
      if (inner.scrollWidth <= limitW) lo = mid;
      else hi = mid;
    }
    inner.style.fontSize = Math.floor(lo) + 'px';
  }

  // ---------- 视频背景（P7） ----------

  // 每个通道对应一个 <video>；背景素材由「导入素材」页绑定，没绑定就不显示
  const BG_OF = {
    announce: 'announceBg',
    lyric: 'lyricBg',
    qualify: 'qualifyBg',
    badge: 'badge',
    credits: 'creditsBg',
  };

  function bgFile(channel) {
    return (manifest && manifest.backgrounds && manifest.backgrounds[channel]) || '';
  }

  function assetOf(file) {
    const key = String(file || '').replace(/\.[^.]+$/, '');
    return (manifest && manifest.assets && manifest.assets[key]) || {};
  }

  /**
   * 上背景：先确保 src 已就绪，再淡入。
   * 关键点是不要在视频还没出帧时就开始过渡，否则观感就是硬切。
   */
  function showVideo(channel, overrideFile) {
    const el = els[BG_OF[channel]];
    if (!el) return;
    const key = overrideFile || bgFile(channel);
    if (!key) {
      hideVideo(channel);
      return;
    }
    const asset = assetOf(key);
    const file = asset.file || key;
    const src = '/assets/' + encodeURIComponent(file);
    const changed = el.dataset.src !== src;
    const restart = channel === 'announce' && channels.announce?.playbackId !== announcePlaybackId;
    if (channel === 'announce') announcePlaybackId = channels.announce?.playbackId || '';
    if (changed) {
      el.dataset.src = src;
      el.src = src;
      el.load();
    }
    el.loop = asset.mode !== 'once';
    clearTimeout(el._offTimer);

    const start = () => {
      if (!el.dataset.src) return;
      // 只有重新上屏（当前是暂停状态）才回到开头；
      // 歌词连续下一句时视频仍在播，不要重置时间，否则背景每次都从头放。
      if (el.paused || restart) {
        try {
          el.currentTime = 0;
        } catch {
          /* 元数据还没到时忽略 */
        }
      }
      el.classList.add('on');
      const p = el.play();
      if (p && p.catch) p.catch(() => { /* 自动播放被拦，等下一次操作 */ });
    };

    if (!changed || el.readyState >= 2) start();
    else el.addEventListener('canplay', start, { once: true });
  }

  /**
   * 下背景：先淡出，等过渡结束再暂停。
   * 之前直接 pause() 会让画面停在最后一帧，看起来像瞬间消失。
   */
  function hideVideo(channel) {
    const el = els[BG_OF[channel]];
    if (!el) return;
    el.classList.remove('on');
    const ms = Math.max(0, Number(config.fadeOut) || 0);
    clearTimeout(el._offTimer);
    el._offTimer = setTimeout(() => {
      try {
        el.pause();
      } catch {
        /* 已卸载 */
      }
    }, ms + 40);
  }

  // 预加载所有已绑定的背景，切换时能立刻出帧
  function preloadBackgrounds() {
    for (const ch of Object.keys(BG_OF)) {
      const el = els[BG_OF[ch]];
      const key = bgFile(ch);
      if (!el || !key) continue;
      const asset = assetOf(key);
      const src = '/assets/' + encodeURIComponent(asset.file || key);
      if (el.dataset.src === src) continue;
      el.dataset.src = src;
      el.src = src;
      el.preload = 'auto';
      el.load();
    }
  }

  // 报幕播完：上报服务端，由状态机决定关闭
  const announceVideo = els.announceBg;
  if (announceVideo && !OBSERVER) {
    announceVideo.addEventListener('ended', () => {
      fetch('/api/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'media-ended', channel: 'announce', playbackId: announcePlaybackId }),
      }).catch(() => {});
    });
  }

  // ---------- 歌词（P9） ----------

  let lyricOutTimer = null;

  function renderLyric(text) {
    const box = els.lyricText;
    const inner = document.getElementById('lyricTextInner');
    if (!box || !inner) return;
    // 快照会重复下发同一句，内容没变就别再播一次动效
    if (inner.dataset.text === String(text)) return;
    inner.dataset.text = String(text);

    // 旧句先退场，等退场结束再上下一句，避免两行字叠在一起
    clearTimeout(lyricOutTimer);
    const draw = () => {
      inner.innerHTML = '';
      inner.textContent = text;
      fitText(box, inner);
      const chars = Array.from(text);
      inner.innerHTML = '';
      chars.forEach((ch, i) => {
        const span = document.createElement('span');
        span.className = 'lyric-char';
        span.textContent = ch === ' ' ? '\u00A0' : ch;
        span.style.setProperty('--i', String(i));
        inner.appendChild(span);
      });
      lyricOutTimer = null;
    };

    const oldChars = inner.querySelectorAll('.lyric-char');
    if (oldChars.length) {
      oldChars.forEach((s) => s.classList.add('out'));
      // 300ms：比 charOut 的 260ms 多留一点，保证退场动画走完再换字
      lyricOutTimer = setTimeout(draw, 300);
    } else {
      draw();
    }
  }

  function hideLyric() {
    const box = els.lyricText;
    const inner = document.getElementById('lyricTextInner');
    clearTimeout(lyricOutTimer);
    if (box) box.classList.remove('on');
    if (inner) {
      inner.innerHTML = '';
      delete inner.dataset.text;
    }
  }

  // ---------- 晋级 ----------

  function showQualify(title, text) {
    showVideo('qualify');
    const titleBox = els.qualifyTitle;
    const titleInner = document.getElementById('qualifyTitleInner');
    if (titleBox) titleBox.classList.add('on');
    if (titleInner) {
      titleInner.textContent = title || '晋级';
      fitText(titleBox, titleInner);
    }
    const box = els.qualifyText;
    const inner = document.getElementById('qualifyTextInner');
    if (box) box.classList.add('on');
    if (inner) {
      inner.textContent = text || '';
      fitText(box, inner);
    }
  }

  function hideQualify() {
    hideVideo('qualify');
    els.qualifyTitle && els.qualifyTitle.classList.remove('on');
    els.qualifyText && els.qualifyText.classList.remove('on');
  }

  // ---------- 结尾滚动（P10） ----------

  const creditsState = { on: false, paused: false, offset: 0, speed: 40 };
  let creditsRaf = null;
  let creditsLast = 0;

  function loadCredits() {
    const scroll = document.getElementById('creditsScroll');
    if (!scroll) return Promise.resolve();
    return fetch('/api/credits')
      .then((r) => r.json())
      .then((data) => {
        scroll.innerHTML = '';
        for (const group of data.groups || []) {
          const role = document.createElement('div');
          role.className = 'role';
          role.textContent = group.role;
          scroll.appendChild(role);
          for (const name of group.names || []) {
            const n = document.createElement('div');
            n.className = 'name';
            n.textContent = name;
            scroll.appendChild(n);
          }
        }
        const tail = document.createElement('div');
        tail.style.height = '120px';
        scroll.appendChild(tail);
        applyCreditsStyle();
      })
      .catch(() => {});
  }

  function applyCreditsStyle() {
    const scroll = document.getElementById('creditsScroll');
    const rect = layout.creditsText;
    if (!scroll || !rect) return;
    scroll.style.fontFamily = '"' + (rect.font || 'Shanggu Sans SC') + '", "Shanggu Sans SC", "Microsoft YaHei", sans-serif';
    scroll.style.fontSize = (rect.size || 34) + 'px';
    scroll.style.lineHeight = String(rect.lh || 1.9);
    scroll.style.color = rect.color || '#ffffff';
    scroll.style.textAlign = rect.align || 'center';
    const roles = scroll.querySelectorAll('.role');
    roles.forEach((r) => { r.style.fontSize = Math.round((rect.size || 34) * 0.78) + 'px'; });
    const names = scroll.querySelectorAll('.name');
    names.forEach((n) => { n.style.fontSize = Math.round((rect.size || 34) * 1.12) + 'px'; });
  }

  function creditsHeight() {
    const box = els.creditsText;
    const scroll = document.getElementById('creditsScroll');
    return { boxH: box ? box.clientHeight : 900, scrollH: scroll ? scroll.scrollHeight : 600 };
  }

  function renderCredits() {
    const scroll = document.getElementById('creditsScroll');
    if (!scroll) return;
    const { boxH } = creditsHeight();
    scroll.style.transform = 'translateY(' + (boxH - creditsState.offset) + 'px)';
  }

  function creditsLoop(ts) {
    if (!creditsState.on) {
      creditsRaf = null;
      return;
    }
    if (!creditsLast) creditsLast = ts;
    const dt = Math.min(100, ts - creditsLast);
    creditsLast = ts;
    if (!creditsState.paused) {
      creditsState.offset += creditsState.speed * (dt / 1000);
      const { boxH, scrollH } = creditsHeight();
      if (creditsState.offset > boxH + scrollH + 80) {
        creditsState.paused = true;
        creditsState.offset = boxH + scrollH + 80;
      }
      renderCredits();
    }
    creditsRaf = requestAnimationFrame(creditsLoop);
  }

  function startCredits(speed) {
    creditsState.on = true;
    creditsState.paused = false;
    creditsState.offset = 0;
    creditsState.speed = Number(speed) || 40;
    creditsLast = 0;
    els.creditsText && els.creditsText.classList.add('on');
    showVideo('credits');
    loadCredits().then(() => {
      if (!creditsState.on) return;
      renderCredits();
      if (!creditsRaf) creditsRaf = requestAnimationFrame(creditsLoop);
    });
  }

  function stopCredits() {
    creditsState.on = false;
    creditsRaf = null;
    creditsLast = 0;
    els.creditsText && els.creditsText.classList.remove('on');
    hideVideo('credits');
  }

  // ---------- 状态应用 ----------

  function setText(id, text) {
    const box = els[id];
    if (!box) return;
    const inner = box.querySelector('.text-inner');
    if (!inner) return;
    inner.textContent = text || '';
    fitText(box, inner);
  }

  function applyChannels() {
    const c = channels;
    if (!c) return;
    if (c.announce && c.announce.on) {
      els.announceText && els.announceText.classList.add('on');
      setText('announceText', c.announce.text || '');
      showVideo('announce');
    } else {
      els.announceText && els.announceText.classList.remove('on');
      hideVideo('announce');
    }

    if (c.lyric && c.lyric.on) {
      els.lyricText && els.lyricText.classList.add('on');
      showVideo('lyric');
      // 空行也要走一遍：text 为空表示“待开始”，屏幕上是空的
      renderLyric(c.lyric.text || '');
    } else {
      hideVideo('lyric');
      hideLyric();
    }

    if (c.qualify && c.qualify.on) showQualify(c.qualify.title, c.qualify.text);
    else hideQualify();

    if (c.credits && c.credits.on) startCredits(c.credits.speed);
    else stopCredits();

    if (c.badge && c.badge.on) {
      showVideo('badge');
      els.badge && els.badge.classList.add('on');
    } else {
      hideVideo('badge');
    }
  }

  function onSnapshot(s) {
    layout = s.layout || {};
    manifest = s.manifest || manifest;
    channels = s.channels || {};
    applyConfig(s.config);
    applyLayout();
    preloadBackgrounds();
    applyChannels();
    loadCredits();
  }

  function onCue(msg) {
    const ch = msg.channel;
    const action = msg.action;
    if (!channels[ch]) channels[ch] = {};

    if (ch === 'announce') {
      if (action === 'on' || action === 'cue') {
        Object.assign(channels[ch], {
          on: true,
          playbackId: msg.payload.playbackId,
          text: msg.payload.text != null ? msg.payload.text : (channels[ch].text || ''),
        });
        els.announceText && els.announceText.classList.add('on');
        setText('announceText', channels[ch].text);
        showVideo('announce');
      } else {
        channels[ch].on = false;
        els.announceText && els.announceText.classList.remove('on');
        hideVideo('announce');
      }
      return;
    }

    if (ch === 'lyric') {
      if (action === 'off') {
        channels[ch].on = false;
        hideVideo('lyric');
        hideLyric();
      } else {
        channels[ch].on = true;
        channels[ch].text = msg.payload.text;
        els.lyricText && els.lyricText.classList.add('on');
        showVideo('lyric');
        renderLyric(msg.payload.text || '');
      }
      return;
    }

    if (ch === 'qualify') {
      if (action === 'off') {
        channels[ch].on = false;
        hideQualify();
      } else {
        channels[ch].on = true;
        channels[ch].text = msg.payload.text;
        channels[ch].title = msg.payload.title;
        showQualify(msg.payload.title, msg.payload.text);
      }
      return;
    }

    if (ch === 'credits') {
      if (action === 'off') {
        channels[ch].on = false;
        stopCredits();
      } else if (action === 'pause') {
        channels[ch].paused = true;
        creditsState.paused = true;
      } else if (action === 'resume') {
        channels[ch].paused = false;
        creditsState.paused = false;
      } else {
        channels[ch].on = true;
        startCredits(msg.payload.speed);
      }
      return;
    }

    if (ch === 'badge') {
      if (action === 'off') {
        channels[ch].on = false;
        hideVideo('badge');
      } else {
        channels[ch].on = true;
        showVideo('badge');
      }
      return;
    }

  }

  // ---------- SSE ----------

  function connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => {
      if (CLEAN) return;
      conn.classList.remove('show');
    };
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'snapshot') onSnapshot(msg.state);
      else if (msg.type === 'cue') onCue(msg);
      else if (msg.type === 'layout') {
        layout = msg.layout;
        applyLayout();
      } else if (msg.type === 'config') {
        applyConfig(msg.config);
      } else if (msg.type === 'preview' && PREVIEW) {
        setPreview(msg.ids || msg.id, msg.on, msg.target);
      }
    };
    es.onerror = () => {
      if (CLEAN) return;
      conn.textContent = '与切换台断开，重连中…';
      conn.classList.add('show');
    };
  }

  // ---------- 编辑模式 ----------

  function selectEl(id) {
    if (editSelected && els[editSelected]) els[editSelected].classList.remove('selected');
    editSelected = id;
    if (els[id]) els[id].classList.add('selected');
    updateHud(id);
  }

  // 编组常开：拖背景一定带着同组文字走，避免文字和背景错位
  function groupMates(id) {
    const key = GROUP_OF[id];
    if (!key) return [];
    if (!id.endsWith('Bg')) return [];
    return (GROUPS[key] || []).filter((x) => x !== id);
  }

  function postLayout(items) {
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      const el = els[item.id];
      if (!el) continue;
      const base = layout[item.id] || {};
      Object.assign(item, {
        x: item.x != null ? item.x : (parseFloat(el.style.left) || base.x || 0),
        y: item.y != null ? item.y : (parseFloat(el.style.top) || base.y || 0),
        w: item.w != null ? item.w : (parseFloat(el.style.width) || base.w || 0),
        h: item.h != null ? item.h : (parseFloat(el.style.height) || base.h || 0),
      });
      layout[item.id] = { ...layout[item.id], ...item };
    }
    fetch('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list }),
    }).catch(() => {});
  }

  function initEdit() {
    document.body.classList.add('edit-mode');
    if (CLEAN) document.body.classList.add('clean');

    let drag = null;

    // 用 document 级委托：即使元素被缩放、被盖住，或指针移出元素，
    // 也不会丢掉 pointermove / pointerup。
    document.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const el = e.target && e.target.closest ? e.target.closest('.el') : null;
      if (!el) return;
      const id = el.dataset.el;
      if (!id || !els[id]) return;

      // 不调用 preventDefault：那会阻止 iframe 文档获得焦点，
      // 焦点进不来，方向键微调就收不到 keydown 了。文本选择由
      // edit-mode 下的 user-select:none 处理。
      try {
        window.focus();
      } catch {
        /* 忽略 */
      }
      selectEl(id);

      drag = {
        el,
        id,
        startX: e.clientX,
        startY: e.clientY,
        x0: parseFloat(el.style.left) || 0,
        y0: parseFloat(el.style.top) || 0,
        scale: stageScale(),
        mates: groupMates(id).map((mid) => ({
          id: mid,
          el: els[mid],
          x0: parseFloat(els[mid].style.left) || 0,
          y0: parseFloat(els[mid].style.top) || 0,
        })),
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
    });

    document.addEventListener('pointermove', (e) => {
      if (!drag || !drag.el) return;
      const el = drag.el;
      const s = drag.scale || 1;
      const w = parseFloat(el.style.width) || 0;
      const h = parseFloat(el.style.height) || 0;
      let nx = drag.x0 + (e.clientX - drag.startX) / s;
      let ny = drag.y0 + (e.clientY - drag.startY) / s;
      // 允许负坐标：拖动全屏背景时整块平移，文字跟着走
      nx = Math.min(Math.max(-4000, nx), 4000);
      ny = Math.min(Math.max(-4000, ny), 4000);
      nx = Math.round(nx);
      ny = Math.round(ny);
      const dx = nx - (parseFloat(el.style.left) || 0);
      const dy = ny - (parseFloat(el.style.top) || 0);
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
      layout[drag.id] = { ...layout[drag.id], x: nx, y: ny, w, h };
      for (const mate of drag.mates) {
        if (!mate.el) continue;
        const mx = Math.round((parseFloat(mate.el.style.left) || 0) + dx);
        const my = Math.round((parseFloat(mate.el.style.top) || 0) + dy);
        mate.el.style.left = mx + 'px';
        mate.el.style.top = my + 'px';
        layout[mate.id] = { ...layout[mate.id], x: mx, y: my };
      }
      updateHud(drag.id);
    });

    const finish = (e) => {
      if (!drag) return;
      const el = drag.el;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
      const items = [{ id: drag.id }].concat(drag.mates.map((m) => ({ id: m.id })));
      drag = null;
      postLayout(items);
    };
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);

    document.addEventListener('keydown', (e) => {
      if (!editSelected || !els[editSelected]) return;
      const el = els[editSelected];
      const step = e.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      const w = parseFloat(el.style.width) || 0;
      const h = parseFloat(el.style.height) || 0;
      const nx = Math.min(Math.max(-4000, (parseFloat(el.style.left) || 0) + dx), 4000);
      const ny = Math.min(Math.max(-4000, (parseFloat(el.style.top) || 0) + dy), 4000);
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
      layout[editSelected] = { ...layout[editSelected], x: nx, y: ny, w, h };
      updateHud(editSelected);
    });

    document.addEventListener('keyup', (e) => {
      if (!editSelected) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        postLayout({ id: editSelected });
      }
    });
  }

  // ---------- 启动 ----------

  if (CLEAN) document.body.classList.add('clean');
  fitStage();
  if (EDIT) initEdit();
  connect();
})();
