import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import gitTools from './git-tools.json' with { type: 'json' };
import { toolPayload } from './unity-mcp.mjs';

const exec = promisify(execFile);
const hashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const branchPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,179}$/;
const repositoryPattern = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;
const diffLimit = 20_000;
export const gitToolNames = new Set(gitTools.map(tool => tool.name));

async function executeGit(path, args, signal) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const variable of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']) {
    delete env[variable];
  }
  const { stdout } = await exec('git', ['-C', path, ...args], {
    env, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal,
  });
  return stdout;
}

function samePath(left, right) {
  const paths = [left, right].map(path => normalize(path));
  return process.platform === 'win32'
    ? paths[0].toLowerCase() === paths[1].toLowerCase()
    : paths[0] === paths[1];
}

function githubRepository(url) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/i
    .exec(url)?.[1].toLowerCase();
}

function filesArgument(files, minimum) {
  if (!Array.isArray(files) || files.length < minimum || files.length > 100 ||
      files.some(path => typeof path !== 'string' || path.length > 512 ||
        /[\u0000-\u001f\u007f\\:]/u.test(path) ||
        path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase())))) {
    throw new Error('Gib bis zu 100 einzelne projekt-relative Dateipfade mit Schrägstrichen an.');
  }
  return [...new Set(files)];
}

