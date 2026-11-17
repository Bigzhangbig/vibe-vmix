'use strict';
/**
 * 深秋歌会 · 配置页（全局配置 + 运行状态 + 结尾名单）
 */
(function () {
  const $ = (s) => document.querySelector(s);
  let state = null;
  let es = null;

  const CHANNEL_LABEL = {
    announce: '报幕',
    lyric: '歌词',
    qualify: '晋级',
    credits: '结尾',
    badge: '角标',
    visual: '主视觉',
  };

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

  function syncFadeLabels() {
    $('#fadeInOut').textContent = $('#fadeIn').value;
    $('#fadeOutOut').textContent = $('#fadeOut').value;
  }

  function fill(cfg) {
    if (!cfg) return;
    $('#fadeIn').value = String(cfg.fadeIn != null ? cfg.fadeIn : 320);
    $('#fadeOut').value = String(cfg.fadeOut != null ? cfg.fadeOut : 240);
    syncFadeLabels();

    const font = cfg.font || {};
    $('#fontFamily').value = font.family || 'Microsoft YaHei';
    $('#fontWeight').value = String(font.weight || 700);
    $('#fontShadow').checked = font.shadow !== false;

    const branding = cfg.branding || {};
    $('#brandEventTitle').value = branding.eventTitle || '深秋歌会';
    $('#brandSubtitle').value = branding.subtitle || '';
    $('#brandAccent').value = branding.accent || '#9fdaed';
    $('#brandBadgeMode').value = branding.badgeMode || 'original';


    const vmix = cfg.vmix || {};
    $('#vmixEnabled').checked = !!vmix.enabled;
    $('#vmixHost').value = vmix.host || '127.0.0.1';
    $('#vmixPort').value = String(vmix.port || 8088);
    $('#vmixInput').value = vmix.input || 'MainVisual';
    $('#vmixOverlay').value = String(vmix.overlay || 1);
  }

  function payload() {
    return {
      branding: brandingPayload(),
      fadeIn: Number($('#fadeIn').value),
      fadeOut: Number($('#fadeOut').value),
      font: {
        family: $('#fontFamily').value,
        weight: Number($('#fontWeight').value),
        shadow: $('#fontShadow').checked,
      },
      vmix: {
        enabled: $('#vmixEnabled').checked,
        host: $('#vmixHost').value.trim(),
        port: Number($('#vmixPort').value),
        input: $('#vmixInput').value.trim(),
        overlay: Number($('#vmixOverlay').value),
      },
    };
  }

  function brandingPayload() {
    return {
      eventTitle: $('#brandEventTitle').value.trim() || '深秋歌会',
      subtitle: $('#brandSubtitle').value.trim(),
      accent: $('#brandAccent').value,
      badgeMode: $('#brandBadgeMode').value,
    };
  }

  // ---------- 运行状态 ----------

  function fmtUptime(startedAt) {
    if (!startedAt) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? h + ' 时 ' + m + ' 分 ' + s + ' 秒' : m + ' 分 ' + s + ' 秒';
  }

  function renderStatus() {
    if (!state) return;
    $('#runOrigin').textContent = location.origin;
    $('#runUptime').textContent = fmtUptime(state.startedAt);
    $('#runClients').textContent = (state.clients || 0) + ' 个';
    $('#runLyrics').textContent = (state.lyrics || []).length + ' 句';
    const songs = state.songs || {};
    const cur = (songs.songs || []).find((s) => s.id === songs.currentId);
    $('#runSong').textContent = cur ? cur.title + (cur.performer ? ' · ' + cur.performer : '') : '未设置';
    const assets = state.assets || [];
    $('#runAssets').textContent = assets.length + ' 个';

    const pill = $('#runPill');
    pill.textContent = '运行中';
    pill.classList.add('ok');

    const box = $('#chanStates');
    box.innerHTML = '';
    const channels = state.channels || {};
    for (const key of ['announce', 'lyric', 'qualify', 'credits', 'badge', 'visual']) {
      const ch = channels[key] || {};
      const row = document.createElement('div');
      row.className = 'stat' + (ch.on ? ' on' : '');
      row.innerHTML =
        '<span class="stat-dot"></span><b>' + CHANNEL_LABEL[key] + '</b>' +
        '<span class="stat-text">' + (ch.on ? 'On Air' : '待机') + '</span>';
      box.appendChild(row);
    }
  }

  // ---------- 结尾名单 ----------

  function renderCredits(credits) {
    const groups = (credits && credits.groups) || [];
    $('#creditsText').value = groups
      .map((g) => g.role + ': ' + (g.names || []).join('、'))
      .join('\n');
  }

  function parseCredits() {
    return $('#creditsText')
      .value.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.search(/[:：]/);
        if (idx < 0) return { role: '名单', names: [line] };
        const role = line.slice(0, idx).trim() || '名单';
        const names = line
          .slice(idx + 1)
          .split(/[、,，]/)
          .map((n) => n.trim())
          .filter(Boolean);
        return { role, names };
      });
  }

  function fillAddresses() {
    const origin = location.origin;
    $('#addrGraphics').textContent = origin + '/graphics.html?clean=1';
    $('#addrControl').textContent = origin + '/control.html';
    $('#addrMonitor').textContent = origin + '/edit.html';
  }

  function connect() {
    es = new EventSource('/api/events');
    es.onopen = () => {
      const pill = $('#conn');
      pill.textContent = '已连接';
      pill.classList.add('ok');
    };
    es.onerror = () => {
      const pill = $('#conn');
      pill.textContent = '断开，重连中…';
      pill.classList.remove('ok');
      $('#runPill').classList.remove('ok');
      $('#runPill').textContent = '已断开';
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
        fill(state.config);
        renderStatus();
      } else if (msg.type === 'config') {
        if (state) state.config = msg.config;
        fill(msg.config);
      }
    };
  }

  async function boot() {
    fillAddresses();
    try {
      state = await api('/api/state');
      fill(state.config);
      renderStatus();
      const credits = await api('/api/credits');
      renderCredits(credits);
    } catch {
      toast('读取配置失败，请确认服务已启动', true);
    }

    $('#fadeIn').addEventListener('input', syncFadeLabels);
    $('#fadeOut').addEventListener('input', syncFadeLabels);

    $('#btnFadeFast').addEventListener('click', () => {
      $('#fadeIn').value = '160';
      $('#fadeOut').value = '120';
      syncFadeLabels();
    });
    $('#btnFadeSoft').addEventListener('click', () => {
      $('#fadeIn').value = '480';
      $('#fadeOut').value = '360';
      syncFadeLabels();
    });

    $('#btnSave').addEventListener('click', async () => {
      try {
        await api('/api/config', payload());
        toast('配置已保存并生效');
      } catch (err) {
        toast('保存失败：' + err.message, true);
      }
    });

    async function saveBranding(mode) {
      const branding = { ...brandingPayload(), badgeMode: mode };
      try {
        await api('/api/config', { branding });
        $('#brandBadgeMode').value = mode;
        toast(mode === 'text' ? '本届包装已应用' : '已恢复原素材角标');
      } catch (err) {
        toast('保存失败：' + err.message, true);
      }
    }
    $('#btnApplyBranding').addEventListener('click', () => saveBranding('text'));
    $('#btnOriginalBadge').addEventListener('click', () => saveBranding('original'));

    $('#btnSaveCredits').addEventListener('click', async () => {
      try {
        await api('/api/credits', { groups: parseCredits() });
        toast('名单已保存');
      } catch (err) {
        toast('保存失败：' + err.message, true);
      }
    });

    connect();
  }

  boot();
})();
