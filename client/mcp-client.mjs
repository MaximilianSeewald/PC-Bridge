import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const version = '2025-11-25';
const server = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));

export async function startLocalMcp(repo) {
  const child = spawn(process.execPath, [server, ...(repo ? [repo] : [])], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  function close(reason = new Error('Lokaler MCP-Server geschlossen.')) {
    if (closed) return;
    closed = true;
    for (const finish of pending.values()) finish(reason);
    output.close();
    child.kill();
  }

  child.on('error', close);
  child.on('exit', () => close());
  child.stdin.on('error', close);
  output.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      close(new Error('Ungültiges MCP-Protokoll vom lokalen Server.'));
      return;
    }
    const finish = pending.get(message?.id);
    if (!finish) return;
    if (message.jsonrpc !== '2.0' || message.error) {
      finish(new Error('Lokaler MCP-Aufruf fehlgeschlagen.'));
      return;
    }
    finish(null, message.result);
  });

  const write = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

  function request(method, params) {
    if (closed) return Promise.reject(new Error('Lokaler MCP-Server ist offline.'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => close(new Error('Der lokale MCP-Server antwortet nicht.')), 8_000);
      pending.set(id, (error, result) => {
        clearTimeout(timer);
        pending.delete(id);
        if (error) reject(error);
        else resolve(result);
      });
      write({ id, method, params });
    });
  }

  try {
    const initialized = await request('initialize', {
      protocolVersion: version, capabilities: {}, clientInfo: { name: 'pc-bridge', version: '0.2.0' },
    });
    if (initialized?.protocolVersion !== version || !initialized.capabilities?.tools) {
      throw new Error('Der lokale Prozess unterstützt die erwartete MCP-Version nicht.');
    }
    write({ method: 'notifications/initialized' });
  } catch (error) {
    close(error);
    throw error;
  }

  return {
    request,
    close,
    isRunning: () => !closed,
    async callTool(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      if (typeof result?.structuredContent?.ok !== 'boolean') {
        throw new Error('Der lokale MCP-Server meldet kein lesbares Ergebnis.');
      }
      return result.structuredContent;
    },
  };
}
