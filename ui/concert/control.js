'use strict';
/**
 * 深秋歌会 · 直播切换台
 * 报幕与歌词合并成「节目」卡：选中节目后，报幕文本与歌词都从这条节目里取。
 */
(function () {
  const $ = (s) => document.querySelector(s);

  let state = null;
  let songs = [];
  let lyrics = [];
  let filledSongId = null;
  let announceTimer = null;

  const CHANNELS = ['announce', 'lyric', 'qualify', 'credits', 'badge', 'visual'];

  function toast(text, bad) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
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

  function songById(id) {
    return songs.find((s) => s.id === id) || null;
  }

  function currentSong() {
    return songById(state && state.songs && state.songs.currentId);
  }

  function announceDefault(song) {
    if (!song) return '';
    // 不自动加「第 x 个节目」，只给曲名和演唱者
    const lines = ['《' + song.title + '》'];
    if (song.performer) lines.push('演唱：' + song.performer);
    return lines.join('\n');
  }

  function channelOn(ch) {
    return !!(state && state.channels[ch] && state.channels[ch].on);
  }

  function paint(ch) {
    const btn = $('#btn-' + ch);
    const on = channelOn(ch);
    if (btn) {
      btn.classList.toggle('onair', on);
      btn.textContent = on ? '下屏' : (ch === 'qualify' || ch === 'badge' || ch === 'visual' ? '上屏' : ch === 'credits' ? '上屏' : ch === 'announce' ? '报幕上屏' : '歌词上屏');
    }
    const lamp = $('#lamp-' + ch);
    if (lamp) lamp.classList.toggle('on', on);
    const card = $('#card-' + ch);
    if (card) card.classList.toggle('onair', on);
  }

  function paintAll() {
    for (const ch of CHANNELS) paint(ch);
    const paused = state && state.channels.credits && state.channels.credits.paused;
    const pauseBtn = $('#btn-credits-pause');
    if (pauseBtn) {
      pauseBtn.hidden = !channelOn('credits');
      pauseBtn.textContent = paused ? '继续滚动' : '暂停滚动';
    }
  }

  function renderSongs() {
    const sel = $('#songSelect');
    if (!sel) return;
    const cur = state && state.songs ? state.songs.currentId : '';
    const rounds = [];
    for (const s of songs) {
      if (!rounds.includes(s.round)) rounds.push(s.round);
    }
    sel.innerHTML = rounds.map((r) => {
      const items = songs.filter((s) => s.round === r).map((s) => {
        const label = s.round === '串场'
          ? s.title
          : String(s.order).padStart(2, '0') + ' · ' + s.title + ' — ' + (s.performer || '');
        return '<option value="' + s.id + '">' + escapeHtml(label) + '</option>';
      });
      return '<optgroup label="' + escapeHtml(r) + '">' + items.join('') + '</optgroup>';
    }).join('');
    sel.value = cur;

    const meta = $('#songMeta');
    if (meta) {
      const s = currentSong();
      if (!s) {
        meta.textContent = '—';
      } else {
        const bits = [];
        if (s.round) bits.push(s.round);
        if (s.order) bits.push('第 ' + s.order + ' 个');
        if (s.performer) bits.push(s.performer);
        if (s.version) bits.push(s.version);
        if (s.lyrics) bits.push(s.lyrics.length + ' 句歌词');
        meta.textContent = bits.join(' · ') || '—';
      }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fillAnnounce(force) {
    // 只有用户主动点「填入默认」才写文本框；切换节目一律不动它
    if (!force) return;
    const song = currentSong();
    const box = $('#announceText');
    if (!song || !box) return;
    box.value = announceDefault(song);
    filledSongId = song.id;
  }

  function renderLyric() {
    const ch = state && state.channels.lyric ? state.channels.lyric : {};
    const idx = Number.isInteger(ch.index) ? ch.index : 0;
    const total = lyrics.length;
    const text = idx >= 0 ? (lyrics[idx] || '') : '';
    const pos = $('#lyricPos');
    const line = $('#lyricLine');
    // 空行也是正常行：行号照常往前走，只是屏幕上没有字
    if (pos) {
      pos.textContent = total
        ? (text ? Math.min(idx + 1, total) + ' / ' + total : '— / ' + total)
        : '0 / 0';
    }
    if (line) line.textContent = text;
  }

  function render() {
    if (!state) return;
    $('#announcePlacement').value = state.announcePlacement || 'lower-left';
    songs = (state.songs && state.songs.songs) || [];
    lyrics = state.lyrics || [];
    renderSongs();
    renderLyric();
    paintAll();
  }

  async function selectSong(id) {
    if (!id) return;
    try {
      await api('/api/songs/select', { id });
      const snap = await api('/api/state');
      state = snap;
      render();
      // 切节目时把报幕文本换成这条节目的默认文案（不含「第 x 个节目」）
      fillAnnounce(true);
    } catch (err) {
      toast('切换节目失败：' + err.message, true);
    }
  }

  async function toggleChannel(channel, payload) {
    const on = channelOn(channel);
    try {
      await api('/api/command', { channel, action: on ? 'off' : 'on', payload: on ? {} : payload || {} });
      const snap = await api('/api/state');
      state = snap;
      render();
    } catch (err) {
      toast('操作失败：' + err.message, true);
    }
  }

  async function lyricStep(dir) {
    try {
      await api('/api/command', { channel: 'lyric', action: dir, payload: {} });
      const snap = await api('/api/state');
      state = snap;
      render();
    } catch (err) {
      toast('翻句失败：' + err.message, true);
    }
  }

  async function lyricOn() {
    const ch = state.channels.lyric || {};
    const idx = Number.isInteger(ch.index) ? ch.index : 0;
    await toggleChannel('lyric', { index: idx });
  }

  function announceOn() {
    return toggleChannel('announce', { text: $('#announceText').value });
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
      if (msg.type === 'snapshot' && msg.state) {
        state = msg.state;
        render();
      } else if (msg.type === 'cue' || msg.type === 'layout') {
        api('/api/state').then((s) => { state = s; render(); }).catch(() => {});
      }
    };
  }


  function bind() {
    $('#announcePlacement').addEventListener('change', async (event) => {
      const select = event.target;
      select.disabled = true;
      try {
        await api('/api/layout/preset', { placement: select.value });
        state = await api('/api/state');
        render();
        toast('报幕位置已保存');
      } catch (error) {
        toast('切换位置失败：' + error.message, true);
        render();
      } finally { select.disabled = false; }
    });
    $('#songSelect').addEventListener('change', (e) => selectSong(e.target.value));

    $('#btn-announce').addEventListener('click', () => {
      if (channelOn('announce')) toggleChannel('announce');
      else announceOn();
    });
    $('#btn-lyric').addEventListener('click', () => {
      if (channelOn('lyric')) toggleChannel('lyric');
      else lyricOn();
    });
    $('#btn-prev').addEventListener('click', () => lyricStep('prev'));
    $('#btn-next').addEventListener('click', () => lyricStep('next'));

    $('#announceText').addEventListener('input', () => {
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        if (channelOn('announce')) api('/api/command', { channel: 'announce', action: 'on', payload: { text: $('#announceText').value } }).catch(() => {});
      }, 400);
    });

    $('#btnFillAnnounce').addEventListener('click', () => fillAnnounce(true));

    $('#btn-qualify').addEventListener('click', () => {
      if (channelOn('qualify')) toggleChannel('qualify');
      else toggleChannel('qualify', { title: $('#qualifyTitle').value, text: $('#qualifyText').value });
    });

    $('#btn-credits').addEventListener('click', () => {
      if (channelOn('credits')) toggleChannel('credits');
      else toggleChannel('credits', { speed: Number($('#creditsSpeed').value) || 40 });
    });
    $('#btn-credits-pause').addEventListener('click', async () => {
      const paused = state.channels.credits && state.channels.credits.paused;
      try {
        await api('/api/command', { channel: 'credits', action: paused ? 'resume' : 'pause', payload: {} });
        const snap = await api('/api/state');
        state = snap;
        render();
      } catch (err) {
        toast('操作失败：' + err.message, true);
      }
    });

    $('#btn-badge').addEventListener('click', () => toggleChannel('badge'));
    $('#btn-visual').addEventListener('click', () => toggleChannel('visual'));
  }

  async function boot() {
    try {
      state = await api('/api/state');
      render();
      // 打开页面就按当前节目重新填一次报幕词，避免显示上一次残留的文本
      fillAnnounce(true);
    } catch {
      toast('读取状态失败', true);
    }
    bind();
    connect();
  }

  boot();
})();
