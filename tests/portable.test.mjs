import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateConfig, createLocalTools, deviceRequest } from '../client/portable-device.mjs';
import { createRelay } from '../relay/server.mjs';
import { oauthVerifier } from '../relay/oauth.mjs';

const issuer = 'https://login.example.test';
const origin = 'https://relay.example.test';
const scope = 'pcbridge:invoke';
const digest = text => createHash('sha256').update(text).digest('hex');

test('OAuth tokens require the correct signer, audience, scope and expiration', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key1', alg: 'RS256' };
  const audience = origin + '/mcp';
  const verifier = oauthVerifier({ issuer, resource: audience, scope }, async (url) => {
    if (url.pathname.endsWith('openid-configuration')) return Response.json({ issuer, jwks_uri: issuer + '/keys' });
    assert.equal(url.href, issuer + '/keys');
    return Response.json({ keys: [jwk] });
  });
  const token = (claims = {}, signer = privateKey) => {
    const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
    const header = encode({ alg: 'RS256', kid: 'key1' });
    const payload = encode({ iss: issuer, aud: audience, sub: 'owner1', scope,
      exp: Math.floor(Date.now() / 1000) + 60, ...claims });
    const unsigned = header + '.' + payload;
    return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), signer).toString('base64url');
  };
  assert.equal(await verifier(token()), 'owner1');
  assert.equal(await verifier(token({ aud: 'another-api' })), null);
  assert.equal(await verifier(token({ scope: 'openid' })), null);
  assert.equal(await verifier(token({ exp: 0 })), null);
  assert.equal(await verifier(token({ iss: 'https://untrusted.example.test' })), null);
  assert.equal(await verifier(token({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)), null);
});

test('web MCP call crosses the relay to a real stdio process and stays isolated by account', async (t) => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const relay = createRelay({
    origin, issuer, scope, deviceHashes: { owner1: digest(first), owner2: digest(second) },
    verifyToken: async (token) => ({ 'session-one': 'owner1', 'session-two': 'owner2' })[token] ?? null,
  }).listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => relay.close());
  const url = 'http://127.0.0.1:' + relay.address().port;
  const endpoint = await fetch(url + '/.well-known/oauth-protected-resource/mcp');
  assert.equal((await endpoint.json()).resource, origin + '/mcp');
  const rejected = await fetch(url + '/mcp', { method: 'POST' });
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers.get('www-authenticate'), /oauth-protected-resource/);
  const pc1 = deviceRequest(url, first);
  const pc2 = deviceRequest(url, second);
  await pc1('/device/poll', {});
  await pc2('/device/poll', {});
  const path = fileURLToPath(new URL('../client/mcp-server.mjs', import.meta.url));
  const repo = await mkdtemp(join(tmpdir(), 'portable-epoch-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'portable-test', repo], { stdio: 'ignore' });
  const config = validateConfig({
    relay: origin, servers: { epoch: { command: process.execPath, args: [path, repo], tools: ['epoch_git_status'] } },
  }, dirname(path));
  const local = createLocalTools(config.servers);
  t.after(local.close);

  async function call(name, args) {
    const response = await fetch(url + '/mcp', { method: 'POST', headers: {
      Authorization: 'Bearer session-one', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await response.json()).result;
  }

  async function roundTrip(name, args) {
    const incoming = call(name, args);
    let job;
    for (let i = 0; i < 30 && !job; i += 1) {
      assert.equal((await pc2('/device/poll', {})).job, null);
      job = (await pc1('/device/poll', {})).job;
      if (!job) await delay(20);
    }
    assert.ok(job);
    await assert.rejects(pc2('/device/result', { id: job.id, result: { content: [] } }), { status: 409 });
    await pc1('/device/result', { id: job.id, result: await local.run(job) });
    return incoming;
  }

  const listed = await roundTrip('list_local_mcp_tools', {});
  assert.deepEqual(listed.structuredContent.tools.map(({ server, name }) => [server, name]), [['epoch', 'epoch_git_status']]);
  const blocked = await roundTrip('call_local_mcp_tool', { server: 'epoch', tool: 'pc_ping' });
  assert.equal(blocked.isError, true);
  const git = await roundTrip('call_local_mcp_tool', { server: 'epoch', tool: 'epoch_git_status' });
  assert.deepEqual(git.structuredContent, { ok: true, branch: 'portable-test', staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
});
