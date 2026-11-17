'use strict';
/**
 * 深秋歌会 · 编辑页
 * 先选部件（报幕/歌词/晋级/结尾/角标），再分别改它的「背景」和「文字」。
 * 背景：素材、位置、大小、等比缩放。
 * 文字：位置、大小、字体字号（字号即大小，不再叠加缩放）。
 * 「显示」只在 ?preview=1 的预监里生效，不影响 vMix 的正式上屏。
 */
(function () {
  const $ = (s) => document.querySelector(s);

  const PARTS = [
    { key: 'announce', label: '报幕', note: '背景 + 文字', bg: 'announceBg', texts: ['announceText'] },
    { key: 'lyric', label: '歌词', note: '背景 + 文字', bg: 'lyricBg', texts: ['lyricText'] },
    { key: 'qualify', label: '晋级', note: '背景 + 标题 / 内容', bg: 'qualifyBg', texts: ['qualifyTitle', 'qualifyText'] },
    { key: 'credits', label: '结尾', note: '背景 + 文字', bg: 'creditsBg', texts: ['creditsText'] },
    { key: 'badge', label: '角标', note: '全屏飞入', bg: 'badge', texts: [] },
  ];

  const DEFAULT_RECT = {
    announceBg: { x: 0, y: 0, w: 1920, h: 1080 },
    announceText: { x: 330, y: 650, w: 550, h: 270 },
    lyricBg: { x: 0, y: 0, w: 1920, h: 1080 },
    lyricText: { x: 510, y: 700, w: 900, h: 210 },
    qualifyBg: { x: 1010, y: 250, w: 760, h: 420 },
    qualifyTitle: { x: 1020, y: 262, w: 740, h: 72 },
    qualifyText: { x: 1020, y: 344, w: 740, h: 300 },
    creditsBg: { x: 0, y: 0, w: 1920, h: 1080 },
    creditsText: { x: 560, y: 90, w: 800, h: 900 },
    badge: { x: 0, y: 0, w: 1920, h: 1080 },
  };

  const DEFAULT_STYLE = {
    announceText: { size: 52, weight: 700, lh: 1.2 },
    lyricText: { size: 60, weight: 700, lh: 1.2 },
    qualifyTitle: { size: 38, weight: 700, lh: 1.2 },
    qualifyText: { size: 48, weight: 700, lh: 1.2 },
    creditsText: { size: 34, weight: 700, lh: 1.9 },
  };

  const FONTS = [
    'Shanggu Sans SC',
    'Microsoft YaHei',
    'SimHei',
    'SimSun',
    'KaiTi',
    'FangSong',
    'Source Han Sans SC',
    'Noto Sans SC',
    'Arial',
    'Segoe UI',
  ];

  let state = null;
  let layout = {};
  let selected = 'announce';
  let curTextIdx = 0;
  let editing = false;
  let showBg = false;
  let showText = false;
  let bgTimer = null;
  let textTimer = null;

  function toast(text, bad) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2000);
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function part() {
    return PARTS.find((p) => p.key === selected) || PARTS[0];
  }

  // 当前正在编辑的文字元素：晋级有“标题 / 内容”两个
  function textId() {
    const p = part();
    return p.texts[curTextIdx] || null;
  }

  function family() {
    return (state && state.config && state.config.font && state.config.font.family) || 'Microsoft YaHei';
  }

  function rectOf(id) {
    const r = layout[id] || {};
    const d = DEFAULT_RECT[id] || { x: 0, y: 0, w: 100, h: 100 };
    return {
      x: r.x != null ? r.x : d.x,
      y: r.y != null ? r.y : d.y,
      w: r.w != null ? r.w : d.w,
      h: r.h != null ? r.h : d.h,
      scale: r.scale != null ? r.scale : 1,
    };
  }

  function setVal(sel, v) {
    const el = $(sel);
    if (el && document.activeElement !== el) el.value = v;
  }

  // ---------- 渲染 ----------

  function renderPicker() {
    const box = $('#objPicker');
    box.innerHTML = '';
    for (const p of PARTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'obj-btn' + (p.key === selected ? ' active' : '');
      b.dataset.id = p.key;
      b.innerHTML = '<b>' + esc(p.label) + '</b><span>' + esc(p.note) + '</span>';
      b.addEventListener('click', () => select(p.key));
      box.appendChild(b);
    }
  }

  function renderBg() {
    const p = part();
    const r = rectOf(p.bg);
    setVal('#bgX', r.x);
    setVal('#bgY', r.y);
    setVal('#bgW', r.w);
    setVal('#bgH', r.h);
    const pct = Math.round((r.scale || 1) * 100);
    setVal('#inScale', pct);
    setVal('#inScaleNum', pct);

    const sel = $('#bgSelect');
    const assets = (state && state.assets) || [];
    const cur = (state && state.config && state.config.backgrounds && state.config.backgrounds[p.key]) || '';
    const opts = ['<option value="">（无背景）</option>'].concat(
      assets.map((a) => '<option value="' + esc(a.file) + '">' +
        esc(a.key + (a.builtin ? ' · 内置' : ' · 导入')) + '</option>')
    );
    sel.innerHTML = opts.join('');
    sel.value = cur;

    $('#btnPreviewBg').textContent = editing ? '重新显示' : (showBg ? '隐藏' : '显示');
    $('#bgMeta').textContent = p.texts.length
      ? '背景与文字分开设置：这里只调背景，文字在下面「文字」卡里。'
      : '角标是整屏飞入动画，位置和大小一般保持铺满；缩放可整体放大缩小。';
  }

  // 晋级有两个文字元素，用一排小标签切换
  function renderSubtabs() {
    const p = part();
    const box = $('#textSubtabs');
    if (!box) return;
    box.hidden = p.texts.length < 2;
    if (box.hidden) return;
    box.innerHTML = '';
    const names = { qualifyTitle: '标题', qualifyText: '内容' };
    p.texts.forEach((id, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'subtab-btn' + (i === curTextIdx ? ' active' : '');
      b.textContent = names[id] || id;
      b.addEventListener('click', () => {
        curTextIdx = i;
        showText = false;
        renderText();
        renderSubtabs();
        if (editing) {
          const cur = textId();
          if (cur) solo([cur], true, cur);
        }
      });
      box.appendChild(b);
    });
  }

  function renderText() {
    const p = part();
    const id = textId();
    const hasText = !!id;
    $('#textCard').hidden = !hasText;
    renderSubtabs();
    if (!hasText) return;

    const r = rectOf(id);
    setVal('#txX', r.x);
    setVal('#txY', r.y);
    setVal('#txW', r.w);
    setVal('#txH', r.h);

    const st = layout[id] || {};
    const d = DEFAULT_STYLE[id] || { size: 52, weight: 700, lh: 1.2 };
    setVal('#tyFont', st.font || family());
    setVal('#tySize', st.size != null ? st.size : d.size);
    setVal('#tyWeight', String(st.weight || d.weight));
    setVal('#tyLh', st.lh != null ? st.lh : d.lh);
    setVal('#tyColor', st.color || '#ffffff');
    const hex = $('#tyColorHex');
    if (hex) hex.textContent = (st.color || '#ffffff').toUpperCase();
    setVal('#tyAlign', st.align || 'center');
    const shadow = $('#tyShadow');
    if (shadow) shadow.checked = st.shadow !== false;

    // 阴影
    setVal('#tyShadowBlur', st.shadowBlur != null ? st.shadowBlur : 10);
    setVal('#tyShadowX', st.shadowX != null ? st.shadowX : 0);
    setVal('#tyShadowY', st.shadowY != null ? st.shadowY : 3);
    setVal('#tyShadowOpacity', st.shadowOpacity != null ? st.shadowOpacity : 55);
    setVal('#tyShadowColor', toHexColor(st.shadowColor, '#000000'));
    // 发光
    const glow = $('#tyGlow');
    if (glow) glow.checked = !!st.glow;
    setVal('#tyGlowBlur', st.glowBlur != null ? st.glowBlur : 24);
    setVal('#tyGlowOpacity', st.glowOpacity != null ? st.glowOpacity : 35);
    setVal('#tyGlowColor', toHexColor(st.glowColor, '#ffffff'));

    $('#btnPreviewText').textContent = editing ? '重新显示' : (showText ? '隐藏' : '显示');
  }

  /** <input type="color"> 只认 #rrggbb，历史数据可能带别的写法，做个兜底 */
  function toHexColor(value, fallback) {
    const s = String(value || '');
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    }
    return fallback;
  }

  function render() {
    renderPicker();
    renderBg();
    renderText();
  }

  // ---------- 预览 ----------

  async function solo(ids, on, target) {
    try {
      await api('/api/preview', { ids, on, target });
    } catch (err) {
      toast('预览失败：' + err.message, true);
    }
  }

  async function showCurrent() {
    if (!editing) return;
    const p = part();
    const ids = [p.bg].concat(p.texts).filter(Boolean);
    showBg = true;
    showText = p.texts.length > 0;
    // target 告诉预监「现在编辑的是哪一个」，让它在画面里自动选中
    const target = p.texts.length ? textId() : p.bg;
    await solo(ids, true, target);
    renderBg();
    renderText();
  }

  function select(key) {
    if (selected === key) return;
    selected = key;
    curTextIdx = 0;
    showBg = false;
    showText = false;
    render();
    if (editing) showCurrent();
  }

  // ---------- 提交 ----------

  async function submitBg() {
    const p = part();
    const body = {
      id: p.bg,
      x: Number($('#bgX').value),
      y: Number($('#bgY').value),
      w: Number($('#bgW').value),
      h: Number($('#bgH').value),
      scale: Number($('#inScaleNum').value) / 100,
    };
    try {
      const res = await api('/api/layout', body);
      if (res.layout) {
        layout = res.layout;
        renderBg();
      }
    } catch (err) {
      toast('保存背景失败：' + err.message, true);
    }
  }

  async function submitText() {
    const id = textId();
    if (!id) return;
    const body = {
      id,
      x: Number($('#txX').value),
      y: Number($('#txY').value),
      w: Number($('#txW').value),
      h: Number($('#txH').value),
      font: $('#tyFont').value,
      size: Number($('#tySize').value),
      weight: Number($('#tyWeight').value),
      lh: Number($('#tyLh').value),
      color: $('#tyColor').value,
      align: $('#tyAlign').value,
      shadow: $('#tyShadow').checked,
      shadowBlur: Number($('#tyShadowBlur').value),
      shadowX: Number($('#tyShadowX').value),
      shadowY: Number($('#tyShadowY').value),
      shadowOpacity: Number($('#tyShadowOpacity').value),
      shadowColor: $('#tyShadowColor').value,
      glow: $('#tyGlow').checked,
      glowBlur: Number($('#tyGlowBlur').value),
      glowOpacity: Number($('#tyGlowOpacity').value),
      glowColor: $('#tyGlowColor').value,
    };
    try {
      const res = await api('/api/layout', body);
      if (res.layout) {
        layout = res.layout;
        renderText();
      }
    } catch (err) {
      toast('保存文字失败：' + err.message, true);
    }
  }

  function queueBg() {
    clearTimeout(bgTimer);
    bgTimer = setTimeout(submitBg, 260);
  }

  function queueText() {
    clearTimeout(textTimer);
    textTimer = setTimeout(submitText, 260);
  }

  // ---------- 事件 ----------

  function connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => {
      const pill = $('#conn');
      pill.textContent = '已连接';
      pill.classList.add('ok');
    };
    es.onerror = () => {
      const pill = $('#conn');
      pill.textContent = '断开，重连中…';
      pill.classList.remove('ok');
    };
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'snapshot') {
        state = msg.state || msg;
        layout = state.layout || {};
        render();
      } else if (msg.type === 'layout') {
        layout = msg.layout || layout;
        renderBg();
        renderText();
      }
    };
  }

  function initEdit() {
    const frame = $('#preview');
    const btn = $('#btnEdit');
    btn.addEventListener('click', async () => {
      editing = !editing;
      const url = editing
        ? '/graphics.html?preview=1&edit=1&clean=1&t=' + Date.now()
        : '/graphics.html?preview=1&clean=1&t=' + Date.now();
      frame.src = url;
      btn.textContent = editing ? '退出编辑' : '编辑位置';
      btn.classList.toggle('primary', editing);
      $('#hint').textContent = editing
        ? '正在编辑：画面里只显示当前部件，拖动它或用方向键微调（Shift 10px）。'
        : '点「编辑位置」后，画面只显示当前部件，可直接拖动。';
      if (editing) {
        setTimeout(showCurrent, 350);
      } else {
        showBg = false;
        showText = false;
        const p = part();
        solo([p.bg, p.text].filter(Boolean), false);
        render();
      }
    });
    frame.addEventListener('load', () => {
      if (editing) setTimeout(showCurrent, 250);
    });
  }

  // ---------- 启动 ----------

  async function boot() {
    $('#tyFont').innerHTML = FONTS.map(
      (f) => '<option value="' + esc(f) + '">' + esc(f) + '</option>'
    ).join('');

    try {
      state = await api('/api/state');
      layout = state.layout || {};
    } catch {
      toast('读取状态失败', true);
    }
    render();
    connect();
    initEdit();

    // 背景
    for (const sel of ['#bgX', '#bgY', '#bgW', '#bgH']) {
      $(sel).addEventListener('input', queueBg);
    }
    $('#inScale').addEventListener('input', () => {
      $('#inScaleNum').value = $('#inScale').value;
      queueBg();
    });
    $('#inScaleNum').addEventListener('input', () => {
      $('#inScale').value = $('#inScaleNum').value;
      queueBg();
    });
    $('#btnScaleReset').addEventListener('click', () => {
      $('#inScale').value = '100';
      $('#inScaleNum').value = '100';
      queueBg();
    });
    $('#bgSelect').addEventListener('change', async (e) => {
      const p = part();
      try {
        await api('/api/backgrounds', { channel: p.key, file: e.target.value });
        state = await api('/api/state');
        layout = state.layout || {};
        render();
        if (editing) {
          showBg = true;
          solo([p.bg], true, p.bg);
        }
      } catch (err) {
        toast('切换背景失败：' + err.message, true);
      }
    });
    $('#btnPreviewBg').addEventListener('click', () => {
      if (editing) {
        showBg = true;
        solo([part().bg], true, part().bg);
        renderBg();
        return;
      }
      showBg = !showBg;
      solo([part().bg], showBg);
      renderBg();
    });
    $('#btnFillBg').addEventListener('click', async () => {
      try {
        // 铺满 = 占满 1920×1080 且缩放回到 1:1（100%），两步一起提交
        const res = await api('/api/layout', { id: part().bg, x: 0, y: 0, w: 1920, h: 1080, scale: 1 });
        if (res.layout) { layout = res.layout; renderBg(); }
      } catch (err) {
        toast('铺满失败：' + err.message, true);
      }
    });
    $('#btnResetBg').addEventListener('click', async () => {
      const d = DEFAULT_RECT[part().bg];
      try {
        const res = await api('/api/layout', { id: part().bg, ...d, scale: 1 });
        if (res.layout) { layout = res.layout; renderBg(); }
      } catch (err) {
        toast('复位失败：' + err.message, true);
      }
    });

    // 文字
    for (const sel of ['#txX', '#txY', '#txW', '#txH', '#tySize', '#tyLh', '#tyColor']) {
      $(sel).addEventListener('input', queueText);
    }
    for (const sel of ['#tyFont', '#tyWeight', '#tyAlign', '#tyShadow', '#tyGlow']) {
      $(sel).addEventListener('change', queueText);
    }
    // 阴影 / 发光的数值与颜色：改一下就预览
    for (const sel of ['#tyShadowBlur', '#tyShadowX', '#tyShadowY', '#tyShadowOpacity',
      '#tyShadowColor', '#tyGlowBlur', '#tyGlowOpacity', '#tyGlowColor']) {
      $(sel).addEventListener('input', queueText);
    }
    // 颜色：色块变化时同步右侧的十六进制值
    $('#tyColor').addEventListener('input', () => {
      const hex = $('#tyColorHex');
      if (hex) hex.textContent = $('#tyColor').value.toUpperCase();
    });
    $('#btnPreviewText').addEventListener('click', () => {
      const id = textId();
      if (!id) return;
      if (editing) {
        showText = true;
        solo([id], true, id);
        renderText();
        return;
      }
      showText = !showText;
      solo([id], showText);
      renderText();
    });
    $('#btnFillText').addEventListener('click', async () => {
      const id = textId();
      if (!id) return;
      try {
        const res = await api('/api/layout', { id, x: 0, y: 0, w: 1920, h: 1080 });
        if (res.layout) { layout = res.layout; renderText(); }
      } catch (err) {
        toast('铺满失败：' + err.message, true);
      }
    });
    $('#btnResetText').addEventListener('click', async () => {
      const id = textId();
      if (!id) return;
      const d = DEFAULT_RECT[id];
      try {
        const res = await api('/api/layout', { id, ...d });
        if (res.layout) { layout = res.layout; renderText(); }
      } catch (err) {
        toast('复位失败：' + err.message, true);
      }
    });

    // 方向键微调：焦点在右侧面板时也能用。
    // （焦点在输入框里时不拦截，交给浏览器做数值 +/-）
    let lastCard = 'text';
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#bgCard')) lastCard = 'bg';
      else if (t.closest('#textCard')) lastCard = 'text';
    });
    document.addEventListener('keydown', (e) => {
      const arrows = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const dir = arrows[e.key];
      if (!dir) return;
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = dir[0] * step;
      const dy = dir[1] * step;
      const clampPos = (v) => Math.min(Math.max(-4000, Math.round(v)), 4000);
      if (lastCard === 'bg') {
        $('#bgX').value = clampPos(Number($('#bgX').value) + dx);
        $('#bgY').value = clampPos(Number($('#bgY').value) + dy);
        queueBg();
      } else {
        if (!textId()) return;
        $('#txX').value = clampPos(Number($('#txX').value) + dx);
        $('#txY').value = clampPos(Number($('#txY').value) + dy);
        queueText();
      }
    });

    $('#btnReload').addEventListener('click', () => location.reload());
    $('#btnResetAll').addEventListener('click', async () => {
      if (!confirm('把所有元素的位置和大小恢复默认？字体设置不受影响。')) return;
      try {
        const res = await api('/api/layout/reset', {});
        if (res.layout) {
          layout = res.layout;
          render();
        }
        toast('已恢复默认位置');
      } catch (err) {
        toast('恢复失败：' + err.message, true);
      }
    });
  }

  boot();
})();
