import catalog from './unity-tools.json' with { type: 'json' };

const endpoint = 'http://127.0.0.1:8080/mcp';
const protocolVersion = '2025-11-25';
const supportedVersions = new Set(['2025-03-26', '2025-06-18', protocolVersion]);
const responseLimit = 1_250_000;
class UnityResponseTooLarge extends Error {}
export const unityToolNames = new Set(catalog.tools.map(tool => tool.name));

async function rpcResponse(response, id) {
  const type = response.headers.get('content-type')?.split(';', 1)[0];
  if (type !== 'application/json' && type !== 'text/event-stream') {
    await response.body?.cancel();
    throw new Error('Unity MCP antwortet mit einem unerwarteten Format.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      size += value?.byteLength ?? 0;
      if (size > responseLimit) throw new UnityResponseTooLarge('Unity MCP meldet eine zu große Antwort.');
      buffer += decoder.decode(value, { stream: !done });
      if (type === 'application/json' && done) return JSON.parse(buffer);
      if (type === 'text/event-stream') {
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const data = buffer.slice(0, boundary.index).split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (data) {
            const message = JSON.parse(data);
            if (message.id === id) return message;
          }
        }
      }
      if (done) throw new Error('Unity MCP hat den Aufruf nicht beantwortet.');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function toolFailure(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function toolPayload(output) {
  if (output.structuredContent) return output.structuredContent.result ?? output.structuredContent;
  try {
    return JSON.parse(output.content.find(item => item.type === 'text')?.text ?? '{}');
  } catch {
    return {};
  }
}

export function createUnityMcp(fetchImpl = fetch) {
  let session;
  let nextId = 0;

  async function send(headers, signal, method, params, id) {
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers, signal, redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok || id === undefined) await response.body?.cancel();
    if (!response.ok) throw new Error('Unity MCP konnte den Aufruf nicht annehmen.');
    if (id === undefined) return;
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) headers['MCP-Session-Id'] = sessionId;
    const message = await rpcResponse(response, id);
    if (message.jsonrpc !== '2.0' || message.id !== id || (!message.result && !message.error)) {
      throw new Error('Unity MCP meldet eine ungültige JSON-RPC-Antwort.');
    }
    return message;
  }

  async function requestTool(headers, signal, name, args) {
    const message = await send(headers, signal, 'tools/call', { name, arguments: args }, ++nextId);
    if (message.error) return toolFailure(message.error.message || 'Unity MCP hat den Aufruf abgelehnt.');
    const output = message.result;
    if (!Array.isArray(output.content)) throw new Error('Unity MCP hat kein Tool-Ergebnis geliefert.');
    const payload = toolPayload(output);
    return payload?.success === false || typeof payload?.error === 'string'
      ? { ...output, isError: true }
      : output;
  }

  async function closeSession(headers) {
    if (headers?.['MCP-Session-Id']) {
      await fetchImpl(endpoint, {
        method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(500),
      }).then(response => response.body?.cancel()).catch(() => {});
    }
  }

  async function openSession(signal) {
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    try {
      const { result: init } = await send(headers, signal, 'initialize', {
        protocolVersion, capabilities: {}, clientInfo: { name: 'pc-bridge', version: '0.9.0' },
      }, ++nextId);
      if (!supportedVersions.has(init?.protocolVersion) || !init.capabilities?.tools) {
        throw new Error('Dieser Unity-MCP-Server unterstützt die erwarteten Tools nicht.');
      }
      headers['MCP-Protocol-Version'] = init.protocolVersion;
      await send(headers, signal, 'notifications/initialized');
      for (const group of catalog.groups) {
        const result = await requestTool(headers, signal, 'manage_tools', { action: 'activate', group });
        if (result.isError || toolPayload(result)?.activated !== group) {
          throw new Error('Unity MCP konnte die Werkzeuggruppen nicht aktivieren.');
        }
      }
      return headers;
    } catch (error) {
      await closeSession(headers);
      throw error;
    }
  }

  async function withSession(operation, signal) {
    try {
      session ??= await openSession(signal);
      return await operation(session);
    } catch (error) {
      if (error instanceof UnityResponseTooLarge) throw error;
      const previous = session;
      session = undefined;
      await closeSession(previous);
      throw error;
    }
  }

  return {
    async callTool(name, args, timeout = 29_000) {
      if (!unityToolNames.has(name)) return toolFailure('Dieses Unity-MCP-Tool ist nicht im PC-Bridge-Katalog enthalten.');
      const signal = typeof timeout === 'number' ? AbortSignal.timeout(timeout) : timeout;
      return withSession(headers => requestTool(headers, signal, name, args), signal);
    },
    async readResource(uri, signal) {
      const reply = await withSession(headers => send(headers, signal, 'resources/read', { uri }, ++nextId), signal);
      const content = reply.result?.contents?.find(entry => entry.uri === uri && typeof entry.text === 'string');
      if (!content) throw new Error('Unity MCP hat den Editorstatus nicht geliefert.');
      return JSON.parse(content.text);
    },
  };
}

export async function readUnityActiveScene(callTool) {
  const result = await callTool('manage_scene', { action: 'get_active' }, 5_500);
  const reply = toolPayload(result);
  if (result.isError || reply?.success !== true || !reply.data?.isLoaded) {
    return { ok: false, error: 'unity_no_scene' };
  }
  const { name, path, isDirty, rootCount } = reply.data;
  if (typeof name !== 'string' || typeof path !== 'string' || typeof isDirty !== 'boolean' ||
      !Number.isSafeInteger(rootCount) || rootCount < 0) {
    return { ok: false, error: 'unity_unavailable' };
  }
  return { ok: true, sceneName: name, scenePath: path, isDirty, rootCount };
}


export async function captureUnityGameView(callTool, readResource, signal) {
  const state = await readResource('mcpforunity://editor/state', signal);
  const play = state?.data?.editor?.play_mode;
  if (state?.success !== true || !play) {
    return toolFailure('Unity MCP konnte den Play Mode nicht prüfen.');
  }
  if (state.data.unity?.is_batch_mode === true) {
    return toolFailure('Für die Game View braucht der Unity-Editor eine grafische Sitzung.');
  }
  if (play.is_playing !== true || play.is_changing === true) {
    return toolFailure('Starte den Play Mode in Unity und rufe unity_game_view erneut auf.');
  }

  for (const resolution of [720, 448]) {
    const result = await callTool('manage_camera', {
      action: 'screenshot',
      capture_source: 'game_view',
      include_image: true,
      max_resolution: resolution,
      output_folder: 'Temp/PC-Bridge-Captures',
    }, signal).catch(error => {
      if (error instanceof UnityResponseTooLarge) return null;
      throw error;
    });
    if (!result) continue;
    if (result.isError) {
      const message = toolPayload(result)?.message ?? result.content.find(block => block.type === 'text')?.text;
      return toolFailure(typeof message === 'string' ? message.slice(0, 500) : 'Unity konnte das Spielbild nicht erfassen.');
    }
    const png = result.content.find(block => block?.type === 'image' && block.mimeType === 'image/png' &&
      typeof block.data === 'string' && block.data.startsWith('iVBORw0KGgo'));
    if (!png) return toolFailure('Unity MCP hat kein PNG der Game View geliefert.');

    // The upstream envelope is capped below the relay's result limit.
    return { content: [
      { type: 'text', text: 'Unity Game View im Play Mode.' },
      { type: 'image', mimeType: 'image/png', data: png.data },
    ] };
  }
  return toolFailure('Das PNG ist zu groß für die PC-Bridge. Verkleinere die Unity Game View und versuche es erneut.');
}
