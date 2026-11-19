import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const version = '2025-11-25';
const tools = [
  {
    name: 'pc_ping',
    description: 'Bestätigt den Prüfwert aus dem Aufruf.',
    inputSchema: {
      type: 'object', properties: { challenge: { type: 'string', pattern: '^[a-f0-9]{16}$' } },
      required: ['challenge'], additionalProperties: false,
    },
  },
  {
    name: 'epoch_git_status',
    description: 'Liest Branch und Änderungszahlen aus dem lokal eingestellten Git-Checkout.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
].map((tool) => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));

function parseGitStatus(output) {
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

async function callTool({ name, arguments: args = {} } = {}, repo) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'invalid_job' };
  switch (name) {
    case 'pc_ping':
      if (Object.keys(args).length !== 1 || typeof args.challenge !== 'string' ||
          !/^[a-f0-9]{16}$/.test(args.challenge)) return { ok: false, error: 'invalid_job' };
      return { ok: true, challenge: args.challenge };
    case 'epoch_git_status':
      return Object.keys(args).length ? { ok: false, error: 'invalid_job' } : gitStatus(repo);
    default:
      return { ok: false, error: 'invalid_job' };
  }
}

let state = 'new';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (response) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n');

for await (const line of input) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ id: null, error: { code: -32700, message: 'Parse error' } });
    continue;
  }
  const { id, method, params } = message ?? {};
  if (message?.jsonrpc !== '2.0' || typeof method !== 'string') {
    write({ id: id ?? null, error: { code: -32600, message: 'Invalid request' } });
    continue;
  }
  if (id === undefined) {
    if (state === 'negotiated' && method === 'notifications/initialized') state = 'ready';
    continue;
  }

  if (method === 'initialize') {
    state = 'negotiated';
    write({ id, result: {
      protocolVersion: version, capabilities: { tools: {} },
      serverInfo: { name: 'pc-bridge-local', version: '0.2.0' },
    } });
  } else if (method === 'ping') {
    write({ id, result: {} });
  } else if (state !== 'ready') {
    write({ id, error: { code: -32000, message: 'Initialize the MCP server first' } });
  } else if (method === 'tools/list') {
    write({ id, result: { tools } });
  } else if (method === 'tools/call') {
    const result = await callTool(params && typeof params === 'object' ? params : {}, process.argv[2]);
    write({ id, result: {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      ...(result.ok ? {} : { isError: true }),
    } });
  } else {
    write({ id, error: { code: -32601, message: 'Method not found' } });
  }
}
