import { spawn } from 'node:child_process';

const blenderTools = new Map([
  ['blender_scene_info', { name: 'get_scene_info', arguments: {} }],
  ['blender_viewport', { name: 'look', arguments: { mode: 'viewport', shading: 'solid', max_size: 480 } }],
]);
export const blenderToolNames = new Set(blenderTools.keys());

// Leave room for the outer job envelope and keep the payload under the relay's byte limit.
const maxLineBytes = 1_400_000;

function failure(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function callStdio(params, signal, spawnProcess) {
  signal.throwIfAborted();
  const child = spawnProcess('uvx', ['mcp-for-blender@2.3.1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      BLENDER_HOST: '127.0.0.1',
      BLENDER_PORT: '9876',
      BLENDER_MCP_APPS: '0',
      BLENDER_MCP_DISABLE_TELEMETRY: '1',
    },
  });
  let active;
  let failed;
  let buffer = '';
  let nextId = 0;

  function fail(error) {
    failed ??= error;
    active?.reject(failed);
    active = undefined;
  }
  const abort = () => fail(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', fail);
  child.once('close', () => fail(new Error('Blender MCP closed its stdio session.')));
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (failed) return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxLineBytes) {
        fail(new Error('Die Antwort von Blender MCP ist zu groß.'));
        return;
      }
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (!active || message?.id !== active.id) continue;
        const { resolve, reject } = active;
        active = undefined;
        if (message.error) reject(new Error('Blender MCP hat den Aufruf abgelehnt.'));
        else resolve(message.result);
      } catch (error) {
        fail(error);
        return;
      }
    }
    // The relay bounds the bytes, including multibyte characters in scene names.
    if (Buffer.byteLength(buffer) > maxLineBytes) fail(new Error('Die Antwort von Blender MCP ist zu groß.'));
  });

  function send(message) {
    if (failed) throw failed;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      active = { id, resolve, reject };
      send({ id, method, params });
    });
  }

  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'pc-bridge', version: '0.8.0' },
    });
    if (typeof initialized?.protocolVersion !== 'string' || !initialized.capabilities?.tools) {
      throw new Error('Blender MCP hat keine Werkzeuge gemeldet.');
    }
    send({ method: 'notifications/initialized' });
    return await request('tools/call', params);
  } finally {
    signal.removeEventListener('abort', abort);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const stop = setTimeout(() => child.kill(), 500);
      stop.unref();
      child.once('close', () => clearTimeout(stop));
    }
  }
}

export function createBlenderMcp(spawnProcess = spawn) {
  return async (tool, signal) => {
    const params = blenderTools.get(tool);
    if (!params) return failure('Unbekanntes Blender-Werkzeug.');
    try {
      const result = await callStdio(params, signal, spawnProcess);
      if (!Array.isArray(result?.content)) return failure('Blender MCP hat keine gültige Antwort geliefert.');
      const content = result.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map(({ text }) => ({ type: 'text', text }));
      // get_scene_info returns connection failures as text in MCP for Blender 2.3.1.
      const sceneError = tool === 'blender_scene_info' && /^Error(?::| getting scene info:)/.test(content[0]?.text);
      if (result.isError || sceneError) {
        return failure(content.map(({ text }) => text).join('\n').slice(0, 1000) ||
          'Blender MCP meldet einen Fehler. Prüfe die Verbindung im Blender-Add-on.');
      }

      if (tool === 'blender_viewport') {
        const image = result.content.find((block) => block?.type === 'image' &&
          block.mimeType === 'image/png' && typeof block.data === 'string' && block.data.startsWith('iVBORw0KGgo'));
        if (!image) return failure('Blender MCP hat kein Viewport-PNG geliefert. Öffne in Blender eine 3D-Ansicht.');
        content.unshift({ type: 'image', mimeType: 'image/png', data: image.data });
      }
      return content.length ? { content } : failure('Blender MCP hat keine Szenendaten geliefert.');
    } catch (error) {
      if (error.code === 'ENOENT') return failure('uvx fehlt im PATH. Installiere uv und starte PC-Bridge in einem neuen Fenster.');
      if (signal.aborted) return failure('Blender MCP hat nicht rechtzeitig geantwortet. Prüfe, ob Blender geöffnet und das Add-on verbunden ist.');
      return failure('PC-Bridge konnte Blender MCP nicht aufrufen. Prüfe die Verbindung im Blender-Add-on auf dem lokalen Port 9876.');
    }
  };
}
