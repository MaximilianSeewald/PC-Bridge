import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
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

export function parseGitStatus(output) {
  const records = output.split('\0');
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  let branch;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.head ')) {
      branch = record.slice('# branch.head '.length);
      continue;
    }
    switch (record[0]) {
      case '?':
        counts.untracked += 1;
        break;
      case 'u':
        counts.conflicts += 1;
        break;
      case '1':
      case '2': {
        const [staged, unstaged] = record.slice(2, 4);
        if (staged !== '.') counts.staged += 1;
        if (unstaged !== '.') counts.unstaged += 1;
        if (record[0] === '2') index += 1; // Rename records include the old path after a NUL.
        break;
      }
      default:
        break;
    }
  }
  if (!branch) throw new Error('Git returned no branch status');
  return { branch, ...counts };
}

async function gitStatus(repo) {
  if (!repo || !isAbsolute(repo)) return { ok: false, error: 'repo_invalid' };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  const options = { env, timeout: 3_500, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
  const git = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo];

  let prefix;
  try {
    prefix = (await executeFile('git', [...git, 'rev-parse', '--show-prefix'], options)).stdout;
  } catch (error) {
    return { ok: false, error: error.code === 128 ? 'repo_invalid' : 'git_failed' };
  }
  if (prefix.trim()) return { ok: false, error: 'repo_invalid' };

  try {
    const { stdout } = await executeFile(
      'git', [...git, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], options,
    );
    return { ok: true, ...parseGitStatus(stdout) };
  } catch {
    return { ok: false, error: 'git_failed' };
  }
}

export async function runJob(job, repo) {
  if (!job || !Number.isFinite(job.expires_at)) return { ok: false, error: 'invalid_job' };
  if (Date.now() >= job.expires_at) return { ok: false, error: 'expired' };
  switch (job.tool) {
    case 'pc_ping':
      if (typeof job.challenge !== 'string' || !/^[a-f0-9]{16}$/.test(job.challenge)) {
        return { ok: false, error: 'invalid_job' };
      }
      return { ok: true, challenge: job.challenge };
    case 'epoch_git_status':
      return gitStatus(repo);
    default:
      return { ok: false, error: 'invalid_job' };
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
    const status = await gitStatus(repo);
    if (!status.ok) throw new Error('Git oder der Hauptordner der EPOCH-Kopie wurde nicht erkannt.');
  }

  const call = deviceClient(credentials.siteOrigin, credentials);
  console.log('Client läuft. Strg+C beendet die Verbindung.');
  let online = false;
  while (true) {
    try {
      const { job } = await call('/api/device/poll', {});
      if (!online) console.log('Verbunden. Rufe jetzt @PC-Bridge in ChatGPT Work auf.');
      online = true;
      if (job) {
        const result = await runJob(job, repo);
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
