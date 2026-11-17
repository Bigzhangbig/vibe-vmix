'use strict';
/**
 * 深秋歌会 · 导入素材（P16 素材管线 + P14 背景绑定）
 * 这里只负责「有哪些素材」和「哪个部件用哪个素材」。
 * 位置、大小、缩放在「编辑」页按部件分别调，同一个素材可以有多套设置。
 */
(function () {
  const $ = (s) => document.querySelector(s);

  const CHANNELS = [
    ['announce', '报幕', 'announceBg'],
    ['lyric', '歌词', 'lyricBg'],
    ['qualify', '晋级', 'qualifyBg'],
    ['badge', '角标', 'badge'],
    ['credits', '结尾', 'creditsBg'],
  ];

  let assets = [];
  let backgrounds = {};
  let previewId = null;

  function toast(text, bad) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function fmtBytes(n) {
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  function isVideo(file) {
    return /\.(webm|mp4|mov)$/i.test(file);
  }

  // ---------- 素材列表 ----------

  function renderAssets() {
    const box = $('#assetList');
    box.innerHTML = '';
    if (!assets.length) {
      box.innerHTML = '<p class="hint">还没有素材。点「导入素材」支持 PNG、WebM、MP4。</p>';
      return;
    }
    for (const a of assets) {
      const row = document.createElement('div');
      row.className = 'asset-item';
      row.dataset.file = a.file;

      const thumb = document.createElement('div');
      thumb.className = 'asset-thumb';
      if (isVideo(a.file)) {
        const v = document.createElement('video');
        v.src = a.url;
        v.muted = true;
        v.playsInline = true;
        v.preload = 'metadata';
        thumb.appendChild(v);
      } else {
        const img = document.createElement('img');
        img.src = a.url;
        img.alt = a.file;
        thumb.appendChild(img);
      }

      const meta = document.createElement('div');
      meta.className = 'asset-meta';
      meta.innerHTML =
        '<strong>' + a.file + '</strong>' +
        '<span>' + (a.builtin ? '内置' : '导入') + ' · ' + fmtBytes(a.bytes) + '</span>';

      const acts = document.createElement('div');
      acts.className = 'asset-acts';
      for (const [ch, label] of CHANNELS) {
        if (backgrounds[ch] === a.file) {
          const badge = document.createElement('span');
          badge.className = 'tag on';
          badge.textContent = label;
          acts.appendChild(badge);
        }
      }
      if (!a.builtin) {
        const del = document.createElement('button');
        del.className = 'mini ghost';
        del.textContent = '删除';
        del.addEventListener('click', async () => {
          if (!confirm('删除素材 ' + a.file + '？绑定它的通道会被清空。')) return;
          try {
            await api('/api/assets/delete', { file: a.file });
            toast('已删除');
            load();
          } catch (err) {
            toast('删除失败：' + err.message, true);
          }
        });
        acts.appendChild(del);
      }

      row.appendChild(thumb);
      row.appendChild(meta);
      row.appendChild(acts);
      box.appendChild(row);
    }
  }

  // ---------- 通道绑定 ----------

  function renderBgTable() {
    const box = $('#bgTable');
    box.innerHTML = '';
    for (const [ch, label, elId] of CHANNELS) {
      const row = document.createElement('div');
      row.className = 'bg-row';

      const name = document.createElement('label');
      name.textContent = label;

      const select = document.createElement('select');
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '（无背景）';
      select.appendChild(none);
      for (const a of assets) {
        const opt = document.createElement('option');
        opt.value = a.file;
        opt.textContent = a.file + (a.builtin ? '（内置）' : '');
        select.appendChild(opt);
      }
      select.value = backgrounds[ch] || '';
      select.addEventListener('change', async () => {
        try {
          const res = await api('/api/backgrounds', { channel: ch, file: select.value });
          backgrounds = res.backgrounds;
          toast(label + ' 背景：' + (select.value || '无'));
          renderAssets();
        } catch (err) {
          toast('设置失败：' + err.message, true);
        }
      });

      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'mini ghost' + (previewId === elId ? ' onair' : '');
      show.textContent = previewId === elId ? '隐藏' : '显示';
      show.title = '在预监里临时显示' + label + '背景';
      show.addEventListener('click', () => {
        togglePreview(elId).catch((err) => toast('预览失败：' + err.message, true));
      });

      row.appendChild(name);
      row.appendChild(select);
      row.appendChild(show);
      box.appendChild(row);
    }
  }

  /** 预监「显示」：只在 ?preview=1 的预监窗口里点亮，不影响上屏。 */
  async function togglePreview(id) {
    const on = previewId !== id;
    if (previewId && previewId !== id) {
      await api('/api/preview', { ids: [previewId], on: false });
      previewId = null;
    }
    if (on) {
      await api('/api/preview', { ids: [id], on: true });
      previewId = id;
    } else {
      await api('/api/preview', { ids: [id], on: false });
      previewId = null;
    }
    renderBgTable();
  }

  // ---------- 上传 ----------

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('读取失败'));
      reader.readAsDataURL(file);
    });
  }

  async function upload(files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      $('#uploadState').textContent = '正在导入 ' + (i + 1) + '/' + files.length + '：' + file.name;
      try {
        const dataUrl = await readFile(file);
        await api('/api/assets/import', { name: file.name, dataUrl });
      } catch (err) {
        toast('导入失败：' + file.name + '，' + err.message, true);
      }
    }
    $('#uploadState').textContent = '';
    toast('导入完成');
    load();
  }

  // ---------- 加载 ----------

  async function load() {
    try {
      const data = await api('/api/assets');
      assets = data.assets || [];
      backgrounds = data.backgrounds || {};
      renderAssets();
      renderBgTable();
    } catch (err) {
      toast('读取素材失败：' + err.message, true);
    }
  }

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
        backgrounds = (msg.state && msg.state.manifest && msg.state.manifest.backgrounds) || backgrounds;
      }
    };
  }

  async function boot() {
    $('#fileInput').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) upload(files);
      e.target.value = '';
    });
    $('#btnReload').addEventListener('click', load);
    await load();
    connect();
  }

  boot();
})();
