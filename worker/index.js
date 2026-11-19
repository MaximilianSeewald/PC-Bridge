import catalog from '../client/unity-tools.json' with { type: 'json' };
import gitTools from '../client/git-tools.json' with { type: 'json' };

const bridgeTools = [
  {
    name: 'pc_ping',
    title: 'Verbindung zum PC testen',
    description: 'Prüft mit einem frischen zufälligen Prüfwert, ob der gekoppelte Windows-PC gerade tatsächlich antwortet.',
  },
  {
    name: 'unity_active_scene',
    title: 'Aktive Unity-Szene lesen',
    description: 'Liest Szenenname, projektbezogenen Pfad, Zahl der Objekte auf oberster Ebene und den Speicherstatus aus dem laufenden lokalen Unity-Editor.',
  },
].map((tool) => ({
  ...tool,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));
const externalTools = new Set([
  'batch_execute', 'execute_code', 'execute_custom_tool', 'execute_menu_item',
  'generate_image', 'generate_model', 'import_model', 'manage_packages', 'unity_docs',
]);
const unityTools = catalog.tools.map(tool => {
  const readOnlyHint = tool.annotations?.readOnlyHint === true;
  return {
    ...tool,
    annotations: {
      ...tool.annotations,
      readOnlyHint,
      destructiveHint: tool.annotations?.destructiveHint ?? !readOnlyHint,
      openWorldHint: tool.annotations?.openWorldHint ?? externalTools.has(tool.name),
    },
  };
});
const forwardedToolNames = new Set([...unityTools, ...gitTools].map(tool => tool.name));
const tools = [...bridgeTools, ...unityTools, ...gitTools];

const protocolVersion = '2026-07-28';
const release = '0.5.0';
const onlineWindow = 40_000;
const argumentLimit = 96_000;
const resultLimit = 1_600_000;
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const encoder = new TextEncoder();
const allowedErrors = new Set([
  'invalid_job', 'expired', 'unity_unavailable', 'unity_no_scene',
]);
const deviceTokenPattern = /^[a-f0-9]{64}$/;
const mcpContentTypes = new Set(['text', 'image', 'audio', 'resource', 'resource_link']);

function json(value, status = 200) {
  return Response.json(value, { status, headers: responseHeaders });
}

function owner(request, env) {
  const email = request.headers.get('oai-authenticated-user-email');
  return Boolean(email && env.BRIDGE_OWNER_EMAIL &&
    email.toLowerCase() === env.BRIDGE_OWNER_EMAIL.toLowerCase());
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hash(token) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

function page(content) {
  return new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PC-Bridge</title>
<style>
  body{margin:0;background:#111822;color:#f3f5f7;font:18px/1.55 system-ui,sans-serif}
  main{max-width:38rem;margin:10vh auto;padding:1.75rem}
  h1{font-size:2.4rem;line-height:1.1;letter-spacing:-.04em}
  p,li{color:#c5d0df} a{color:#96e8c3} form{display:inline-block;margin:0 .8rem .8rem 0}
  button{font:600 1rem system-ui;padding:.65rem .95rem;border:1px solid #54677d;border-radius:7px;background:#222f40;color:#f3f5f7;cursor:pointer}
  form:first-of-type button{background:#96e8c3;color:#12251d;border-color:#96e8c3}
  textarea{box-sizing:border-box;width:100%;padding:.8rem;background:#182434;color:#f3f5f7;border:1px solid #54677d;border-radius:7px;font:1rem monospace}
  :focus-visible{outline:3px solid #f3c866;outline-offset:3px}
</style></head><body><main><h1>PC-Bridge</h1>${content}</main></body></html>`, {
    headers: {
      ...responseHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function dashboard(request, env, path) {
  if (!owner(request, env)) return json({ error: 'forbidden' }, 403);
  if (path === '/' && request.method === 'GET') {
    const device = await env.DB.prepare('SELECT last_seen FROM bridge_device WHERE id = 1').first();
    let status = 'Kein PC gekoppelt.';
    if (device) {
      status = 'PC gekoppelt. Der Windows-Client ist offline.';
      if (device.last_seen && Date.now() - device.last_seen < onlineWindow) {
        status = 'Der Windows-Client ist online.';
      }
    }
    const pluginLink = env.BRIDGE_PLUGIN_ARCHIVE
      ? '<p><a href="/plugin.zip">PC-Bridge Plugin-ZIP herunterladen</a></p>'
      : '';
    return page(`<p>${status}</p><p>Starte <strong>PC-Bridge.cmd</strong> aus dem entpackten Ordner.
Kopple den Client und rufe danach PC-Bridge in ChatGPT Work auf.</p>${pluginLink}
<form method="post" action="/pair"><button>Kopplungscode anzeigen</button></form>
<form method="post" action="/revoke"><button>Kopplung aufheben</button></form>
<p>Ein neuer Code ersetzt die bisherige Kopplung.</p>`);
  }
  if (path === '/plugin.zip' && request.method === 'GET') {
    if (!env.BRIDGE_PLUGIN_ARCHIVE) return json({ error: 'not_found' }, 404);
    const archive = Uint8Array.from(atob(env.BRIDGE_PLUGIN_ARCHIVE), (byte) => byte.charCodeAt(0));
    return new Response(archive, {
      headers: { ...responseHeaders, 'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="PC-Bridge-Plugin.zip"' },
    });
  }
  if (request.method !== 'POST' || path === '/plugin.zip') return json({ error: 'method_not_allowed' }, 405);
  const origin = request.headers.get('Origin');
  // Referrer-Policy: no-referrer can give an HTML form submission an opaque Origin.
  // Browsers still set Sec-Fetch-Site and do not let web pages forge it.
  const sameOriginForm = (origin === 'null' || origin === null) &&
    request.headers.get('Sec-Fetch-Site') === 'same-origin';
  if (origin !== env.BRIDGE_ORIGIN && !sameOriginForm) {
    return json({ error: 'forbidden' }, 403);
  }

  const deleteJobs = env.DB.prepare('DELETE FROM bridge_job');
  if (path === '/revoke') {
    await env.DB.batch([deleteJobs, env.DB.prepare('DELETE FROM bridge_device')]);
    return page('<p>Die Kopplung wurde aufgehoben.</p><a href="/">Zurück zum Status</a>');
  }
  if (!env.BRIDGE_SITES_TOKEN || !env.BRIDGE_ORIGIN) {
    return json({ error: 'pairing_unavailable' }, 503);
  }
  const deviceToken = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    deleteJobs,
    env.DB.prepare('INSERT OR REPLACE INTO bridge_device (id, token_hash) VALUES (1, ?)')
      .bind(await hash(deviceToken)),
  ]);
  const encoded = btoa(JSON.stringify({
    siteOrigin: env.BRIDGE_ORIGIN,
    siteToken: env.BRIDGE_SITES_TOKEN,
    deviceToken,
  }));
  return page(`<p><label for="code">Kopplungscode für den Windows-Client</label></p>
<textarea id="code" rows="5" readonly spellcheck="false">${encoded}</textarea>
<p>Kopiere den Code in die Eingabeaufforderung der PC-Bridge.</p><a href="/">Zum Status</a>`);
}

function cleanResult(result, job) {
  if (result?.ok === false && allowedErrors.has(result.error)) {
    return { ok: false, error: result.error };
  }
  if (result?.ok !== true) return null;
  if (job.tool === 'pc_ping') {
    return result.challenge === job.challenge ? { ok: true, challenge: job.challenge } : null;
  }
  if (job.tool === 'unity_active_scene') {
    const { sceneName, scenePath, isDirty, rootCount } = result;
    if (typeof sceneName !== 'string' || sceneName.length > 250 ||
        typeof scenePath !== 'string' || scenePath.length > 500 ||
        /[\x00-\x1f\x7f]/.test(sceneName + scenePath) ||
        (scenePath && (!/^(Assets|Packages)\/.+\.unity$/i.test(scenePath) ||
          scenePath.includes('\\') || scenePath.split('/').some(part => !part || part === '.' || part === '..'))) ||
        typeof isDirty !== 'boolean' || !Number.isSafeInteger(rootCount) || rootCount < 0) return null;
    return { ok: true, sceneName, scenePath, isDirty, rootCount };
  }
  if (!forwardedToolNames.has(job.tool)) return null;
  const { content, structuredContent, isError } = result.output ?? {};
  if (!Array.isArray(content) || !content.every(block => mcpContentTypes.has(block?.type)) ||
      (structuredContent !== undefined && !record(structuredContent)) ||
      (isError !== undefined && typeof isError !== 'boolean')) return null;
  return { ok: true, output: { content, structuredContent, isError } };
}

async function deviceRequest(request, env, path) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token || !deviceTokenPattern.test(token)) return json({ error: 'unauthorized' }, 401);
  const tokenHash = await hash(token);
  const now = Date.now();
  const device = await env.DB.prepare('SELECT 1 FROM bridge_device WHERE id = 1 AND token_hash = ?')
    .bind(tokenHash).first();
  if (!device) return json({ error: 'unauthorized' }, 401);

  if (path === '/api/device/poll') {
    await env.DB.prepare('UPDATE bridge_device SET last_seen = ? WHERE id = 1 AND token_hash = ?')
      .bind(now, tokenHash).run();
    const job = await env.DB.prepare(
      `UPDATE bridge_job SET state = 'claimed' WHERE id = (
        SELECT id FROM bridge_job WHERE device_hash = ? AND state = 'queued' AND expires_at > ?
        ORDER BY created_at LIMIT 1
      ) RETURNING id, tool, challenge, expires_at, arguments_json`,
    ).bind(tokenHash, now).first();
    if (!job) return json({ job: null });
    const { arguments_json, ...claimed } = job;
    return json({ job: { ...claimed, arguments: JSON.parse(arguments_json) } });
  }

  const body = await boundedJson(request, resultLimit);
  if (!body || typeof body.id !== 'string' || body.id.length !== 36) {
    return json({ error: 'invalid_payload' }, 400);
  }
  const job = await env.DB.prepare(
    'SELECT tool, challenge FROM bridge_job WHERE id = ? AND device_hash = ? AND expires_at > ?',
  ).bind(body.id, tokenHash, now).first();
  if (!job) return json({ error: 'job_expired_or_missing' }, 409);
  const result = cleanResult(body.result, job);
  if (!result) return json({ error: 'invalid_result' }, 400);

  const updated = await env.DB.prepare(
    `UPDATE bridge_job SET state = 'done', result = ?
    WHERE id = ? AND device_hash = ? AND expires_at > ? AND state = 'claimed'
    RETURNING id`,
  ).bind(JSON.stringify(result), body.id, tokenHash, Date.now()).first();
  return updated ? json({ accepted: true }) : json({ error: 'job_closed' }, 409);
}

async function boundedJson(request, limit) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    return null;
  }
}

function mcpError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function runJob(env, tool, args) {
  const now = Date.now();
  const device = await env.DB.prepare('SELECT token_hash, last_seen FROM bridge_device WHERE id = 1').first();
  if (!device) return mcpError('Es ist noch kein PC gekoppelt.');
  if (!device.last_seen || now - device.last_seen >= onlineWindow) {
    return mcpError('Der Windows-Client ist offline. Starte PC-Bridge.cmd und versuche es erneut.');
  }
  await env.DB.prepare('DELETE FROM bridge_job WHERE expires_at <= ?').bind(now).run();

  const id = crypto.randomUUID();
  const challenge = tool === 'pc_ping' ? hex(crypto.getRandomValues(new Uint8Array(8))) : null;
  const waitTime = forwardedToolNames.has(tool) ? 36_000 : 9_000;
  const pollInterval = waitTime === 36_000 ? 950 : 350;
  const expiresAt = now + waitTime;
  const queued = await env.DB.prepare(
    `INSERT INTO bridge_job (id, device_hash, tool, challenge, created_at, expires_at, state, arguments_json)
     SELECT ?, token_hash, ?, ?, ?, ?, 'queued', ? FROM bridge_device
     WHERE id = 1 AND token_hash = ? AND
       (SELECT COUNT(*) FROM bridge_job WHERE device_hash = ?) < 8
     RETURNING id`,
  ).bind(id, tool, challenge, now, expiresAt, JSON.stringify(args), device.token_hash, device.token_hash).first();
  if (!queued) return mcpError('Die Kopplung hat sich geändert oder die Auftragswarteschlange ist voll.');
  try {
    while (Date.now() < expiresAt) {
      const job = await env.DB.prepare('SELECT state, result FROM bridge_job WHERE id = ?').bind(id).first();
      if (!job) return mcpError('Die Kopplung wurde während der Anfrage aufgehoben.');
      if (job.state === 'done') return mcpResult(tool, JSON.parse(job.result));
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    return mcpError('Der PC hat nicht rechtzeitig geantwortet. Prüfe den Client und versuche es erneut.');
  } finally {
    await env.DB.prepare('DELETE FROM bridge_job WHERE id = ?').bind(id).run();
  }
}

function mcpResult(tool, result) {
  if (!result.ok) {
    const errors = {
      invalid_job: 'Der Client hat den Auftrag abgelehnt.',
      expired: 'Der Auftrag ist abgelaufen.',
      unity_unavailable: 'Unity MCP hat keine verwertbare Antwort geliefert. Prüfe den lokalen HTTP-Server auf 127.0.0.1:8080 und seine Verbindung zum Unity-Editor.',
      unity_no_scene: 'Unity MCP meldet keine aktive Szene. Prüfe, ob dein Editor mit dem MCP-Server verbunden ist.',
    };
    return mcpError(errors[result.error] ?? 'Der Windows-Client meldet einen Fehler.');
  }
  if (tool === 'pc_ping') {
    return { content: [{ type: 'text', text: `PC verbunden. Prüfwert vom Client: ${result.challenge}` }] };
  }
  if (tool === 'unity_active_scene') {
    const { sceneName, scenePath, isDirty, rootCount } = result;
    const text = `Unity-Szene: ${sceneName || 'Ohne Namen'}\nPfad: ${scenePath || 'Noch ohne Datei'}\nObjekte auf oberster Ebene: ${rootCount}\nUngespeicherte Änderungen: ${isDirty ? 'Ja' : 'Nein'}`;
    return { content: [{ type: 'text', text }] };
  }
  return result.output;
}

async function mcp(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const message = await boundedJson(request, argumentLimit);
  const error = (code, text) => json({
    jsonrpc: '2.0', id: message?.id ?? null, error: { code, message: text },
  });
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return error(-32600, 'Invalid Request');
  }
  if (message.id === undefined) return new Response(null, { status: 202 });
  const reply = (result) => json({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'server/discover':
      return reply({ supportedVersions: [protocolVersion], capabilities: { tools: {} } });
    case 'initialize':
      return reply({
        protocolVersion: message.params?.protocolVersion === '2025-11-25' ? '2025-11-25' : protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'pc-bridge', version: release },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      if (!owner(request, env)) return reply(mcpError('Dieses Werkzeug ist nur für den Site-Eigentümer verfügbar.'));
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (!tools.some((tool) => tool.name === name)) return error(-32602, 'Unbekanntes Werkzeug');
      if (!record(args) || (!forwardedToolNames.has(name) && Object.keys(args).length)) {
        return error(-32602, 'Ungültige Parameter für dieses Werkzeug.');
      }
      return reply(await runJob(env, name, args));
    }
    default:
      return error(-32601, 'Method not found');
  }
}

export default {
  async fetch(request, env) {
    try {
      const { pathname } = new URL(request.url);
      switch (pathname) {
        case '/mcp':
          return await mcp(request, env);
        case '/api/device/poll':
        case '/api/device/result':
          return await deviceRequest(request, env, pathname);
        case '/':
        case '/pair':
        case '/revoke':
        case '/plugin.zip':
          return await dashboard(request, env, pathname);
        default:
          return json({ error: 'not_found' }, 404);
      }
    } catch (error) {
      console.error('PC-Bridge request failed', error?.name, error?.message);
      return json({ error: 'internal_error' }, 500);
    }
  },
};
