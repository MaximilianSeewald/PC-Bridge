import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { toolPayload } from './unity-mcp.mjs';

const assetNamePattern = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const windowsDeviceName = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function validAssetName(name) {
  return typeof name === 'string' && assetNamePattern.test(name) && !windowsDeviceName.test(name);
}

async function inspectPath(path) {
  return lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

export async function unityProjectRoot(unity, configuredPath, signal) {
  const project = await unity.readResource('mcpforunity://project/info', signal);
  const currentPath = project?.data?.projectRoot;
  if (project?.success !== true || typeof currentPath !== 'string' || !isAbsolute(currentPath)) {
    throw new Error('Unity MCP meldet kein aktives lokales Unity-Projekt.');
  }
  const root = await realpath(currentPath);
  if (configuredPath !== undefined &&
      (typeof configuredPath !== 'string' || !isAbsolute(configuredPath) || root !== await realpath(configuredPath))) {
    throw new Error('Das aktive Unity-Projekt stimmt nicht mit pc-bridge.config.json überein.');
  }
  if (!(await inspectPath(join(root, 'Packages', 'manifest.json')))?.isFile() ||
      !(await inspectPath(join(root, 'ProjectSettings', 'ProjectVersion.txt')))?.isFile()) {
    throw new Error('Unity MCP meldet keinen gültigen Unity-Projektordner.');
  }
  return root;
}

export async function requireEditMode(unity, signal, operation) {
  const state = await unity.readResource('mcpforunity://editor/state', signal);
  const play = state?.data?.editor?.play_mode;
  if (state?.success !== true || play?.is_playing !== false || play.is_changing === true) {
    throw new Error(`Beende den Play Mode in Unity vor dem ${operation}.`);
  }
}

export async function importFolder(root, segments) {
  let folder = root;
  for (const name of segments) {
    folder = join(folder, name);
    let info = await inspectPath(folder);
    if (!info && name !== 'Assets') {
      await mkdir(folder).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      info = await lstat(folder);
    }
    if (!info?.isDirectory() || (await inspectPath(folder + '.meta'))?.isSymbolicLink()) {
      throw new Error('Der Unity-Importordner ist ungültig oder enthält einen symbolischen Link.');
    }
  }
  return folder;
}

export async function requireNewAsset(destination) {
  if (await inspectPath(destination) || await inspectPath(destination + '.meta')) {
    throw Object.assign(new Error('Der Assetname ist bereits vergeben. Wähle einen neuen Namen.'), { code: 'EEXIST' });
  }
}

export async function publishNewAsset(destination, signal, writeStaging) {
  await requireNewAsset(destination);
  const staging = join(dirname(destination), `.pc-bridge-${randomUUID()}.tmp`);
  try {
    await writeStaging(staging);
    signal.throwIfAborted();
    await link(staging, destination);
  } finally {
    await unlink(staging).catch(() => {});
  }
}

export async function unityImportGuid(unity, assetPath, signal) {
  const imported = await unity.callTool('manage_asset', { action: 'import', path: assetPath }, signal);
  const asset = toolPayload(imported);
  const guid = asset?.data?.guid;
  return !imported.isError && asset?.success === true && typeof guid === 'string' && /^[a-f0-9]{32}$/i.test(guid)
    ? guid : null;
}
