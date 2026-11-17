'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceServer } = require('../server/workspace-server');
const { listenLocal } = require('../server/listen-local');
const { runtimeFiles, copyRuntime } = require('../packaging/app-files');

test('packaged workspace contains the complete concert, seeds data and owns its lifecycle', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'concert-workspace-'));
  const project = path.join(temporary, 'app');
  const dataDirectory = path.join(temporary, 'data');
  const servers = [];
  t.after(async () => {
    for (const server of servers.reverse()) await server.shutdown();
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const files = runtimeFiles(path.resolve(__dirname, '..'));
  for (const file of ['报幕1.webm', '报幕2.webm', '歌词.webm', '角标.webm']) {
    assert(files.includes('packages/autumn/assets/' + file), 'missing packaged asset: ' + file);
  }
  assert(files.includes('packages/autumn/data/songs.json'));
  assert(files.includes('ui/concert/control.html'));
  copyRuntime(path.resolve(__dirname, '..'), project);
  const server = createWorkspaceServer({ dataDirectory, project });
  servers.push(server);
  await server.initialize();
  const origin = await listenLocal(server);
  const select = async (enabled) => {
    const response = await fetch(origin + '/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  let model = await select(['concert', 'stage']);
  const concert = model.modules.find((item) => item.id === 'concert');
  assert.equal(concert.controlPath, '/control.html');
  assert.equal(concert.outputPath, '/graphics.html');
  assert.equal(concert.editorPath, '/edit.html');
  assert.equal((await fetch(concert.url + concert.controlPath)).status, 200);
  const state = await (await fetch(concert.url + '/api/state')).json();
  assert.equal(state.songs.songs[0].title, '深秋');
  const change = await fetch(concert.url + '/api/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'announceText', x: 444 }),
  });
  assert.equal(change.status, 200);
  await select(['stage']);
  await assert.rejects(fetch(concert.url + '/api/state'));
  model = await select(['concert', 'stage']);
  const resumed = model.modules.find((item) => item.id === 'concert');
  assert.equal((await (await fetch(resumed.url + '/api/state')).json()).layout.announceText.x, 444);
  await server.shutdown();
  const restart = createWorkspaceServer({ dataDirectory, project });
  servers.push(restart);
  await restart.initialize();
  assert.deepEqual(restart.describe().loaded, ['concert', 'stage']);
});
