import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import worker from '../worker/index.js';
import { deviceClient, parsePairingCode, runJob } from '../client/pc-bridge.mjs';
import { createUnityMcp } from '../client/unity-mcp.mjs';
import { createUnityImageImporter } from '../client/unity-image-import.mjs';
import catalog from '../client/unity-tools.json' with { type: 'json' };
import gitTools from '../client/git-tools.json' with { type: 'json' };

const origin = 'https://bridge-test.chatgpt.site';
const owner = 'owner@example.com';
const ownerHeader = { 'oai-authenticated-user-email': owner };
const bypassToken = 'sites-dev-test-token-123456';
const browserForm = { ...ownerHeader, Origin: 'null', 'Sec-Fetch-Site': 'same-origin' };

function prepareBridge(t) {
  const db = new DatabaseSync(':memory:');
  for (const migration of ['0000_bridge', '0001_unity_arguments']) {
    db.exec(readFileSync(new URL(`../drizzle/${migration}.sql`, import.meta.url), 'utf8'));
  }
  t.after(() => db.close());
  const d1 = {
    prepare(sql) {
      const statement = db.prepare(sql);
      function bound(params) {
        return {
          bind: (...values) => bound(values),
          first: async () => statement.get(...params),
          run: async () => statement.run(...params),
        };
      }
      return bound([]);
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const statement of statements) await statement.run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const env = { DB: d1, BRIDGE_OWNER_EMAIL: owner, BRIDGE_SITES_TOKEN: bypassToken, BRIDGE_ORIGIN: origin };
  env.BRIDGE_PLUGIN_ARCHIVE = btoa('PK-test-archive');
  const call = (path, options) => worker.fetch(new Request(new URL(path, origin), options), env);
  const mcp = async (method, params, headers = ownerHeader) => {
    const result = await call('/mcp', { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method, params,
    }) });
    assert.equal(result.status, 200);
    return result.json();
  };
  const pair = async () => {
    const response = await call('/pair', { method: 'POST', headers: browserForm });
    assert.equal(response.status, 200);
    const code = (await response.text()).match(/<textarea[^>]*>([^<]+)/)[1];
    const credentials = parsePairingCode(code);
    assert.equal(credentials.siteOrigin, origin);
    return deviceClient(credentials.siteOrigin, credentials, (url, init) => {
      assert.equal(init.headers['OAI-Sites-Authorization'], `Bearer ${bypassToken}`);
      return call(url.href, init);
    });
  };
  return { call, db, mcp, pair };
}

