'use strict';
(function () {
  const $ = (selector) => document.querySelector(selector);
  const CHANNELS = ['announce', 'lyric', 'qualify', 'credits', 'badge', 'visual'];
  const LABELS = { announce: '报幕', lyric: '歌词', qualify: '结果', credits: '结尾', badge: '角标' };
  let state = null;
  let preparedSongId = null;
  let connected = false;
  let busy = false;
  let statusTimer;
  let statusLoading = false;

  function toast(text, bad) {
    const element = $('#toast');
    element.textContent = text;
    element.classList.toggle('bad', !!bad);
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 3500);
  }

  async function api(route, body) {
    const response = await fetch(route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + response.status);
    return data;
  }

  function songs() { return state?.songs?.songs || []; }
  function preparedSong() { return songs().find((song) => song.id === preparedSongId); }
  function channelOn(channel) { return !!state?.channels?.[channel]?.on; }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function fillAnnounce() {
    const song = preparedSong();
    const lines = song ? ['《' + song.title + '》'] : [];
    if (song?.performer) lines.push('演唱：' + song.performer);
    $('#announceText').value = lines.join('\n');
  }

  function setBusy() {
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.disabled = busy || !connected || !state;
    });
  }

  function render() {
    if (!state) return;
    if (!songs().some((song) => song.id === preparedSongId)) {
      preparedSongId = state.songs.currentId || songs()[0]?.id || null;
      fillAnnounce();
    }
    $('#announcePlacement').value = state.announcePlacement || 'lower-left';
    const rounds = [...new Set(songs().map((song) => song.round))];
    $('#songSelect').innerHTML = rounds.map((round) => '<optgroup label="' + escapeHtml(round) + '">' +
      songs().filter((song) => song.round === round).map((song) =>
        '<option value="' + escapeHtml(song.id) + '">' + escapeHtml(song.title + (song.performer ? ' — ' + song.performer : '')) + '</option>',
      ).join('') + '</optgroup>',
    ).join('');
    $('#songSelect').value = preparedSongId;
    const prepared = preparedSong();
    $('#songMeta').textContent = prepared
      ? [prepared.round, prepared.performer, (prepared.lyrics || []).length + ' 句歌词'].filter(Boolean).join(' · ')
      : '请先在歌曲页添加节目';
    const current = songs().find((song) => song.id === state.songs.currentId);
    const active = CHANNELS.filter((channel) => channelOn(channel)).map((channel) => LABELS[channel] || '主视觉');
    $('#onAirSong').textContent = (active.length ? '播出中 · ' + active.join(' / ') : '包装已撤下') +
      (current ? '　当前节目《' + current.title + '》' : '');
    const lyric = state.channels.lyric;
    const total = (state.lyrics || []).length;
    $('#lyricPos').textContent = total ? Math.min((lyric.index || 0) + 1, total) + ' / ' + total : '0 / 0';
    $('#lyricLine').textContent = lyric.text || '（空句）';
    for (const channel of CHANNELS) {
      const on = channelOn(channel);
      $('#lamp-' + channel)?.classList.toggle('on', on);
      $('#card-' + channel)?.classList.toggle('onair', on);
      const button = $('#btn-' + channel);
      button?.classList.toggle('onair', on);
      if (channel === 'announce') button.textContent = on && preparedSongId === state.songs.currentId ? '重播报幕' : '报幕上屏';
      else if (channel === 'lyric') button.textContent = '歌词上屏';
      else if (button) button.textContent = on ? '下屏' : '上屏';
    }
    $('#btn-announce-off').hidden = !channelOn('announce');
    $('#btn-lyric-off').hidden = !channelOn('lyric');
    $('#btn-credits-pause').hidden = !channelOn('credits');
    $('#btn-credits-pause').textContent = state.channels.credits.paused ? '继续滚动' : '暂停滚动';
    $('#storageWarning').textContent = (state.storageWarnings || []).join(' ');
    $('#storageWarning').hidden = !(state.storageWarnings || []).length;
    setBusy();
  }

  function acceptState(next) {
    if (state && next.tick < state.tick) return;
    state = next;
    render();
  }

  async function operate(action) {
    if (busy || !connected || !state) return;
    busy = true;
    setBusy();
    try {
      const result = await action();
      acceptState(await api('/api/state'));
      if (result?.vmix?.ok === false) toast('包装状态已更新，vMix 操作失败，请在 vMix 撤层。' + (result.vmix.error || ''), true);
    } catch (error) {
      toast('操作未确认，请核对播出状态。' + error.message, true);
    } finally {
      busy = false;
      setBusy();
    }
  }

  function command(channel, action, payload = {}) {
    return api('/api/command', { channel, action, payload });
  }

  function toggle(channel, payload) {
    return operate(() => command(channel, channelOn(channel) ? 'off' : 'on', payload));
  }

  async function refreshOutputStatus() {
    if (statusLoading) return;
    statusLoading = true;
    const summary = $('#outputSummary');
    const details = $('#outputDetails');
    try {
      const [diagnostics, next] = await Promise.all([api('/api/renderers'), api('/api/state')]);
      acceptState(next);
      const { outputs } = diagnostics;
      const messages = [];
      if (!outputs.length) messages.push('未收到正式输出页回报，请在 vMix 加载上屏地址。');
      for (const [index, output] of outputs.entries()) {
        if (output.width !== 1920 || output.height !== 1080)
          messages.push('输出 ' + (index + 1) + ' 为 ' + output.width + ' × ' + output.height + '，建议使用 1920 × 1080。');
        for (const media of output.media) {
          const name = '输出 ' + (index + 1) + ' · ' + (LABELS[media.channel] || media.channel);
          if (media.error) messages.push(name + ' 加载或播放失败，' + media.error);
          else if (media.file && media.readyState < 2) messages.push(name + ' 等待素材载入');
          else if (media.file && media.on && media.paused && !media.ended) messages.push(name + ' 播放器未开始播放');
        }
      }
      summary.classList.toggle('ok', outputs.length > 0 && !messages.length);
      summary.textContent = outputs.length ? outputs.length + ' 个输出 · ' + (messages.length ? '请检查' : '素材就绪') : '等待正式输出';
      details.replaceChildren();
      for (const message of messages) {
        const item = document.createElement('li');
        item.textContent = message;
        details.appendChild(item);
      }
    } catch (error) {
      summary.textContent = '输出状态读取失败';
      summary.classList.remove('ok');
      details.textContent = error.message;
    } finally { statusLoading = false; }
  }

  function connect() {
    const events = new EventSource('/api/events');
    events.onopen = () => {
      connected = true;
      $('#conn').textContent = '已连接';
      $('#conn').classList.add('ok');
      setBusy();
    };
    events.onerror = () => {
      connected = false;
      $('#conn').textContent = '断开，重连中…';
      $('#conn').classList.remove('ok');
      setBusy();
    };
    events.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'snapshot' && message.state) acceptState(message.state);
      else if (['cue', 'layout', 'lyrics', 'config'].includes(message.type)) {
        api('/api/state').then(acceptState).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', () => {
      events.close();
      clearInterval(statusTimer);
    }, { once: true });
  }

  function bind() {
    $('#songSelect').addEventListener('change', (event) => {
      preparedSongId = event.target.value;
      fillAnnounce();
      render();
    });
    $('#btnFillAnnounce').addEventListener('click', fillAnnounce);
    $('#btn-announce').addEventListener('click', () => operate(() => {
      if (!preparedSong()) throw new Error('请先选择待播节目');
      return command('announce', 'on', { songId: preparedSongId, text: $('#announceText').value });
    }));
    $('#btn-lyric').addEventListener('click', () => operate(() => {
      if (!preparedSong()) throw new Error('请先选择待播节目');
      const index = preparedSongId === state.songs.currentId ? state.channels.lyric.index : 0;
      return command('lyric', 'on', { songId: preparedSongId, index });
    }));
    $('#btn-announce-off').addEventListener('click', () => operate(() => command('announce', 'off')));
    $('#btn-lyric-off').addEventListener('click', () => operate(() => command('lyric', 'off')));
    $('#btn-next').addEventListener('click', () => operate(() => command('lyric', 'next')));
    $('#btn-prev').addEventListener('click', () => operate(() => command('lyric', 'prev')));
    $('#btn-qualify').addEventListener('click', () => toggle('qualify', { title: $('#qualifyTitle').value, text: $('#qualifyText').value }));
    $('#btn-credits').addEventListener('click', () => toggle('credits', { speed: Number($('#creditsSpeed').value) || 40 }));
    $('#btn-credits-pause').addEventListener('click', () => operate(() => command('credits', state.channels.credits.paused ? 'resume' : 'pause')));
    $('#btn-badge').addEventListener('click', () => toggle('badge'));
    $('#btn-visual').addEventListener('click', () => toggle('visual'));
    $('#btn-clear').addEventListener('click', () => operate(() => api('/api/clear', {})));
    $('#announcePlacement').addEventListener('change', () => operate(() => api('/api/layout/preset', { placement: $('#announcePlacement').value })));
  }

  async function boot() {
    bind();
    try { acceptState(await api('/api/state')); } catch (error) { toast('读取状态失败，' + error.message, true); }
    connect();
    refreshOutputStatus();
    statusTimer = setInterval(refreshOutputStatus, 5000);
  }

  boot();
})();
