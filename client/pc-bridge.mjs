import { captureUnityGameView, createUnityMcp, readUnityActiveScene, unityToolNames } from './unity-mcp.mjs';
import { createProjectGit, gitToolNames } from './project-git.mjs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const validToken = /^[a-f0-9]{64}$/;

function chatGptSiteOrigin(value) {
  if (typeof value !== 'string') throw new Error('Die Site-Adresse fehlt im Kopplungscode.');
  if (!URL.canParse(value)) throw new Error('Der Kopplungscode muss auf eine ChatGPT Site mit HTTPS verweisen.');
  const site = new URL(value);
  if (site.protocol !== 'https:' || !site.hostname.endsWith('.chatgpt.site') ||
      site.port || site.username || site.password || site.pathname !== '/' || site.search || site.hash) {
    throw new Error('Der Kopplungscode muss auf eine ChatGPT Site mit HTTPS verweisen.');
  }
  return site.origin;
}

export function parsePairingCode(input) {
  const code = input.trim();
  if (code.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(code)) {
    throw new Error('Ungültiger Kopplungscode. Kopiere den Code vollständig aus der privaten Site.');
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(code, 'base64').toString('utf8'));
  } catch {
    throw new Error('Der Kopplungscode konnte nicht gelesen werden.');
  }
  if (typeof data?.siteToken !== 'string' || !/^[A-Za-z0-9._~+\/=-]{20,2048}$/.test(data.siteToken) ||
      typeof data.deviceToken !== 'string' || !validToken.test(data.deviceToken)) {
    throw new Error('Der Kopplungscode enthält ungültige Zugangsdaten.');
  }
  return { ...data, siteOrigin: chatGptSiteOrigin(data.siteOrigin) };
}

export async function runJob(job, callUnity, callGit, readUnityResource) {
  if (!job || !Number.isFinite(job.expires_at)) return { ok: false, error: 'invalid_job' };
  if (Date.now() >= job.expires_at) return { ok: false, error: 'expired' };

  if (job.tool === 'pc_ping') {
    return typeof job.challenge === 'string' && /^[a-f0-9]{16}$/.test(job.challenge)
      ? { ok: true, challenge: job.challenge }
      : { ok: false, error: 'invalid_job' };
  }

  try {
    if (job.tool === 'unity_active_scene') return await readUnityActiveScene(callUnity);
    const isGit = gitToolNames.has(job.tool);
    const isGameView = job.tool === 'unity_game_view';
    if ((!isGit && !isGameView && !unityToolNames.has(job.tool)) || !job.arguments || typeof job.arguments !== 'object' ||
        Array.isArray(job.arguments)) return { ok: false, error: 'invalid_job' };
    const remaining = job.expires_at - Date.now() - 1_000;
    if (remaining <= 0) return { ok: false, error: 'expired' };
    const timeout = Math.min(29_000, remaining);
    if (isGameView) {
      if (Object.keys(job.arguments).length) return { ok: false, error: 'invalid_job' };
      const output = await captureUnityGameView(callUnity, readUnityResource, AbortSignal.timeout(timeout));
      return { ok: true, output };
    }
    const output = isGit
      ? await callGit(job.tool, job.arguments, AbortSignal.timeout(timeout))
      : await callUnity(job.tool, job.arguments, timeout);
    return { ok: true, output };
  } catch {
    return { ok: false, error: 'unity_unavailable' };
  }
}

class BridgeHttpError extends Error {
  constructor(status) {
    super(`PC-Bridge meldet HTTP ${status}.`);
    this.status = status;
  }
}

export function deviceClient(origin, credentials, fetchImpl = fetch) {
  return async (path, body) => {
    const response = await fetchImpl(new URL(path, origin), {
      method: 'POST',
      headers: {
        'OAI-Sites-Authorization': `Bearer ${credentials.siteToken}`,
        Authorization: `Bearer ${credentials.deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new BridgeHttpError(response.status);
    return response.json();
  };
}

async function readGitConfig() {
  const path = new URL('./pc-bridge.config.json', import.meta.url);
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('pc-bridge.config.json konnte nicht gelesen werden. Prüfe die JSON-Datei.');
  }
}

async function runClient(ask) {
  console.log('PC-Bridge | Client für ChatGPT Work');
  const pairingCode = await ask('Kopplungscode von der privaten Site einfügen: ', true);
  const credentials = parsePairingCode(pairingCode);
  console.log(`Private Site: ${credentials.siteOrigin}`);
  const unity = createUnityMcp();
  const git = createProjectGit(await readGitConfig(), unity);
  console.log('Unity MCP über 127.0.0.1:8080. Strg+C beendet die Verbindung.');
  await pollSite(deviceClient(credentials.siteOrigin, credentials), unity.callTool, git, unity.readResource);
}

async function pollSite(call, callUnity, callGit, readUnityResource) {
  let online = false;
  while (true) {
    try {
      const { job } = await call('/api/device/poll', {});
      if (!online) console.log('Verbunden. Rufe jetzt @PC-Bridge in ChatGPT Work auf.');
      online = true;
      if (job) {
        const result = await runJob(job, callUnity, callGit, readUnityResource);
        try {
          await call('/api/device/result', { id: job.id, result });
          console.log(result.ok && !result.output?.isError
            ? `Auftrag erledigt: ${job.tool}`
            : `Auftrag mit Fehler: ${job.tool}`);
        } catch (error) {
          if (error.status !== 409) throw error;
          console.log('Der Auftrag ist auf der Site bereits geschlossen.');
        }
      }
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        throw new Error('Kopplung ungültig. Öffne die private Site und erstelle einen neuen Code.');
      }
      if (online) console.log('Verbindung unterbrochen. Der Client versucht es erneut.');
      online = false;
      await delay(3_500);
    }
    await delay(2_000);
  }
}

async function ask(prompt, hidden) {
  const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const input = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  try {
    if (hidden) process.stdout.write(prompt);
    return await input.question(hidden ? '' : prompt);
  } finally {
    input.close();
    if (hidden) process.stdout.write('\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClient(ask).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
