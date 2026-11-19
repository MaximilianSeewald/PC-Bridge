import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectGit } from '../client/project-git.mjs';

const exec = promisify(execFile);
const git = (path, ...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function setup(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'pc-bridge-git-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const remote = join(scratch, 'remote.git');
  const project = join(scratch, 'project');
  git(scratch, 'init', '--bare', '--initial-branch=main', remote);
  git(scratch, 'clone', remote, project);
  git(project, 'config', 'user.name', 'PC-Bridge Test');
  git(project, 'config', 'user.email', 'bridge@example.com');
  for (const dir of ['Assets', 'Packages', 'ProjectSettings']) await mkdir(join(project, dir));
  const write = (path, content) => writeFile(join(project, path), content);
  const script = 'Assets/Player Input.cs';
  await write('Packages/manifest.json', '{}\n');
  await write('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0.1f1\n');
  await write(script, 'class PlayerInput {}\n');
  git(project, 'add', '.');
  git(project, 'commit', '-m', 'Initial Unity project');
  git(project, 'push', '-u', 'origin', 'main');
  const base = git(project, 'rev-parse', 'HEAD').trim();
  const context = { projectRoot: project, isPlaying: false, sceneDirty: false, remote: 'https://github.com/example/game.git' };
  const unity = {
    async readResource(uri) {
      const data = {
        'mcpforunity://project/info': { projectRoot: context.projectRoot },
        'mcpforunity://editor/state': { editor: { play_mode: { is_playing: context.isPlaying } } },
        'mcpforunity://editor/prefab-stage': { isDirty: false },
      }[uri];
      assert.ok(data);
      return { success: true, data };
    },
    async callTool(name, args) {
      assert.equal(name, 'manage_scene');
      assert.equal(args.action, 'get_loaded_scenes');
      return { structuredContent: { success: true, data: { scenes: [{ isDirty: context.sceneDirty }] } } };
    },
  };
  const action = createProjectGit({ projectPath: project, repository: 'example/game' }, unity, async (path, args, signal) => {
    // The approved GitHub URL is simulated. All other Git commands use a real local remote.
    if (args[0] === 'remote' && args[1] === 'get-url') return context.remote + '\n';
    return (await exec('git', ['-C', path, ...args], { signal })).stdout;
  });
  const call = (name, args = {}) => action(`project_git_${name}`, args, AbortSignal.timeout(10_000));
  return { project, remote, base, write, script, call, context };
}

test('prepare, inspect, commit selected Unity files and push the exact SHA', async t => {
  const { project, remote, base, write, script, call } = await setup(t);
  const branch = 'feature/17-player-input';
  assert.equal((await call('status')).structuredContent.head, base);
  const prepared = await call('prepare', { branch });
  assert.equal(prepared.isError, false, prepared.content[0].text);
  assert.equal(prepared.structuredContent.branch, branch);
  await write(script, 'class PlayerInput { int speed = 3; }\n');
  await write('Assets/Notes.txt', 'separate WIP\n');
  assert.match((await call('diff', { files: [script] })).structuredContent.diff, /int speed/);

  const attempt = await call('commit', { branch, expectedHead: '0'.repeat(40), message: 'Update input', files: [script] });
  assert.equal(attempt.isError, true);
  assert.match(attempt.structuredContent.error, /HEAD/);
  const commit = await call('commit', { branch, expectedHead: base, message: 'Update input', files: [script] });
  assert.equal(commit.isError, false, commit.content[0].text);
  const sha = commit.structuredContent.head;
  assert.deepEqual(commit.structuredContent.changes, [{status: '??', path: 'Assets/Notes.txt'}]);
  assert.equal(git(project, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha).trim(), script);
  assert.equal((await call('push', { branch, expectedHead: sha })).isError, true);
  await rm(join(project, 'Assets', 'Notes.txt'));
  const pushed = await call('push', { branch, expectedHead: sha });
  assert.equal(pushed.isError, false, pushed.content[0].text);
  assert.deepEqual(pushed.structuredContent, { repository: 'example/game', branch, head: sha, pushed: true });
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`).trim(), sha);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main').trim(), base);
});

test('protects the base branch, remote, checkout and unsaved Unity work', async t => {
  const { project, base, write, script, call, context } = await setup(t);
  const branch = 'feature/18-guardrails';
  assert.equal((await call('prepare', { branch: 'main' })).isError, true);
  assert.equal((await call('prepare', { branch: '--force' })).isError, true);
  context.remote = 'https://github.com/other/game.git';
  assert.match((await call('prepare', { branch })).structuredContent.error, /origin/);
  context.remote = 'git@github.com:example/game.git';
  context.projectRoot = join(project, 'Assets');
  assert.match((await call('prepare', { branch })).structuredContent.error, /aktive Projekt/);
  context.projectRoot = project;
  context.isPlaying = true;
  assert.match((await call('prepare', { branch })).structuredContent.error, /Edit Mode/);
  context.isPlaying = false;
  context.sceneDirty = true;
  assert.match((await call('prepare', { branch })).structuredContent.error, /Speichere/);
  context.sceneDirty = false;
  assert.equal((await call('prepare', { branch })).isError, false);
  await write(script, 'class PlayerInput { }\n');
  await write('Assets/Other.cs', 'class Other {}\n');
  assert.equal((await call('commit', { branch, expectedHead: base, message: 'Test', files: ['../Game.cs'] })).isError, true);
  git(project, 'add', 'Assets/Other.cs');
  assert.match((await call('commit', { branch, expectedHead: base, message: 'Test', files: [script] })).structuredContent.error, /Index/);
  assert.equal(git(project, 'rev-parse', 'HEAD').trim(), base);
});
