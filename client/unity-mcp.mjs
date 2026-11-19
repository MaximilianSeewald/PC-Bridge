const endpoint = 'http://127.0.0.1:8080/mcp';
const protocolVersion = '2025-11-25';
const supportedVersions = new Set(['2025-03-26', '2025-06-18', protocolVersion]);
const responseLimit = 64 * 1024;

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
      if (size > responseLimit) throw new Error('Unity MCP meldet eine zu große Antwort.');
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

export async function readUnityActiveScene(fetchImpl = fetch) {
  const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  const signal = AbortSignal.timeout(5_500);

  async function send(method, params, id) {
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
    if (message.jsonrpc !== '2.0' || message.id !== id || !message.result || message.error) {
      throw new Error('Unity MCP meldet einen Aufruffehler.');
    }
    return message.result;
  }

  try {
    const init = await send('initialize', {
      protocolVersion, capabilities: {}, clientInfo: { name: 'pc-bridge', version: '0.3.0' },
    }, 1);
    if (!supportedVersions.has(init.protocolVersion) || !init.capabilities?.tools) {
      throw new Error('Dieser Unity-MCP-Server unterstützt die erwarteten Tools nicht.');
    }
    headers['MCP-Protocol-Version'] = init.protocolVersion;
    await send('notifications/initialized');
    const result = await send('tools/call', { name: 'manage_scene', arguments: { action: 'get_active' } }, 2);
    if (result.isError) return { ok: false, error: 'unity_no_scene' };
    const payload = result.structuredContent ??
      JSON.parse(result.content?.find(item => item.type === 'text')?.text ?? '{}');
    const reply = payload.result ?? payload;
    if (reply.success !== true || !reply.data?.isLoaded) {
      return { ok: false, error: 'unity_no_scene' };
    }
    const { name, path, isDirty, rootCount } = reply.data;
    if (typeof name !== 'string' || typeof path !== 'string' || typeof isDirty !== 'boolean' ||
        !Number.isSafeInteger(rootCount) || rootCount < 0) {
      return { ok: false, error: 'unity_unavailable' };
    }
    return { ok: true, sceneName: name, scenePath: path, isDirty, rootCount };
  } catch {
    return { ok: false, error: 'unity_unavailable' };
  } finally {
    if (headers['MCP-Session-Id']) {
      await fetchImpl(endpoint, {
        method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(500),
      }).then(response => response.body?.cancel()).catch(() => {});
    }
  }
}
