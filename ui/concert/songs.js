'use strict';
/**
 * 深秋歌会 · 歌曲页（曲目信息 + 歌词 txt 导入）
 */
(function () {
  const $ = (s) => document.querySelector(s);

  let doc = { songs: [], currentId: '' };
  let selectedId = '';

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
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  function selected() {
    return doc.songs.find((s) => s.id === selectedId) || null;
  }

  // 空行保留：歌词里用空行做句间留白，上屏时显示为空而不是跳过。
  // 去尾空行与 [注释] 标注行；首行固定留一个空行（报幕后先空屏）。
  function splitLyrics(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => !/^[\[【(（]/.test(line));
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return [''].concat(lines);
  }

  // ---------- 列表 ----------

  function renderList() {
    const box = $('#songList');
    box.innerHTML = '';
    if (!doc.songs.length) {
      box.innerHTML = '<p class="hint">还没有曲目。点「新建」开始，或先导入歌词 txt。</p>';
      return;
    }
    const rounds = [];
    for (const s of doc.songs) {
      const r = s.round || '未分组';
      if (!rounds.includes(r)) rounds.push(r);
    }
    for (const r of rounds) {
      const head = document.createElement('div');
      head.className = 'song-group';
      head.textContent = r;
      box.appendChild(head);
      for (const song of doc.songs.filter((s) => (s.round || '未分组') === r)) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'song-item' + (song.id === selectedId ? ' active' : '');
        const isCurrent = song.id === doc.currentId;
        const order = song.order ? String(song.order).padStart(2, '0') + ' · ' : '';
        row.innerHTML =
          '<div class="song-main">' +
          '<strong>' + escapeHtml(order + (song.title || '未命名')) + '</strong>' +
          '<span>' + escapeHtml((song.performer || '—') + (song.note ? ' · ' + song.note : '')) + '</span>' +
          '</div>' +
          '<div class="song-side">' +
          (isCurrent ? '<span class="tag on">当前</span>' : '') +
          '<span class="tag">' + (song.lyrics ? song.lyrics.length : 0) + ' 句</span>' +
          '</div>';
        row.addEventListener('click', () => {
          selectedId = song.id;
          renderList();
          renderEditor();
        });
        box.appendChild(row);
      }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- 编辑区 ----------

  function renderEditor() {
    const song = selected();
    const cur = doc.songs.find((s) => s.id === doc.currentId);
    $('#curTag').textContent = cur ? '当前：' + (cur.title || '未命名') : '未设为当前';
    $('#curTag').classList.toggle('on', !!cur);

    if (!song) {
      $('#songTitle').value = '';
      $('#songPerformer').value = '';
      $('#songNote').value = '';
      $('#songRound').value = '';
      $('#songOrder').value = '';
      $('#songLyrics').value = '';
      $('#btnApply').disabled = true;
      $('#btnDelete').disabled = true;
      return;
    }
    $('#songTitle').value = song.title || '';
    $('#songPerformer').value = song.performer || '';
    $('#songNote').value = song.note || '';
    $('#songRound').value = song.round || '';
    $('#songOrder').value = song.order != null ? String(song.order) : '';
    $('#songLyrics').value = (song.lyrics || []).join('\n');
    $('#btnApply').disabled = false;
    $('#btnDelete').disabled = false;
  }

  function readEditor() {
    const song = selected();
    if (!song) return null;
    song.title = $('#songTitle').value.trim();
    song.performer = $('#songPerformer').value.trim();
    song.note = $('#songNote').value.trim();
    song.round = $('#songRound').value.trim() || '未分组';
    const order = Number($('#songOrder').value);
    song.order = Number.isFinite(order) && order > 0 ? order : 0;
    song.lyrics = splitLyrics($('#songLyrics').value);
    return song;
  }

  async function persist(thenSelect) {
    const song = readEditor();
    if (!song) return;
    try {
      const res = await api('/api/songs', {
        songs: doc.songs,
        currentId: thenSelect ? song.id : doc.currentId,
      });
      doc.songs = res.songs;
      if (thenSelect) {
        await api('/api/songs/select', { id: song.id });
        doc.currentId = song.id;
      }
      renderList();
      renderEditor();
      $('#saveState').textContent = '已保存 ' + new Date().toLocaleTimeString();
      toast(thenSelect ? '已保存并设为当前' : '已保存');
    } catch (err) {
      toast('保存失败：' + err.message, true);
    }
  }

  // ---------- 加载 ----------

  async function load() {
    try {
      doc = await api('/api/songs');
      if (!selectedId || !doc.songs.some((s) => s.id === selectedId)) {
        selectedId = doc.currentId || (doc.songs[0] && doc.songs[0].id) || '';
      }
      renderList();
      renderEditor();
    } catch (err) {
      toast('读取歌曲失败：' + err.message, true);
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
        const snap = msg.state || msg;
        if (snap.songs) {
          doc.currentId = snap.songs.currentId || doc.currentId;
          renderList();
        }
      }
    };
  }

  function readTextSmart(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        let text = String(reader.result || '');
        // 出现替换符说明按 UTF-8 解错了，退回 GB18030 再读一次
        if (text.includes('\uFFFD')) {
          const reader2 = new FileReader();
          reader2.onload = () => resolve(String(reader2.result || ''));
          reader2.readAsText(file, 'gb18030');
          return;
        }
        resolve(text);
      };
      reader.onerror = () => resolve('');
      reader.readAsText(file, 'utf-8');
    });
  }

  function boot() {
    $('#btnNew').addEventListener('click', () => {
      const id = 's' + Date.now().toString(36);
      doc.songs.push({ id, title: '未命名', performer: '', note: '', round: '', order: 0, lyrics: [] });
      selectedId = id;
      renderList();
      renderEditor();
      $('#songTitle').focus();
    });

    $('#btnSave').addEventListener('click', () => persist(false));
    $('#btnApply').addEventListener('click', () => persist(true));

    $('#btnDelete').addEventListener('click', async () => {
      const song = selected();
      if (!song) return;
      if (!confirm('删除曲目「' + (song.title || '未命名') + '」？')) return;
      doc.songs = doc.songs.filter((s) => s.id !== song.id);
      selectedId = doc.songs[0] ? doc.songs[0].id : '';
      const nextCurrent = doc.songs.some((s) => s.id === doc.currentId) ? doc.currentId : '';
      doc.currentId = nextCurrent;
      try {
        await api('/api/songs', { songs: doc.songs, currentId: nextCurrent });
        renderList();
        renderEditor();
        toast('已删除');
      } catch (err) {
        toast('删除失败：' + err.message, true);
      }
    });

    $('#txtInput').addEventListener('change', async (e) => {
      const file = (e.target.files || [])[0];
      e.target.value = '';
      if (!file) return;
      const text = await readTextSmart(file);
      const lines = splitLyrics(text);
      if (!lines.length) {
        toast('这个 txt 里没有可用歌词', true);
        return;
      }
      const area = $('#songLyrics');
      area.value = lines.join('\n');
      if (!selected()) {
        doc.songs.push({
          id: 's' + Date.now().toString(36),
          title: file.name.replace(/\.txt$/i, ''),
          performer: '',
          note: '',
          round: '',
          order: 0,
          lyrics: lines,
        });
        selectedId = doc.songs[doc.songs.length - 1].id;
        renderList();
        renderEditor();
      }
      toast('已导入 ' + lines.length + ' 句，记得保存');
    });

    $('#btnClearLyrics').addEventListener('click', () => {
      $('#songLyrics').value = '';
    });

    load();
    connect();
  }

  boot();
})();
