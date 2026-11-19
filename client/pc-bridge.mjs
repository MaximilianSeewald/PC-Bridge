import { startLocalMcp } from './mcp-client.mjs';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
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

export async function runJob(job, callTool) {
  if (!job || !Number.isFinite(job.expires_at)) return { ok: false, error: 'invalid_job' };
  if (Date.now() >= job.expires_at) return { ok: false, error: 'expired' };

  const args = { pc_ping: { challenge: job.challenge }, epoch_git_status: {} };
  if (!Object.hasOwn(args, job.tool)) return { ok: false, error: 'invalid_job' };
  try {
    return await callTool(job.tool, args[job.tool]);
  } catch {
    return { ok: false, error: 'mcp_unavailable' };
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

async function runClient(ask) {
  console.log('PC-Bridge | Windows-Client für ChatGPT Work');
  const pairingCode = await ask('Kopplungscode von der privaten Site einfügen: ', true);
  const credentials = parsePairingCode(pairingCode);
  console.log(`Private Site: ${credentials.siteOrigin}`);
  let repo;
  const input = await ask('Pfad zur lokalen EPOCH-Kopie (leer für reinen Verbindungstest): ', false);
  if (input.trim()) {
    const path = input.trim().replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(path)) throw new Error('Bitte gib den vollständigen Pfad zum EPOCH-Ordner an.');
    repo = await realpath(path).catch(() => { throw new Error('Der EPOCH-Ordner wurde nicht gefunden.'); });
  }

  const mcp = await startLocalMcp(repo);
  try {
    if (repo && !(await mcp.callTool('epoch_git_status', {})).ok) {
      throw new Error('Git oder der Hauptordner der EPOCH-Kopie wurde nicht erkannt.');
    }
    console.log('Lokaler MCP-Server gestartet. Strg+C beendet die Verbindung.');
    await pollSite(deviceClient(credentials.siteOrigin, credentials), mcp);
  } finally {
    mcp.close();
  }
}

async function pollSite(call, mcp) {
  let online = false;
  while (true) {
    try {
      const { job } = await call('/api/device/poll', {});
      if (!online) console.log('Verbunden. Rufe jetzt @PC-Bridge in ChatGPT Work auf.');
      online = true;
      if (job) {
        const result = await runJob(job, mcp.callTool);
        try {
          await call('/api/device/result', { id: job.id, result });
          console.log(result.ok ? `Auftrag erledigt: ${job.tool}` : `Auftrag abgewiesen: ${job.tool}`);
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
    if (!mcp.isRunning()) throw new Error('Der lokale MCP-Server wurde beendet. Starte PC-Bridge.cmd erneut.');
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
