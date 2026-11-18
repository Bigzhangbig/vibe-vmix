'use strict';
/**
 * 深秋歌会 · 编辑页
 * 先选部件（报幕/歌词/晋级/结尾/角标），再分别改它的「背景」和「文字」。
 * 背景：素材、位置、大小、等比缩放。
 * 文字：位置、大小、字体字号（字号即大小，不再叠加缩放）。
 * 「显示」只控制本页画布，不影响 vMix 的正式上屏。
 */
(function () {
  const $ = (s) => document.querySelector(s);

  const PARTS = [
    { key: 'announce', label: '报幕', note: '背景 + 四个文本框', bg: 'announceBg', texts: ['announceHeader', 'announceTitle', 'announcePerformer', 'announceNote', 'announceText'] },
    { key: 'lyric', label: '歌词', note: '背景 + 文字', bg: 'lyricBg', texts: ['lyricText'] },
    { key: 'qualify', label: '晋级', note: '背景 + 标题 / 内容', bg: 'qualifyBg', texts: ['qualifyTitle', 'qualifyText'] },
    { key: 'credits', label: '结尾', note: '背景 + 文字', bg: 'creditsBg', texts: ['creditsText'] },
    { key: 'badge', label: '角标', note: '全屏飞入', bg: 'badge', texts: [] },
  ];

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
  let curTextIdx = 1;
  let editing = false;
  let previewTarget = 'announceTitle';
  let lastPreset = null;
  const hiddenPreview = new Set();
  const pendingLayout = new Map();

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
    const r = layoutOf(id);
    const d = state?.layoutDefaults?.[id] || { x: 0, y: 0, w: 100, h: 100 };
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

  function layoutOf(id) {
    return { ...layout[id], ...pendingLayout.get(id)?.body };
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

    $('#btnPreviewBg').textContent = hiddenPreview.has(p.bg) ? '显示' : '隐藏';
    $('#bgMeta').textContent = p.texts.length
      ? '背景与文字分开设置：这里只调背景，文字在下面「文字」卡里。'
      : '角标是整屏飞入动画，位置和大小一般保持铺满；缩放可整体放大缩小。';
  }

  // 在同一部件的多个文本框之间切换
  function renderSubtabs() {
    const p = part();
    const box = $('#textSubtabs');
    if (!box) return;
    box.hidden = p.texts.length < 2;
    if (box.hidden) return;
    box.innerHTML = '';
    const names = {
      announceHeader: '场次', announceTitle: '曲名', announcePerformer: '表演者',
      announceNote: '补充说明', announceText: '旧版合并文字', qualifyTitle: '标题', qualifyText: '内容',
    };
    p.texts.forEach((id, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'subtab-btn' + (i === curTextIdx ? ' active' : '');
      b.textContent = names[id] || id;
      b.setAttribute('aria-pressed', String(i === curTextIdx));
      b.addEventListener('click', () => chooseText(i));
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

    const st = layoutOf(id);
    const d = state?.layoutDefaults?.[id] || { size: 52, weight: 700, lh: 1.2 };
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

    $('#btnPreviewText').textContent = hiddenPreview.has(id) ? '显示' : '隐藏';
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
    renderPlacement();
  }

  // ---------- 预览 ----------

  function renderPlacement() {
    const placement = state?.announcePlacement || 'lower-left';
    if (state?.announcePresets?.[placement]) lastPreset = placement;
    $('#announcePresetField').hidden = selected !== 'announce';
    $('#announcePreset').value = placement;
  }

  function syncPreview() {
    const p = part();
    const texts = p.key !== 'announce' ? p.texts : textId() === 'announceText'
      ? ['announceText'] : p.texts.filter((id) => id !== 'announceText');
    const ids = [p.bg, ...texts].filter((id) => !hiddenPreview.has(id));
    $('#preview').contentWindow.postMessage({
      type: 'concert-layout-preview', ids, target: previewTarget, editing,
    }, location.origin);
  }

  function syncCanvasState() {
    if (!state) return;
    const { config, manifest } = state;
    $('#preview').contentWindow.postMessage({
      type: 'concert-layout-data', state: { layout, config, manifest },
    }, location.origin);
  }

  function chooseText(i) {
    curTextIdx = i;
    previewTarget = textId();
    hiddenPreview.delete(previewTarget);
    renderText();
    syncPreview();
  }

  function togglePreview(id, renderCard) {
    if (!id) return;
    if (hiddenPreview.delete(id)) previewTarget = id;
    else hiddenPreview.add(id);
    renderCard();
    syncPreview();
  }

  function select(key) {
    if (selected === key) return;
    selected = key;
    curTextIdx = key === 'announce' ? 1 : 0;
    previewTarget = textId() || part().bg;
    render();
    syncPreview();
  }

  // ---------- 提交 ----------

  function queueBg() {
    queueLayout({
      id: part().bg,
      x: Number($('#bgX').value),
      y: Number($('#bgY').value),
      w: Number($('#bgW').value),
      h: Number($('#bgH').value),
      scale: Number($('#inScaleNum').value) / 100,
    });
  }

  function queueText() {
    const id = textId();
    if (!id) return;
    queueLayout({
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
    });
  }

  function queueLayout(body) {
    // 快速切换对象时仍将修改写回输入时的对象。
    clearTimeout(pendingLayout.get(body.id)?.timer);
    pendingLayout.set(body.id, { body, timer: setTimeout(() => savePending(body.id), 260) });
  }

  async function savePending(id) {
    const entry = pendingLayout.get(id);
    if (!entry) return;
    pendingLayout.delete(id);
    clearTimeout(entry.timer);
    try {
      applySavedLayout(await api('/api/layout', entry.body));
    } catch (err) {
      toast('保存位置或样式失败：' + err.message, true);
    }
  }

  function applySavedLayout(result) {
    if (result.layout) layout = result.layout;
    if (state && result.announcePlacement) state.announcePlacement = result.announcePlacement;
    renderBg();
    renderText();
    renderPlacement();
    syncCanvasState();
  }

  function resetPreset(id) {
    const presets = state?.announcePresets;
    if (!presets || !Object.hasOwn(presets['lower-left'], id)) return null;
    if (lastPreset) return presets[lastPreset][id];
    // On reopening a custom layout, use the remaining unedited elements to
    // identify the preset. Never reset a center box to the lower-left by guess.
    const candidates = Object.values(presets).filter((preset) =>
      Object.entries(preset).some(([key, rect]) => key !== id &&
        ['x', 'y', 'w', 'h'].every((prop) => layout[key]?.[prop] === rect[prop])),
    );
    if (candidates.length === 1) return candidates[0][id];
    throw new Error('请先选择「居中」或「左下角」作为复位基准');
  }

  async function resetPosition(id, geometry, background = false) {
    if (!id) return;
    try {
      const d = geometry || resetPreset(id) || state?.layoutDefaults?.[id];
      if (!d) return;
      await savePending(id);
      const { x, y, w, h } = d;
      applySavedLayout(await api('/api/layout', { id, x, y, w, h, ...(background ? { scale: 1 } : {}) }));
    } catch (err) {
      toast('调整位置失败：' + err.message, true);
    }
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
        syncCanvasState();
      } else if (msg.type === 'layout') {
        applySavedLayout(msg);
      } else if (msg.type === 'config' && state) {
        state.config = { ...state.config, ...msg.config };
        renderBg();
        syncCanvasState();
      }
    };
  }

  function initEdit() {
    const frame = $('#preview');
    const btn = $('#btnEdit');
    function syncCanvas() {
      syncCanvasState();
      syncPreview();
    }
    btn.addEventListener('click', () => {
      editing = !editing;
      btn.textContent = editing ? '退出编辑' : '编辑位置';
      btn.classList.toggle('primary', editing);
      btn.setAttribute('aria-pressed', String(editing));
      $('#hint').textContent = editing
        ? '拖动选中的框，或用方向键移动 1 px（按住 Shift 移动 10 px）。布局修改会保存。'
        : '此处显示排版示例。点「编辑位置」可拖动文字框和背景。';
      syncPreview();
    });
    frame.addEventListener('load', syncCanvas);
    window.addEventListener('message', ({ source, origin, data }) => {
      if (source !== frame.contentWindow || origin !== location.origin) return;
      if (data?.type === 'concert-layout-ready') syncCanvas();
      if (data?.type === 'concert-layout-select' && editing) {
        const index = part().texts.indexOf(data.id);
        if (index >= 0) {
          curTextIdx = index;
          renderText();
        }
        previewTarget = data.id;
      }
    });
    syncCanvas();
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
        syncCanvasState();
        hiddenPreview.delete(p.bg);
        syncPreview();
      } catch (err) {
        toast('切换背景失败：' + err.message, true);
      }
    });
    $('#btnPreviewBg').addEventListener('click', () => togglePreview(part().bg, renderBg));
    $('#btnFillBg').addEventListener('click', () => resetPosition(part().bg, { x: 0, y: 0, w: 1920, h: 1080 }, true));
    $('#btnResetBg').addEventListener('click', () => resetPosition(part().bg, null, true));

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
    $('#btnPreviewText').addEventListener('click', () => togglePreview(textId(), renderText));
    $('#btnFillText').addEventListener('click', () => resetPosition(textId(), { x: 0, y: 0, w: 1920, h: 1080 }));
    $('#btnResetText').addEventListener('click', () => resetPosition(textId()));
    $('#announcePreset').addEventListener('change', async (event) => {
      const placement = event.target.value;
      await Promise.all([...pendingLayout.keys()].map(savePending));
      try {
        applySavedLayout(await api('/api/layout/preset', { placement }));
      } catch (err) {
        renderPlacement();
        toast('切换报幕位置失败：' + err.message, true);
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
      if (!editing) return;
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
      if (!confirm('把所有元素的位置、大小和文字样式恢复默认？')) return;
      await Promise.all([...pendingLayout.keys()].map(savePending));
      try {
        applySavedLayout(await api('/api/layout/reset', {}));
        toast('已恢复默认位置');
      } catch (err) {
        toast('恢复失败：' + err.message, true);
      }
    });
  }

  boot();
})();
