import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import worker from '../worker/index.js';
import { deviceClient, parsePairingCode, runJob } from '../client/pc-bridge.mjs';

const origin = 'https://bridge-test.chatgpt.site';
const owner = 'owner@example.com';
const ownerHeader = { 'oai-authenticated-user-email': owner };
const bypassToken = 'sites-dev-test-token-123456';
const browserForm = { ...ownerHeader, Origin: 'null', 'Sec-Fetch-Site': 'same-origin' };

function prepareBridge(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0000_bridge.sql', import.meta.url), 'utf8'));
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
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['pc_ping', 'epoch_git_status']);
  assert.ok(list.result.tools.every((tool) => tool.annotations.readOnlyHint));
  assert.equal((await mcp('tools/call', { name: 'pc_ping' }, {})).result.isError, true);
  assert.equal((await mcp('tools/call', { name: 'run_shell' })).error.code, -32602);
  assert.equal((await mcp('tools/call', { name: 'epoch_git_status', arguments: { path: 'C:\\Other' } })).error.code, -32602);
  assert.equal((await call('/pair', { method: 'POST', headers: { Origin: origin } })).status, 403);
  assert.equal((await call('/pair', { method: 'POST', headers: { ...ownerHeader, Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await call('/pair', { method: 'POST', headers: { ...browserForm, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await call('/pair', { method: 'POST', headers: { ...ownerHeader, Origin: 'null' } })).status, 403);
  assert.equal((await call('/api/device/poll', { method: 'POST', headers: ownerHeader })).status, 401);
  assert.match((await mcp('tools/call', { name: 'pc_ping' })).result.content[0].text, /kein PC gekoppelt/);
});

test('paired client claims once and returns a fresh ping and real Git status', async (t) => {
  const { db, mcp, pair } = prepareBridge(t);
  const device = await pair();
  assert.match((await mcp('tools/call', { name: 'pc_ping' })).result.content[0].text, /offline/);
  assert.deepEqual(await device('/api/device/poll', {}), { job: null });

  const repo = mkdtempSync(join(tmpdir(), 'pc-bridge-git-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-b', 'bridge-test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Bridge Fixture');
  writeFileSync(join(repo, 'tracked.txt'), 'baseline\n');
  git('add', 'tracked.txt');
  git('commit', '-m', 'baseline');
  git('mv', 'tracked.txt', 'renamed.txt');
  writeFileSync(join(repo, 'renamed.txt'), 'changed after staging\n');
  writeFileSync(join(repo, 'new.txt'), 'untracked\n');
  mkdirSync(join(repo, 'subfolder'));

  async function roundTrip(tool) {
    const pending = mcp('tools/call', { name: tool });
    let job;
    for (let attempt = 0; attempt < 30 && !job; attempt += 1) {
      job = (await device('/api/device/poll', {})).job;
      if (!job) await delay(15);
    }
    assert.ok(job);
    assert.deepEqual(await device('/api/device/poll', {}), { job: null });
    if (tool === 'pc_ping') {
      await assert.rejects(device('/api/device/result', { id: job.id, result: { ok: true, challenge: 'wrong' } }),
        { status: 400 });
    }
    const result = await runJob(job, repo);
    assert.deepEqual(await device('/api/device/result', { id: job.id, result }), { accepted: true });
    const reply = (await pending).result;
    assert.equal(reply.isError, undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bridge_job').get().count, 0);
    return { job, text: reply.content[0].text };
  }

  const ping = await roundTrip('pc_ping');
  assert.match(ping.text, new RegExp(ping.job.challenge));
  assert.notEqual(ping.job.challenge, (await roundTrip('pc_ping')).job.challenge);
  const status = await roundTrip('epoch_git_status');
  assert.equal(status.text, 'Branch: bridge-test\nVorgemerkt: 1\nNicht vorgemerkt: 1\nUnversioniert: 1\nKonflikte: 0');
  assert.doesNotMatch(status.text, /renamed|tracked\.txt|pc-bridge-git/);
  assert.deepEqual(await runJob({ ...status.job, expires_at: Date.now() + 1000 }, join(repo, 'subfolder')),
    { ok: false, error: 'repo_invalid' });
  assert.deepEqual(await runJob({ ...status.job, expires_at: 1 }, repo), { ok: false, error: 'expired' });
});

test('expired work stays closed and a new pairing revokes the old device', async (t) => {
  const { call, db, mcp, pair } = prepareBridge(t);
  const first = await pair();
  await first('/api/device/poll', {});
  db.prepare('UPDATE bridge_device SET last_seen = ?').run(Date.now() - 15_000);
  assert.match((await mcp('tools/call', { name: 'pc_ping' })).result.content[0].text, /offline/);
  const tokenHash = db.prepare('SELECT token_hash FROM bridge_device').get().token_hash;
  const id = 'deadbeef-dead-beef-dead-beefdeadbeef';
  db.prepare(`INSERT INTO bridge_job VALUES (?, ?, 'pc_ping', ?, ?, ?, 'queued', NULL)`)
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
  assert.deepEqual(await runJob({ tool: 'shell', expires_at: Date.now() + 2000 }, process.cwd()),
    { ok: false, error: 'invalid_job' });
});
