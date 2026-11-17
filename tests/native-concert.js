'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { CDP } = require('./browser');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const build = path.resolve(process.argv[2]);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'concert-native-'));
  fs.writeFileSync(
    path.join(data, 'workspace.json'),
    JSON.stringify({ enabled: ['concert', 'stage'] }),
  );
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let host, cdp, origin;
  try {
    host = spawn(path.join(build, '转播包装工作台.exe'), [], {
      cwd: build,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        BROADCAST_DATA: data,
        BROADCAST_DESKTOP_TEST: '1',
        BROADCAST_DEBUG_PORT: String(port),
      },
    });
    const readyFile = path.join(data, 'active-host.json');
    for (let i = 0; i < 200 && !fs.existsSync(readyFile) && host.exitCode === null; i++)
      await delay(100);
    assert(fs.existsSync(readyFile), 'native workspace starts');
    origin = JSON.parse(fs.readFileSync(readyFile)).origin;
    let endpoint;
    for (let i = 0; i < 100; i++) {
      try {
        endpoint = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
        break;
      } catch {
        await delay(100);
      }
    }
    assert(endpoint, 'native WebView2 debug endpoint');
    const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    cdp = new CDP(socket);
    async function attachPage(url) {
      for (let i = 0; i < 120; i++) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const target = targetInfos.find((item) => item.type === 'page' && item.url === url);
        if (target) {
          const { sessionId } = await cdp.send('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true,
          });
          await cdp.send('Runtime.enable', {}, sessionId);
          await cdp.send('Page.enable', {}, sessionId);
          return sessionId;
        }
        await delay(100);
      }
      const { targetInfos } = await cdp.send('Target.getTargets');
      throw Error(
        'native page did not open: ' +
          url +
          '\n' +
          JSON.stringify(targetInfos.map((target) => target.url)),
      );
    }
    const mainPage = await attachPage(origin + '/workspace/index.html');
    async function click(session, selector) {
      const point = await cdp.eval(
        session,
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      );
      await cdp.send('Page.bringToFront', {}, session);
      for (const type of ['mousePressed', 'mouseReleased'])
        await cdp.send(
          'Input.dispatchMouseEvent',
          { type, ...point, button: 'left', clickCount: 1 },
          session,
        );
    }
    await cdp.until(mainPage, 'document.querySelectorAll("#navigation button").length===2');
    assert.equal(await cdp.eval(mainPage, 'document.getElementById("openPreview").disabled'), true);
    const model = await (await fetch(origin + '/api/workspace')).json();
    const concert = model.modules.find((item) => item.id === 'concert').url;
    const stage = model.modules.find((item) => item.id === 'stage').url;
    await cdp.eval(
      mainPage,
      'document.querySelector("#navigation button[data-id=concert]").click()',
    );
    const address = concert + '/graphics.html';
    assert.equal(
      await cdp.eval(mainPage, 'document.getElementById("moduleAddress").textContent'),
      address,
    );
    await click(mainPage, '#openPreview');
    const editor = await attachPage(concert + '/edit.html');
    await cdp.until(editor, 'document.querySelector("#conn").textContent.includes("已连接")');
    assert.equal(await cdp.eval(editor, 'document.querySelectorAll("iframe").length'), 1);
    assert.equal(
      await cdp.eval(mainPage, 'document.getElementById("moduleName").textContent'),
      '深秋歌会',
    );
    assert.equal(
      await cdp.eval(mainPage, 'document.getElementById("moduleFrame").src'),
      concert + '/control.html',
    );
    assert.equal(
      await cdp.eval(mainPage, 'document.getElementById("moduleAddress").textContent'),
      address,
    );
    await click(mainPage, '#copyAddress');
    await cdp.until(
      mainPage,
      'document.getElementById("copyAddress").textContent.includes("已复制")',
    );
    const clipboard = await new Promise((resolve, reject) =>
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Get-Clipboard -Raw'],
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    assert(
      clipboard.trim() === address,
      'native copy writes the selected output URL to the clipboard',
    );
    assert(
      (await cdp.eval(mainPage, 'document.getElementById("moduleAddress").textContent')).endsWith(
        address,
      ),
    );
    await cdp.eval(mainPage, 'document.querySelector("#navigation button[data-id=stage]").click()');
    await click(mainPage, '#openPreview');
    const layout = await attachPage(origin + '/workspace/preview.html?module=stage');
    await cdp.until(
      layout,
      'document.querySelectorAll(".canvas iframe").length===1 && document.getElementById("element").options.length>0',
    );
    assert.equal(
      await cdp.eval(layout, 'document.querySelectorAll("#pgmPanel,[data-view]").length'),
      0,
    );
    const prior = await (await fetch(stage + '/api/v1/state')).json();
    await cdp.eval(
      layout,
      'document.getElementById("element").value="stage:caption";document.getElementById("element").dispatchEvent(new Event("change"));document.getElementById("x").value="120";document.getElementById("x").dispatchEvent(new Event("change"))',
    );
    assert.equal(
      (await (await fetch(stage + '/api/v1/state')).json()).style.captionX,
      prior.style.captionX,
    );
    await cdp.eval(layout, 'document.getElementById("apply").click()');
    await cdp.until(layout, 'document.getElementById("notice").textContent.includes("已应用")');
    assert.equal((await (await fetch(stage + '/api/v1/state')).json()).style.captionX, 120);
    await cdp.eval(
      mainPage,
      'document.querySelector("#navigation button[data-id=concert]").click()',
    );
    await click(mainPage, '#openPreview');
    assert.equal(
      await cdp.eval(mainPage, 'document.getElementById("moduleAddress").textContent'),
      address,
    );
    assert.equal(
      await cdp.eval(mainPage, 'document.body.textContent.includes("undefined")'),
      false,
    );
    console.log(
      'PASS native module selection, concert layout popup, valid output after layout/copy, single-canvas stage editing and explicit layout persistence',
    );
  } finally {
    for (const file of fs.readdirSync(data).filter((n) => n.endsWith('.log')))
      console.log('NATIVE_LOG', file, fs.readFileSync(path.join(data, file), 'utf8'));
    cdp?.ws.close();
    if (host && host.exitCode === null) {
      await new Promise((resolve) =>
        execFile(
          'powershell.exe',
          ['-NoProfile', '-Command', '(Get-Process -Id ' + host.pid + ').CloseMainWindow()'],
          () => resolve(),
        ),
      );
      for (let i = 0; i < 50 && host.exitCode === null; i++) await delay(100);
      if (host.exitCode === null) host.kill();
    }
    try {
      fs.rmSync(data, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    } catch {
      console.log('Native test data retained:', data);
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
