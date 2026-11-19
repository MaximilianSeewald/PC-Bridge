import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { oauthVerifier } from './oauth.mjs';

const protocol = '2026-07-28';
const legacyProtocol = '2025-11-25';
const validName = /^[A-Za-z0-9_.-]{1,100}$/;
const identifier = { type: 'string', pattern: validName.source };
const tools = [
  {
    name: 'list_local_mcp_tools',
    description: 'List the local MCP tools allowed by the paired PC.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'call_local_mcp_tool',
    description: 'Call a local MCP tool from the list returned by list_local_mcp_tools. The tool may have side effects.',
    inputSchema: {
      type: 'object', properties: { server: identifier, tool: identifier, arguments: { type: 'object' } },
      required: ['server', 'tool'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

const hash = (text) => createHash('sha256').update(text).digest('hex');

function bearer(req) {
  return req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers,
  });
  res.end(JSON.stringify(value));
}

async function readJson(req, limit = 96 * 1024) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return null;
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) parts.push(chunk);
    else {
      req.resume();
      return null;
    }
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    return null;
  }
}

function localJob(name, args) {
  if (!record(args)) return null;
  if (name === tools[0].name && !Object.keys(args).length) return { type: 'list' };
  if (name === tools[1].name && typeof args.server === 'string' && validName.test(args.server) &&
      typeof args.tool === 'string' && validName.test(args.tool) &&
      (args.arguments === undefined || record(args.arguments)) &&
      Object.keys(args).every(key => ['server', 'tool', 'arguments'].includes(key))) {
    return { type: 'call', server: args.server, tool: args.tool, args: args.arguments ?? {} };
  }
  return null;
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createRelay({ origin, issuer, scope, deviceHashes, verifyToken, jobTimeout = 24_000 }) {
  const resource = origin + '/mcp';
  const metadataPath = '/.well-known/oauth-protected-resource/mcp';
  const metadata = { resource, authorization_servers: [issuer], scopes_supported: [scope], bearer_methods_supported: ['header'] };
  const challenge = { 'WWW-Authenticate': 'Bearer resource_metadata="' + origin + metadataPath + '", scope="' + scope + '"' };
  const ownersByHash = new Map();
  for (const [subject, digest] of Object.entries(deviceHashes)) {
    if (!subject || !/^[a-f0-9]{64}$/.test(digest) || ownersByHash.has(digest)) {
      throw new Error('Each OAuth subject needs a unique SHA-256 device token hash.');
    }
    ownersByHash.set(digest, subject);
  }
  const devices = new Map();
  const orders = new Map();

  async function mcp(req, res) {
    const subject = await verifyToken(bearer(req));
    if (!subject) return json(res, 401, { error: 'authorization_required' }, challenge);
    if (!Object.hasOwn(deviceHashes, subject)) return json(res, 403, { error: 'owner_not_provisioned' });
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const rpc = await readJson(req);
    const reply = result => json(res, 200, { jsonrpc: '2.0', id: rpc?.id ?? null, result });
    const reject = (code, message) => json(res, 200, { jsonrpc: '2.0', id: rpc?.id ?? null, error: { code, message } });
    if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return reject(-32600, 'Invalid request');
    if (rpc.id === undefined) return res.writeHead(202).end();
    switch (rpc.method) {
      case 'server/discover':
        return reply({ supportedVersions: [protocol], capabilities: { tools: {} } });
      case 'initialize':
        return reply({ protocolVersion: legacyProtocol, capabilities: { tools: {} },
          serverInfo: { name: 'pc-bridge-relay', version: '0.3.0' } });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools });
      case 'tools/call': {
        const command = localJob(rpc.params?.name, rpc.params?.arguments ?? {});
        if (!command) return reject(-32602, 'Invalid tool or arguments');
        if (Date.now() - (devices.get(subject) ?? 0) > 15_000) return reply(toolError('The paired PC is offline.'));
        if ([...orders.values()].some(job => job.subject === subject)) {
          return reply(toolError('A request for this PC is already running.'));
        }

        const id = randomUUID();
        const result = await new Promise(resolve => {
          const finish = value => {
            clearTimeout(timer);
            res.off('close', cancelled);
            orders.delete(id);
            resolve(value);
          };
          const cancelled = () => finish(null);
          const timer = setTimeout(() => finish(toolError('The paired PC did not respond in time.')), jobTimeout);
          res.once('close', cancelled);
          orders.set(id, { id, subject, command, expires: Date.now() + jobTimeout, claimed: false, finish });
        });
        if (result && !res.destroyed) return reply(result);
        return;
      }
      default:
        return reject(-32601, 'Method not found');
    }
  }

  async function device(req, res, path) {
    const key = bearer(req);
    const owner = key && /^[a-f0-9]{64}$/.test(key) && ownersByHash.get(hash(key));
    if (!owner) return json(res, 401, { error: 'device_not_authorized' });
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    if (path === '/device/poll') {
      devices.set(owner, Date.now());
      const job = [...orders.values()].find(x => x.subject === owner && !x.claimed && x.expires > Date.now());
      if (!job) return json(res, 200, { job: null });
      job.claimed = true;
      return json(res, 200, { job: { id: job.id, expires: job.expires, ...job.command } });
    }
    const body = await readJson(req);
    const job = orders.get(body?.id);
    if (!job || job.subject !== owner || !job.claimed || job.expires <= Date.now()) {
      return json(res, 409, { error: 'job_closed' });
    }
    if (!record(body.result) || !Array.isArray(body.result.content)) {
      return json(res, 400, { error: 'invalid_result' });
    }
    job.finish(body.result);
    return json(res, 200, { accepted: true });
  }

  return createServer(async (req, res) => {
    try {
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === metadataPath) return json(res, 200, metadata);
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok' });
      if (path === '/mcp') return await mcp(req, res);
      if (path === '/device/poll' || path === '/device/result') return await device(req, res, path);
      return json(res, 404, { error: 'not_found' });
    } catch {
      if (!res.headersSent && !res.destroyed) json(res, 500, { error: 'internal_error' });
    }
  });
}

function required(env, key) {
  if (!env[key]) throw new Error('Missing environment variable: ' + key);
  return env[key];
}

async function main(env) {
  const origin = new URL(required(env, 'PC_BRIDGE_ORIGIN'));
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash) throw new Error('PC_BRIDGE_ORIGIN must be an HTTPS origin.');
  const issuer = required(env, 'PC_BRIDGE_ISSUER');
  const scope = env.PC_BRIDGE_SCOPE || 'pcbridge:invoke';
  if (!/^[A-Za-z0-9_.:-]+$/.test(scope)) throw new Error('Invalid OAuth scope.');
  const deviceHashes = JSON.parse(await readFile(required(env, 'PC_BRIDGE_DEVICES_FILE'), 'utf8'));
  if (!record(deviceHashes) || !Object.keys(deviceHashes).length) throw new Error('Missing OAuth subject to device mapping.');
  const resource = origin.origin + '/mcp';
  const listen = env.PC_BRIDGE_LISTEN || '127.0.0.1';
  const port = Number(env.PC_BRIDGE_PORT || 8787);
  createRelay({ origin: origin.origin, issuer, scope, deviceHashes,
    verifyToken: oauthVerifier({ issuer, resource, scope }) }).listen(port, listen, () => {
    console.log('PC-Bridge Relay is listening on ' + listen + ':' + port);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
