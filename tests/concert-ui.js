'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CDP } = require('./browser');
const { createConcertServer } = require('../server/concert-server');
const { listenLocal, closeLocal } = require('../server/listen-local');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'concert-ui-'));
  const server = createConcertServer({ dataDirectory: path.join(directory, 'data') });
  let browser;
  let cdp;
  try {
    const origin = await listenLocal(server);
    async function api(route, body) {
      const response = await fetch(origin + route, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, route);
      return response.json();
    }
    const initial = await api('/api/state');
    const [first, second] = initial.songs.songs;
    await api('/api/songs/select', { id: first.id });
    await api('/api/command', { channel: 'lyric', action: 'next' });
    const profile = path.join(directory, 'browser');
    const executable = process.env.FBP_BROWSER || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-extensions',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    const active = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(active); i++) await delay(100);
    assert(fs.existsSync(active), 'headless browser must start');
    const [port, endpoint] = fs.readFileSync(active, 'utf8').trim().split(/\r?\n/);
    const socket = new WebSocket('ws://127.0.0.1:' + port + endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    cdp = new CDP(socket);
    const control = await cdp.page(origin + '/control.html');
    await cdp.until(control, "document.getElementById('conn').classList.contains('ok') && document.getElementById('songSelect').options.length>1");
    const before = await api('/api/state');
    await cdp.eval(control, `document.getElementById('songSelect').value=${JSON.stringify(second.id)};document.getElementById('songSelect').dispatchEvent(new Event('change',{bubbles:true}))`);
    await delay(500);
    let state = await api('/api/state');
    assert.equal(state.songs.currentId, first.id, 'preparing next song must preserve the on-air song');
    assert.deepEqual(state.channels, before.channels, 'preparing next song must preserve all on-air channels');
    await api('/api/command', { channel: 'announce', action: 'on', payload: { text: '正在播出的报幕' } });
    await cdp.until(control, "document.getElementById('lamp-announce').classList.contains('on')");
    const playbackId = (await api('/api/state')).channels.announce.playbackId;
    await cdp.eval(control, "document.getElementById('announceText').value='下一位歌手的草稿';document.getElementById('announceText').dispatchEvent(new Event('input',{bubbles:true}))");
    await delay(700);
    state = await api('/api/state');
    assert.equal(state.channels.announce.text, '正在播出的报幕', 'typing must remain a draft');
    assert.equal(state.channels.announce.playbackId, playbackId, 'typing must never restart the animation');
    if (process.argv.includes('--draft-only')) {
      console.log('PASS preparing and typing do not change the current broadcast');
      return;
    }
    console.log('PASS preparing and typing do not change the current broadcast');
    await cdp.until(control, "!document.getElementById('btn-announce').disabled");
    await cdp.eval(control, "document.getElementById('btn-announce').click()");
    await cdp.until(control, "document.getElementById('btn-announce').textContent==='重播报幕' && !document.getElementById('btn-announce').disabled");
    state = await api('/api/state');
    assert.equal(state.songs.currentId, second.id);
    assert.equal(state.channels.announce.text, '下一位歌手的草稿');
    assert.notEqual(state.channels.announce.playbackId, playbackId);

    const preview = await cdp.page(origin + '/graphics.html?preview=1&edit=1&clean=1');
    await cdp.until(preview, "document.getElementById('el-announceText').style.width!==''");
    assert.deepEqual((await api('/api/renderers')).outputs, [], 'control and editor do not count as outputs');
    const output = await cdp.page(origin + '/graphics.html?clean=1');
    await cdp.until(output, "document.getElementById('el-announceBg').readyState>=2");
    await cdp.until(control, "document.getElementById('outputSummary').textContent.includes('1 个输出')");
    assert.equal((await api('/api/renderers')).outputs.length, 1);
    const settings = await cdp.page(origin + '/config.html');
    await cdp.until(settings, "document.getElementById('conn').classList.contains('ok')");
    const beforeBranding = await api('/api/state');
    await cdp.eval(settings, "document.getElementById('brandEventTitle').value='深秋歌会';document.getElementById('brandSubtitle').value='秋夜与歌声';document.getElementById('brandAccent').value='#9fdaed';document.getElementById('btnApplyBranding').click()");
    await cdp.until(output, "document.getElementById('el-badge').classList.contains('text-badge')");
    state = await api('/api/state');
    assert.deepEqual(state.layout, beforeBranding.layout);
    assert.deepEqual(state.songs, beforeBranding.songs);
    assert.equal(state.config.branding.subtitle, '秋夜与歌声');
    await api('/api/command', { channel: 'badge', action: 'on' });
    await cdp.until(output, "document.getElementById('el-badge').classList.contains('on')");
    assert.equal(await cdp.eval(output, "getComputedStyle(document.getElementById('badgeVideo')).display"), 'none');
    assert.equal(await cdp.eval(output, "getComputedStyle(document.getElementById('brandBadge')).display"), 'flex');
    assert.equal(await cdp.eval(output, "getComputedStyle(document.body).backgroundColor"), 'rgba(0, 0, 0, 0)');
    console.log('PASS explicit take, output registration, editable branding and transparent canvas');

    await api('/api/command', { channel: 'announce', action: 'on', payload: { text: '长曲名'.repeat(150) } });
    await cdp.until(output, "document.getElementById('announceTextInner').textContent.length===450");
    const bounds = await cdp.eval(output, "(()=>{const box=document.getElementById('el-announceText'),inner=box.firstElementChild;return {size:parseFloat(inner.style.fontSize),height:inner.scrollHeight,limit:box.clientHeight,overflow:box.dataset.overflow,clip:getComputedStyle(box).overflow};})()");
    assert(bounds.size <= 46);
    assert.equal(bounds.clip, 'hidden');
    assert(bounds.height <= bounds.limit || bounds.overflow === 'true');
    await api('/api/command', { channel: 'announce', action: 'on', payload: { text: '超长文本'.repeat(2000) } });
    await cdp.until(output, "document.getElementById('el-announceText').dataset.overflow==='true'");
    assert.equal(await cdp.eval(output, "parseFloat(document.getElementById('announceTextInner').style.fontSize)"), 12);
    console.log('PASS long and extreme text stay bounded with an editor overflow marker');

    async function capture(name) {
      if (!process.env.CONCERT_SCREENSHOTS) return;
      fs.mkdirSync(process.env.CONCERT_SCREENSHOTS, { recursive: true });
      await cdp.send('Page.bringToFront', {}, output);
      await cdp.eval(output, "document.getAnimations().forEach(animation=>animation.finish())");
      await delay(100);
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, output);
      const result = await cdp.send('Page.captureScreenshot', { format: 'png' }, output);
      fs.writeFileSync(path.join(process.env.CONCERT_SCREENSHOTS, name + '.png'), Buffer.from(result.data, 'base64'));
    }
    for (const placement of ['lower-left', 'center']) {
      await api('/api/layout/preset', { placement });
      await api('/api/command', { channel: 'announce', action: 'on', payload: { text: '《秋夜与歌声》\n演唱：校园合唱团' } });
      await cdp.until(output, "document.getElementById('announceTextInner').textContent.includes('校园合唱团')");
      await cdp.eval(output, "document.getElementById('el-announceBg').currentTime=4;document.getElementById('el-announceBg').pause()");
      await delay(500);
      await capture(placement === 'center' ? '居中报幕' : '左下报幕');
    }
    await api('/api/command', { channel: 'lyric', action: 'next' });
    await cdp.until(output, `document.getElementById('lyricTextInner').textContent===${JSON.stringify(second.lyrics[1])}`);
    await api('/api/command', { channel: 'lyric', action: 'on', payload: { index: 1, text: '让歌声穿过秋夜，抵达你身旁' } });
    await cdp.until(output, "document.getElementById('lyricTextInner').textContent==='让歌声穿过秋夜，抵达你身旁'");
    await delay(1600);
    await capture('歌词与文字角标');
    await api('/api/command', { channel: 'qualify', action: 'on', payload: { title: '晋级名单', text: '示例选手甲\n示例选手乙\n示例选手丙' } });
    await cdp.until(output, "document.getElementById('qualifyTextInner').textContent.includes('示例选手丙')");
    await cdp.eval(output, "document.getElementById('el-qualifyBg').currentTime=4;document.getElementById('el-qualifyBg').pause()");
    await delay(500);
    await capture('晋级结果');

    await cdp.eval(settings, "document.getElementById('btnOriginalBadge').click()");
    await cdp.until(output, "!document.getElementById('el-badge').classList.contains('text-badge') && document.getElementById('badgeVideo').readyState>=2");
    assert.equal(await cdp.eval(output, "getComputedStyle(document.getElementById('brandBadge')).display"), 'none');
    await cdp.until(output, "!document.getElementById('badgeVideo').paused");
    console.log('PASS both placements, lyric and result rendering, original badge playback restored');

    await api('/api/command', { channel: 'announce', action: 'on' });
    const announce = (await api('/api/state')).channels.announce;
    await api('/api/event', { type: 'media-ended', channel: 'announce', playbackId: announce.playbackId });
    await cdp.until(control, "!document.getElementById('btn-clear').disabled");
    await cdp.eval(control, "document.getElementById('btn-clear').click()");
    await cdp.until(control, "document.getElementById('onAirSong').textContent.includes('包装已撤下')");
    await delay(800);
    state = await api('/api/state');
    assert(Object.values(state.channels).every((channel) => !channel.on));
    assert.equal(await cdp.eval(output, "document.querySelectorAll('.el.on').length"), 0);
    console.log('PASS clear removes every layer and cancels pending lyric handoff');

    // Hold canplay until after clear to deterministically exercise a slow-loading source.
    await cdp.eval(output, "(()=>{const video=document.getElementById('el-announceBg');window.holdCanplay=event=>event.stopImmediatePropagation();video.addEventListener('canplay',window.holdCanplay,true);Object.defineProperty(video,'readyState',{configurable:true,value:0});delete video.dataset.src;})()");
    await api('/api/command', { channel: 'announce', action: 'on' });
    await delay(150);
    await api('/api/clear', {});
    await delay(450);
    await cdp.eval(output, "(()=>{const video=document.getElementById('el-announceBg');video.removeEventListener('canplay',window.holdCanplay,true);delete video.readyState;video.dispatchEvent(new Event('canplay'));})()");
    await delay(100);
    assert.equal(await cdp.eval(output, "document.getElementById('el-announceBg').classList.contains('on')"), false, 'late canplay must never resurrect a cleared layer');
    console.log('PASS late video readiness cannot restore a cleared layer');

    await cdp.eval(output, "(()=>{const video=document.getElementById('el-announceBg');window.savedPlay=video.play;video.play=()=>Promise.reject(new DOMException('Test autoplay denial','NotAllowedError'));})()");
    await api('/api/command', { channel: 'announce', action: 'on' });
    await cdp.until(control, "document.getElementById('outputDetails').textContent.includes('Test autoplay denial')");
    assert.equal(await cdp.eval(control, "document.getElementById('outputSummary').classList.contains('ok')"), false);
    await cdp.eval(output, "document.getElementById('el-announceBg').play=window.savedPlay");
    await api('/api/clear', {});
    console.log('PASS rejected playback surfaces its error in the control page');

    // A known-bad local WebM exercises the real browser decoder and operator feedback.
    fs.writeFileSync(path.join(directory, 'data/assets/broken.webm'), 'not a valid video');
    await api('/api/backgrounds', { channel: 'badge', file: 'broken.webm' });
    await api('/api/command', { channel: 'badge', action: 'on' });
    await cdp.until(control, "document.getElementById('outputDetails').textContent.includes('角标 加载或播放失败')");
    assert.equal(await cdp.eval(control, "document.getElementById('outputSummary').classList.contains('ok')"), false);
    const failures = (await api('/api/renderers')).outputs[0].media.filter((media) => media.error);
    assert(failures.some((media) => media.channel === 'badge'));
    assert.equal(cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown').length, 0);
    console.log('PASS actual corrupt video is reported without false readiness or script exceptions');
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch {}
      cdp.ws.close();
    }
    if (browser && browser.exitCode === null) browser.kill();
    await closeLocal(server);
    await delay(250);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