test('MCP discovery, owner authorization and fixed tool arguments', async (t) => {
  const { call, mcp } = prepareBridge(t);
  const discovery = await mcp('server/discover', {}, {});
  assert.deepEqual(discovery.result.supportedVersions, ['2026-07-28']);
  const list = await mcp('tools/list', {}, {});
  const actual = list.result.tools;
  assert.deepEqual(actual.map(tool => tool.name), ['pc_ping', 'unity_active_scene', 'unity_game_view', 'unity_import_chat_image', ...catalog.tools.map(tool => tool.name), ...gitTools.map(tool => tool.name)]);
  assert.deepEqual(actual.slice(4).map(tool => tool.inputSchema), [...catalog.tools, ...gitTools].map(tool => tool.inputSchema));
  const imageImport = actual.find(tool => tool.name === 'unity_import_chat_image');
  assert.deepEqual(imageImport._meta, { 'openai/fileParams': ['file'] });
  assert.deepEqual(imageImport.inputSchema.properties.file.required, ['download_url', 'file_id']);
  assert.equal(imageImport.annotations.readOnlyHint, false);
  assert.equal((await mcp('tools/call', {
    name: imageImport.name, arguments: { file: 'chat_upload://image_0', assetName: 'Schott' },
  })).error.code, -32602);
  assert.equal(actual.find(tool => tool.name === 'manage_gameobject').annotations.readOnlyHint, false);
  assert.equal(actual.find(tool => tool.name === 'manage_gameobject').annotations.destructiveHint, true);
  assert.equal((await mcp('tools/call', { name: 'pc_ping' }, {})).result.isError, true);
  assert.equal((await mcp('tools/call', { name: 'run_shell' })).error.code, -32602);
  assert.equal((await mcp('tools/call', { name: 'epoch_git_status' })).error.code, -32602);
  assert.equal((await mcp('tools/call', { name: 'manage_scene', arguments: [] })).error.code, -32602);
  assert.equal((await mcp('tools/call', { name: 'unity_active_scene', arguments: { action: 'save' } })).error.code, -32602);
  assert.equal((await mcp('tools/call', { name: 'unity_game_view', arguments: { camera: 'Other' } })).error.code, -32602);
  assert.equal((await call('/pair', { method: 'POST', headers: { Origin: origin } })).status, 403);
  assert.equal((await call('/pair', { method: 'POST', headers: { ...ownerHeader, Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await call('/pair', { method: 'POST', headers: { ...browserForm, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await call('/pair', { method: 'POST', headers: { ...ownerHeader, Origin: 'null' } })).status, 403);
  assert.equal((await call('/plugin.zip')).status, 403);
  const dashboard = await call('/', { headers: ownerHeader });
  assert.match(await dashboard.text(), /href="\/plugin\.zip"/);
  const archive = await call('/plugin.zip', { headers: ownerHeader });
  assert.equal(archive.headers.get('content-type'), 'application/zip');
  assert.equal(await archive.text(), 'PK-test-archive');
  assert.equal((await call('/api/device/poll', { method: 'POST', headers: ownerHeader })).status, 401);
  assert.match((await mcp('tools/call', { name: 'pc_ping' })).result.content[0].text, /kein PC gekoppelt/);
});

async function roundTrip(mcp, device, name, args, callUnity, callGit, readUnityResource, importImage, expectedArgs = args) {
  const pending = mcp('tools/call', { name, arguments: args });
  let job;
  for (let attempt = 0; attempt < 30 && !job; attempt += 1) {
    job = (await device('/api/device/poll', {})).job;
    if (!job) await delay(15);
  }
  assert.ok(job);
  assert.deepEqual(job.arguments, expectedArgs);
  assert.deepEqual(await device('/api/device/poll', {}), { job: null });
  if (name === 'pc_ping') {
    await assert.rejects(device('/api/device/result', { id: job.id, result: { ok: true, challenge: 'wrong' } }),
      { status: 400 });
  }
  const result = await runJob(job, callUnity, callGit, readUnityResource, importImage);
  assert.deepEqual(await device('/api/device/result', { id: job.id, result }), { accepted: true });
  return { job, reply: (await pending).result };
}

test('the paired client claims jobs once and returns fresh ping values', async (t) => {
  const { db, mcp, pair } = prepareBridge(t);
  const device = await pair();
  assert.match((await mcp('tools/call', { name: 'pc_ping' })).result.content[0].text, /offline/);
  await device('/api/device/poll', {});
  const callUnity = () => assert.fail('ping must not require Unity');
  const first = await roundTrip(mcp, device, 'pc_ping', {}, callUnity);
  const second = await roundTrip(mcp, device, 'pc_ping', {}, callUnity);
  assert.match(first.reply.content[0].text, new RegExp(first.job.challenge));
  assert.notEqual(first.job.challenge, second.job.challenge);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_job').get().n, 0);
});

test('all catalog names and nested inputs are routed to the local Unity client', async () => {
  const args = { text: 'Übung', value: { x: 2, uses: [true, null] } };
  const output = { content: [{type: 'text', text: 'ok'}] };
  for (const tool of catalog.tools) {
    const result = await runJob({ tool: tool.name, arguments: args, expires_at: Date.now() + 10_000 },
      async (name, observed) => {
        assert.equal(name, tool.name);
        assert.deepEqual(observed, args);
        return output;
      });
    assert.deepEqual(result, { ok: true, output });
  }
});

test('create, move, add a component and read back the scene in a single Unity session', async (t) => {
  const { mcp, pair } = prepareBridge(t);
  const device = await pair();
  await device('/api/device/poll', {});

  const observed = [];
  const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgZkAAAAASUVORK5CYII=';
  let playing = true;
  const created = { name: '', position: null, components: [] };
  const unityServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const message = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    observed.push({ method: message.method ?? req.method, params: message.params, session: req.headers['mcp-session-id'] });
    if (message.method === 'notifications/initialized') {
      res.writeHead(202, { Connection: 'close' }).end();
      return;
    }
    const initialized = message.method === 'initialize';
    const { name, arguments: args } = message.params ?? {};
    let result;
    if (initialized) {
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
    } else if (message.method === 'resources/read') {
      result = { contents: [{ uri: message.params.uri, mimeType: 'application/json',
        text: JSON.stringify({ success: true, data: message.params.uri === 'mcpforunity://editor/state'
          ? { unity: { is_batch_mode: false }, editor: { play_mode: { is_playing: playing } } }
          : { projectRoot: 'C:/Unity/Game' } }) }] };
    } else {
      let payload;
      if (name === 'manage_tools') payload = { activated: args.group };
      if (name === 'manage_gameobject' && args.action === 'create') {
        created.name = args.name;
        payload = { success: true };
      }
      if (name === 'manage_gameobject' && args.action === 'modify') {
        created.position = args.position;
        payload = { success: true };
      }
      if (name === 'manage_components') {
        created.components.push(args.component_type);
        payload = { success: true };
      }
      if (name === 'manage_scene' && args.action === 'get_hierarchy') payload = { success: true, data: created };
      if (name === 'manage_scene' && args.action === 'get_active') {
        payload = { success: true, data: {
          isLoaded: true, isDirty: true, name: 'Übung', path: 'Assets/Übung.unity', rootCount: 1,
        } };
      }
      if (name === 'find_gameobjects') payload = { success: false, message: 'Unity returned a tool error' };
      if (name === 'manage_camera') {
        const data = args.max_resolution === 720 ? screenshot + 'A'.repeat(1_480_000) : screenshot;
        result = { content: [{type: 'image', mimeType: 'image/png', data}] };
      } else {
        result = { content: [{type: 'text', text: JSON.stringify(payload)}], structuredContent: payload };
      }
    }
    const response = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    const type = initialized ? 'application/json' : 'text/event-stream';
    res.writeHead(200, {
      'content-type': type, 'mcp-session-id': 'fixture-session', Connection: 'close',
    });
    res.end(initialized ? response : `event: message\r\ndata: ${response}\r\n\r\n`);
  });
  unityServer.listen(0, '127.0.0.1');
  await once(unityServer, 'listening');
  t.after(() => new Promise(resolve => unityServer.close(resolve)));
  const { callTool, readResource } = createUnityMcp((url, options) => {
    assert.equal(url, 'http://127.0.0.1:8080/mcp');
    return fetch(`http://127.0.0.1:${unityServer.address().port}/mcp`, options);
  });
  const call = async (name, args) => (await roundTrip(mcp, device, name, args, callTool, undefined, readResource)).reply;

  assert.equal((await call('manage_gameobject', {
    action: 'create', name: 'PCBridge_Test', primitive_type: 'Cube',
  })).isError, undefined);
  await call('manage_gameobject', { action: 'modify', target: 'PCBridge_Test', position: [2, 1, 0] });
  await call('manage_components', { action: 'add', target: 'PCBridge_Test', component_type: 'Rigidbody' });
  assert.deepEqual((await call('manage_scene', { action: 'get_hierarchy' })).structuredContent.data, {
    name: 'PCBridge_Test', position: [2, 1, 0], components: ['Rigidbody'],
  });
  assert.match((await call('unity_active_scene', {})).content[0].text, /Unity-Szene: Übung/);
  assert.equal((await call('find_gameobjects', { search_term: 'Missing' })).isError, true);
  assert.deepEqual((await call('manage_camera', { action: 'screenshot' })).content,
    [{type: 'image', mimeType: 'image/png', data: screenshot}]);
  const gameView = await call('unity_game_view', {});
  assert.deepEqual(gameView.content, [
    { type: 'text', text: 'Unity Game View im Play Mode.' },
    { type: 'image', mimeType: 'image/png', data: screenshot },
  ]);
  const captures = observed.filter(entry => entry.params?.name === 'manage_camera').slice(1);
  assert.deepEqual(captures.map(entry => entry.params.arguments), [720, 448].map(resolution => ({
    action: 'screenshot', capture_source: 'game_view', include_image: true,
    max_resolution: resolution, output_folder: 'Temp/PC-Bridge-Captures',
  })));
  playing = false;
  assert.match((await call('unity_game_view', {})).content[0].text, /Starte den Play Mode/);
  assert.equal(observed.filter(entry => entry.params?.name === 'manage_camera').length, 3);
  assert.deepEqual(await readResource('mcpforunity://project/info'), {
    success: true, data: { projectRoot: 'C:/Unity/Game' },
  });
  assert.equal(observed.filter(entry => entry.method === 'initialize').length, 1);
  assert.deepEqual(observed.filter(entry => entry.params?.name === 'manage_tools')
    .map(entry => entry.params.arguments.group), catalog.groups);
  assert.ok(observed.slice(1).every(entry => entry.session === 'fixture-session'));
});

test('expired work stays closed and a new pairing revokes the old device', async (t) => {
  const { call, db, mcp, pair } = prepareBridge(t);
  const first = await pair();
  await first('/api/device/poll', {});
  db.prepare('UPDATE bridge_device SET last_seen = ?').run(Date.now() - 45_000);
  assert.match((await mcp('tools/call', { name: 'pc_ping' })).result.content[0].text, /offline/);
  const tokenHash = db.prepare('SELECT token_hash FROM bridge_device').get().token_hash;
  const id = 'deadbeef-dead-beef-dead-beefdeadbeef';
  db.prepare(`INSERT INTO bridge_job (id, device_hash, tool, challenge, created_at, expires_at, state)
    VALUES (?, ?, 'pc_ping', ?, ?, ?, 'queued')`)
    .run(id, tokenHash, '1234567890abcdef', 1, 2);
  assert.deepEqual(await first('/api/device/poll', {}), { job: null });
  await assert.rejects(first('/api/device/result', { id, result: { ok: true, challenge: '1234567890abcdef' } }),
    { status: 409 });
  const second = await pair();
  await assert.rejects(first('/api/device/poll', {}), { status: 401 });
  await second('/api/device/poll', {});
  const revoke = await call('/revoke', { method: 'POST', headers: browserForm });
  assert.equal(revoke.status, 200);
  await assert.rejects(second('/api/device/poll', {}), { status: 401 });
});

test('malformed pairing codes and unknown jobs are rejected locally', async () => {
  assert.throws(() => parsePairingCode('invalid!'), /Ungültiger/);
  const encodeCode = (siteOrigin) => Buffer.from(JSON.stringify({
    siteOrigin, siteToken: bypassToken, deviceToken: 'a'.repeat(64),
  })).toString('base64');
  for (const address of ['http://bridge.chatgpt.site', 'https://bridge.chatgpt.site.evil.example',
    'https://bridge.chatgpt.site:8080', 'https://name@bridge.chatgpt.site', 'https://bridge.chatgpt.site/other']) {
    assert.throws(() => parsePairingCode(encodeCode(address)), /ChatGPT Site/);
  }
  assert.equal(parsePairingCode(encodeCode('https://second-instance.chatgpt.site/')).siteOrigin,
    'https://second-instance.chatgpt.site');
  assert.deepEqual(await runJob({ tool: 'shell', expires_at: Date.now() + 2000 }, () => assert.fail('unexpected local call')),
    { ok: false, error: 'invalid_job' });
});

test('Git actions and exact commit inputs round-trip through the private relay', async (t) => {
  const { mcp, pair } = prepareBridge(t);
  const device = await pair();
  await device('/api/device/poll', {});
  const args = { branch: 'feature/move', expectedHead: 'ab'.repeat(20) };
  const data = { ...args, pushed: true };
  const output = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
  const { reply } = await roundTrip(mcp, device, 'project_git_push', args, null, async (name, received, signal) => {
    assert.equal(name, 'project_git_push');
    assert.deepEqual(received, args);
    assert.ok(signal instanceof AbortSignal);
    return output;
  });
  assert.deepEqual(reply, output);
});


test('import a ChatGPT file reference into the local Unity project as a sprite', async (t) => {
  const { mcp, pair } = prepareBridge(t);
  const device = await pair();
  await device('/api/device/poll', {});
  const root = await mkdtemp(join(tmpdir(), 'pc-bridge-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['Assets', 'Packages', 'ProjectSettings']) await mkdir(join(root, folder));
  await writeFile(join(root, 'Packages/manifest.json'), '{}');
  await writeFile(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.6.10f1');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgZkAAAAASUVORK5CYII=', 'base64');
  const path = 'Assets/Art/ChatImports/Schott.png';
  const guid = 'be'.repeat(16);
  const calls = [];
  const downloads = [];
  let playing = false;
  const unity = {
    async readResource(uri) {
      if (uri === 'mcpforunity://project/info') return { success: true, data: { projectRoot: root } };
      assert.equal(uri, 'mcpforunity://editor/state');
      return { success: true, data: { editor: { play_mode: { is_playing: playing } } } };
    },
    async callTool(name, args) {
      calls.push({ name, args });
      assert.deepEqual(await readFile(join(root, path)), png);
      return { structuredContent: { success: true, data: { guid } } };
    },
  };
  const file = {
    download_url: 'https://files.oaiusercontent.com/file-test?fake-signature=1',
    file_id: 'file-test',
    file_name: '../../wrong-target.exe',
    mime_type: 'image/png',
  };
  const verifyDownload = async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    downloads.push(url.hostname);
    if (url.hostname === 'files.oaiusercontent.com') {
      return Response.redirect('https://oaisdmntprtest.blob.core.windows.net/asset.png');
    }
    assert.equal(url.hostname, 'oaisdmntprtest.blob.core.windows.net');
    return new Response(png);
  };
  const importer = createUnityImageImporter(unity, undefined, verifyDownload);
  const args = { file, assetName: 'Schott', pixelsPerUnit: 128 };
  const expectedArgs = { ...args, file: { download_url: file.download_url } };
  const { reply } = await roundTrip(mcp, device, 'unity_import_chat_image', args,
    null, null, null, importer, expectedArgs);
  assert.equal(reply.isError, false);
  assert.deepEqual(reply.structuredContent, { path, guid, width: 1, height: 1, pixelsPerUnit: 128, importedAs: 'Sprite' });
  assert.deepEqual(downloads, ['files.oaiusercontent.com', 'oaisdmntprtest.blob.core.windows.net']);
  assert.deepEqual(calls, [
    { name: 'manage_asset', args: { action: 'import', path } },
    { name: 'manage_texture', args: {
      action: 'set_import_settings', path, as_sprite: { pixels_per_unit: 128 },
    } },
  ]);
  assert.deepEqual(await readFile(join(root, path)), png);

  const signal = AbortSignal.timeout(5_000);
  const duplicate = await importer(expectedArgs, signal);
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.structuredContent.error, /bereits vergeben/);
  assert.deepEqual(await readFile(join(root, path)), png);
  const unsafe = await importer({ ...expectedArgs, file: { download_url: 'http://127.0.0.1:8080/mcp' } }, signal);
  assert.match(unsafe.structuredContent.error, /Downloadverweis/);
  playing = true;
  const refused = await importer(expectedArgs, signal);
  assert.match(refused.structuredContent.error, /Play Mode/);
  playing = false;
  const wrongProject = createUnityImageImporter(unity, join(root, 'Assets'), verifyDownload);
  assert.match((await wrongProject(expectedArgs, signal)).structuredContent.error, /stimmt nicht/);
  if (process.platform !== 'win32') {
    await rm(join(root, 'Assets/Art/ChatImports'), { recursive: true });
    await symlink(join(root, 'Packages'), join(root, 'Assets/Art/ChatImports'));
    assert.match((await importer(expectedArgs, signal)).structuredContent.error, /symbolischen Link/);
  }
  assert.equal(calls.length, 2);
});
