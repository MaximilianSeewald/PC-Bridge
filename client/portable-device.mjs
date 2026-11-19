import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { startStdioMcp } from './mcp-client.mjs';

const namePattern = /^[A-Za-z0-9_.-]{1,100}$/;

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function validNames(list) {
  return Array.isArray(list) && list.length && list.every(name => typeof name === 'string' && namePattern.test(name));
}

export function validateConfig(config, folder) {
  const relay = new URL(config.relay);
  if (relay.protocol !== 'https:' || relay.username || relay.password || relay.pathname !== '/' ||
      relay.search || relay.hash) throw new Error('relay muss eine HTTPS-Origin sein.');
  const servers = new Map();
  for (const [name, server] of Object.entries(config.servers ?? {})) {
    const args = server?.args ?? [];
    const vars = server?.env ?? {};
    if (!namePattern.test(name) || typeof server?.command !== 'string' || !server.command.trim() ||
        !Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !validNames(server.tools) ||
        !vars || typeof vars !== 'object' || Array.isArray(vars) ||
        Object.values(vars).some(value => typeof value !== 'string')) {
      throw new Error('Ungültige Konfiguration des lokalen Servers ' + name + '.');
    }
    servers.set(name, {
      command: server.command,
      args,
      tools: new Set(server.tools),
      cwd: resolve(folder, server.cwd || '.'),
      env: { ...process.env, ...vars },
    });
  }
  if (!servers.size) throw new Error('Konfiguriere mindestens einen lokalen MCP-Server.');
  return { origin: relay.origin, servers };
}

export function createLocalTools(servers) {
  const connections = new Map();

  async function connection(name) {
    const existing = connections.get(name);
    if (existing?.isRunning()) return existing;
    const { command, args, cwd, env } = servers.get(name);
    const opened = await startStdioMcp(command, args, { cwd, env, timeout: 12_000 });
    connections.set(name, opened);
    return opened;
  }

  async function discover(name, server) {
    const client = await connection(name);
    const results = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const response = await client.request('tools/list', cursor ? { cursor } : {});
      for (const tool of response.tools) {
        if (server.tools.has(tool.name)) {
          results.push({ server: name, name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
        }
      }
      cursor = response.nextCursor;
      if (!cursor) return results;
    }
    throw new Error('Tool list pagination limit exceeded');
  }

  async function run(job) {
    if (!Number.isFinite(job.expires) || job.expires <= Date.now()) return toolError('The request expired.');
    if (job.type === 'list') {
      const discovered = await Promise.allSettled([...servers].map(async ([name, server]) => discover(name, server)));
      const list = { tools: [], unavailable: [] };
      [...servers.keys()].forEach((name, i) => {
        const result = discovered[i];
        if (result.status === 'fulfilled') list.tools.push(...result.value);
        else list.unavailable.push(name);
      });
      return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: list };
    }
    if (job.type !== 'call' || !servers.get(job.server)?.tools.has(job.tool) ||
        !job.args || typeof job.args !== 'object' || Array.isArray(job.args)) {
      return toolError('The tool is not allowed on this PC.');
    }
    try {
      const client = await connection(job.server);
      const result = await client.request('tools/call', { name: job.tool, arguments: job.args });
      if (!Array.isArray(result?.content)) return toolError('The local MCP server returned an invalid result.');
      return result;
    } catch {
      return toolError('The local MCP server could not complete the tool call.');
    }
  }

  return {
    async run(job) {
      const result = await run(job);
      return Buffer.byteLength(JSON.stringify(result)) < 88 * 1024
        ? result : toolError('The local MCP result exceeds the transfer limit.');
    },
    close() {
      for (const client of connections.values()) client.close();
    },
  };
}

export function deviceRequest(origin, deviceKey, fetcher = fetch) {
  return async (path, body) => {
    const response = await fetcher(new URL(path, origin), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(6_000),
      headers: { Authorization: 'Bearer ' + deviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = new Error('Relay HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
}

async function readDeviceKey() {
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: Boolean(process.stdin.isTTY) });
  process.stdout.write('Geräteschlüssel eingeben: ');
  try {
    return (await input.question('')).trim();
  } finally {
    input.close();
    process.stdout.write('\n');
  }
}

async function main(configPath) {
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')), dirname(resolve(configPath)));
  const token = await readDeviceKey();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Ungültiger Geräteschlüssel.');
  const request = deviceRequest(config.origin, token);
  const local = createLocalTools(config.servers);
  let online = false;
  try {
    while (true) {
      try {
        const { job } = await request('/device/poll', {});
        if (!online) console.log('Verbunden mit ' + config.origin);
        online = true;
        if (job) {
          const result = await local.run(job);
          await request('/device/result', { id: job.id, result });
        }
      } catch (error) {
        if (error.status === 401) throw new Error('Das Relay hat den Geräteschlüssel abgelehnt.');
        if (error.status === 409) console.log('Der Auftrag ist bereits geschlossen.');
        else {
          if (online) console.log('Verbindung unterbrochen. Neuer Versuch folgt.');
          online = false;
          await delay(2500);
        }
      }
      await delay(1500);
    }
  } finally {
    local.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2] || 'pc-bridge.config.json').catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