function output(data, error = false) {
  return { isError: error, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function failureMessage(error, signal) {
  if (signal.aborted) return 'Zeitlimit erreicht. Prüfe vor einem erneuten Schreibvorgang zuerst project_git_status.';
  if (error.code === 'ENOENT' && error.path === 'git') return 'Git für Windows fehlt oder ist nicht im PATH.';
  if (typeof error.stderr !== 'string') return error.message;
  if (/Authentication failed|Permission denied|terminal prompts disabled|could not read Username/i.test(error.stderr)) {
    return 'GitHub-Zugriff fehlgeschlagen. Prüfe die lokale Anmeldung für origin.';
  }
  if (/author identity unknown|unable to auto-detect email address/i.test(error.stderr)) {
    return 'Richte Git user.name und user.email für Commits ein.';
  }
  if (/non-fast-forward|fetch first/i.test(error.stderr + error.stdout)) {
    return 'GitHub hat neuere Commits auf dem Feature-Branch. Prüfe die Historie vor einem erneuten Push.';
  }
  return 'Der lokale Git-Befehl ist fehlgeschlagen. Prüfe project_git_status und den zuletzt ausgeführten Schritt.';
}

export function createProjectGit(config, unity, runGit = executeGit) {
  return async (name, args, signal) => {
    try {
      if (!config) throw new Error('Kopiere pc-bridge.config.example.json als pc-bridge.config.json und trage dein Unity-Projekt ein.');
      const { projectPath, repository, baseBranch = 'main' } = config;
      if (typeof projectPath !== 'string' || !isAbsolute(projectPath) ||
          typeof repository !== 'string' || !repositoryPattern.test(repository) ||
          typeof baseBranch !== 'string' || !branchPattern.test(baseBranch)) {
        throw new Error('Prüfe projectPath, repository und baseBranch in pc-bridge.config.json.');
      }

      const path = await realpath(projectPath).catch(() => null);
      if (!path || !(await stat(join(path, 'Assets')).catch(() => null))?.isDirectory() ||
          !(await stat(join(path, 'Packages', 'manifest.json')).catch(() => null))?.isFile() ||
          !(await stat(join(path, 'ProjectSettings', 'ProjectVersion.txt')).catch(() => null))?.isFile()) {
        throw new Error('Der konfigurierte Pfad muss auf den Stammordner eines Unity-Projekts zeigen.');
      }
      const git = (...argv) => runGit(path, argv, signal);
      const gitLine = async (...argv) => (await git(...argv)).replace(/\r?\n$/, '');
      if (!samePath(path, await realpath(await gitLine('rev-parse', '--show-toplevel')))) {
        throw new Error('Der Unity-Projektordner muss zugleich die Wurzel des Git-Checkouts sein.');
      }
      for (const flags of [[], ['--push']]) {
        const url = await gitLine('remote', 'get-url', ...flags, '--all', 'origin');
        if (githubRepository(url) !== repository.toLowerCase()) {
          throw new Error('Die Fetch- und Push-URL von origin müssen auf das konfigurierte GitHub-Repository zeigen.');
        }
      }
      const branch = async () => (await gitLine('rev-parse', '--abbrev-ref', 'HEAD'));
      const head = async () => gitLine('rev-parse', '--verify', 'HEAD');
      const changes = async () => (await git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'))
        .split('\0').filter(Boolean).map(entry => ({ status: entry.slice(0, 2), path: entry.slice(3) }));
      const status = async () => {
        const entries = await changes();
        return {
          repository, baseBranch, branch: await branch(), head: await head(),
          clean: entries.length === 0, changes: entries.slice(0, 100), totalChanges: entries.length,
        };
      };

      if (name === 'project_git_status') return output(await status());
      if (name === 'project_git_diff') {
        const files = filesArgument(args.files ?? [], 0);
        const diff = await git('--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...files);
        return output({ repository, head: await head(), diff: diff.slice(0, diffLimit), truncated: diff.length > diffLimit });
      }

      const target = args.branch;
      if (typeof target !== 'string' || !branchPattern.test(target)) throw new Error('Ungültiger Feature-Branch.');
      await git('check-ref-format', '--branch', target);
      const defaultBranch = await gitLine('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
        .catch(error => { if (error.code === 1) return ''; throw error; });
      if ([baseBranch, 'main', 'master', defaultBranch.replace(/^origin\//, '')]
        .some(protectedBranch => protectedBranch.toLowerCase() === target.toLowerCase())) {
        throw new Error('Wähle einen Feature-Branch. Der Basisbranch ist geschützt.');
      }

      const project = await unity.readResource('mcpforunity://project/info', signal);
      const activePath = project?.success === true && project.data?.projectRoot;
      if (!activePath || !samePath(path, (await realpath(activePath).catch(() => null)) ?? '')) {
        throw new Error('Das in Unity MCP aktive Projekt muss dem konfigurierten Checkout entsprechen.');
      }
      const state = await unity.readResource('mcpforunity://editor/state', signal);
      const play = state?.data?.editor?.play_mode;
      if (state?.success !== true || play?.is_playing !== false || play.is_changing === true ||
          state.data.compilation?.is_compiling || state.data.tests?.is_running) {
        throw new Error('Unity muss im Edit Mode sein. Warte, bis Kompilierung und Tests abgeschlossen sind.');
      }
      const prefab = await unity.readResource('mcpforunity://editor/prefab-stage', signal);
      const scenes = toolPayload(await unity.callTool('manage_scene', { action: 'get_loaded_scenes' }, signal));
      if (prefab?.success !== true || scenes?.success !== true || !Array.isArray(scenes.data?.scenes)) {
        throw new Error('Der Speicherzustand von Unity konnte nicht geprüft werden.');
      }
      if (prefab.data?.isDirty || scenes.data.scenes.some(scene => scene.isDirty)) {
        throw new Error('Speichere zuerst die geänderten Szenen oder Prefabs in Unity.');
      }

      const requireClean = async () => {
        if ((await changes()).length) throw new Error('Der Git-Checkout enthält lokale Änderungen. Prüfe project_git_status.');
      };
      const checkPosition = async () => {
        if (!hashPattern.test(args.expectedHead) || await branch() !== target || await head() !== args.expectedHead) {
          throw new Error('Branch oder HEAD haben sich geändert. Prüfe project_git_status.');
        }
      };

      if (name === 'project_git_prepare') {
        await git('check-ref-format', '--branch', baseBranch);
        await requireClean();
        await git('fetch', '--no-tags', '--no-recurse-submodules', 'origin');
        const localRef = `refs/heads/${target}`;
        const remoteRef = `refs/remotes/origin/${target}`;
        const refExists = async ref => git('show-ref', '--verify', '--quiet', ref)
          .then(() => true, error => { if (error.code === 1) return false; throw error; });
        const isAncestor = async (ancestor, descendant) => git('merge-base', '--is-ancestor', ancestor, descendant)
          .then(() => true, error => { if (error.code === 1) return false; throw error; });
        const hasLocal = await refExists(localRef);
        const hasRemote = await refExists(remoteRef);
        const remoteAhead = hasLocal && hasRemote && await isAncestor(localRef, remoteRef);
        if (hasLocal && hasRemote && !remoteAhead && !await isAncestor(remoteRef, localRef)) {
          throw new Error('Lokaler und veröffentlichter Feature-Branch sind auseinander gelaufen. Kläre die Historie vor dem Wechsel.');
        }
        await requireClean();
        if (hasLocal) {
          await git('switch', '--no-guess', target);
          if (remoteAhead && await head() !== await gitLine('rev-parse', remoteRef)) {
            await git('merge', '--ff-only', remoteRef);
          }
        } else {
          await git('switch', '--no-track', '-c', target, hasRemote ? remoteRef : `refs/remotes/origin/${baseBranch}`);
        }
        return output(await status());
      }

      await checkPosition();
      if (name === 'project_git_commit') {
        const files = filesArgument(args.files, 1);
        const message = typeof args.message === 'string' ? args.message.trim() : '';
        if (!message || message.length > 300 || /[\u0000-\u001f\u007f]/u.test(message)) {
          throw new Error('Gib eine einzeilige Commit-Nachricht mit bis zu 300 Zeichen an.');
        }
        const dirty = new Set((await changes()).map(entry => entry.path));
        if (files.some(file => !dirty.has(file))) throw new Error('Wähle nur exakt benannte geänderte Dateien aus project_git_status.');
        const selected = new Set(files);
        const checkStaged = async () => {
          const staged = (await git('diff', '--cached', '--name-only', '--no-renames', '-z')).split('\0').filter(Boolean);
          if (staged.some(file => !selected.has(file))) {
            throw new Error('Im Index liegen weitere Dateien. Prüfe die bereits vorgemerkten Änderungen.');
          }
        };
        await checkStaged();
        await git('--literal-pathspecs', 'add', '-A', '--', ...files);
        await checkStaged();
        await checkPosition();
        await git('--literal-pathspecs', 'commit', '--only', '-m', message, '--', ...files);
        return output(await status());
      }
      if (name === 'project_git_push') {
        await requireClean();
        await git('push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', 'origin', `${args.expectedHead}:refs/heads/${target}`);
        return output({ repository, branch: target, head: args.expectedHead, pushed: true });
      }
      throw new Error('Unbekannte Git-Aktion.');
    } catch (error) {
      return output({ error: failureMessage(error, signal) }, true);
    }
  };
}
