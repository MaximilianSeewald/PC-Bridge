import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { toolPayload } from './unity-mcp.mjs';

const maxImageBytes = 12 * 1024 * 1024;
const maxImageDimension = 8192;
const assetNamePattern = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const windowsDeviceName = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chatFileUrl(value) {
  const url = typeof value === 'string' && value.length <= 8192 ? URL.parse(value) : null;
  const host = url?.hostname ?? '';
  const openAiHost = host.endsWith('.oaiusercontent.com') ||
    /^(?:oaisdmntpr|oaisdsorpr)[a-z0-9]*\.blob\.core\.windows\.net$/.test(host) ||
    /^oaisdmntpr[a-z0-9-]*\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host);
  if (!url || !openAiHost || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) {
    throw new Error('Die Datei muss als ChatGPT-Datei mit einem gültigen Downloadverweis übergeben werden.');
  }
  return url;
}

async function downloadImage(value, signal, fetchImpl) {
  let url = chatFileUrl(value);
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const response = await fetchImpl(url, { signal, redirect: 'manual', credentials: 'omit' });
    try {
      if (response.status >= 300 && response.status < 400 && redirects < 2) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Der Bilddownload hat keinen gültigen Zielverweis.');
        url = chatFileUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) {
        throw new Error('Der Bilddownload ist fehlgeschlagen. Wähle das Bild erneut im Chat und versuche es noch einmal.');
      }
      if (Number(response.headers.get('content-length')) > maxImageBytes) {
        throw new Error('Das Bild überschreitet 12 MiB.');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxImageBytes) throw new Error('Das Bild überschreitet 12 MiB.');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
  throw new Error('Zu viele Weiterleitungen beim Bilddownload.');
}

function imageHeader(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(pngSignature) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') {
    return { extension: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 14 && bytes.readUInt16BE(0) === 0xFFD8 && bytes.readUInt16BE(bytes.length - 2) === 0xFFD9) {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xFF) {
      while (bytes[offset + 1] === 0xFF) offset += 1;
      if (offset + 4 > bytes.length) break;
      const marker = bytes[offset + 1];
      if (marker === 0xDA || marker === 0xD9) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if ([0xC0, 0xC1, 0xC2].includes(marker) && length >= 8) {
        return { extension: 'jpg', width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += length + 2;
    }
  }
  throw new Error('Die Datei ist kein unterstütztes PNG oder JPEG.');
}

async function inspectPath(path) {
  return lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function importFolder(root) {
  let folder = root;
  for (const name of ['Assets', 'Art', 'ChatImports']) {
    folder = join(folder, name);
    let info = await inspectPath(folder);
    if (!info && name !== 'Assets') {
      await mkdir(folder).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      info = await lstat(folder);
    }
    if (!info?.isDirectory() || await inspectPath(folder + '.meta').then(meta => meta?.isSymbolicLink())) {
      throw new Error('Der Unity-Importordner ist ungültig oder enthält einen symbolischen Link.');
    }
  }
  return folder;
}

function result(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError };
}

export function createUnityImageImporter(unity, configuredPath, fetchImpl = fetch) {
  return async (args, signal) => {
    let assetPath;
    let saved = false;
    try {
      const { file, assetName, pixelsPerUnit = 100 } = args;
      if (typeof assetName !== 'string' || !assetNamePattern.test(assetName) || windowsDeviceName.test(assetName)) {
        throw new Error('Gib einen Assetnamen aus Buchstaben, Zahlen, Unterstrichen oder Bindestrichen an.');
      }
      if (!Number.isInteger(pixelsPerUnit) || pixelsPerUnit < 1 || pixelsPerUnit > 1024) {
        throw new Error('Pixels per Unit muss eine ganze Zahl zwischen 1 und 1024 sein.');
      }

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
      const state = await unity.readResource('mcpforunity://editor/state', signal);
      const play = state?.data?.editor?.play_mode;
      if (state?.success !== true || play?.is_playing !== false || play.is_changing === true) {
        throw new Error('Beende den Play Mode in Unity vor dem Sprite-Import.');
      }

      const bytes = await downloadImage(file?.download_url, signal, fetchImpl);
      const { extension, width, height } = imageHeader(bytes);
      if (!width || !height || width > maxImageDimension || height > maxImageDimension || width * height > 32_000_000) {
        throw new Error('Das Bild ist zu groß. Erlaubt sind höchstens 8192 Pixel pro Seite und 32 Megapixel.');
      }

      const folder = await importFolder(root);
      const fileName = `${assetName}.${extension}`;
      const destination = join(folder, fileName);
      assetPath = `Assets/Art/ChatImports/${fileName}`;
      if (await inspectPath(destination) || await inspectPath(destination + '.meta')) {
        throw Object.assign(new Error('Der Assetname ist bereits vergeben. Wähle einen neuen Namen.'), { code: 'EEXIST' });
      }
      const staging = join(folder, `.pc-bridge-${randomUUID()}.tmp`);
      try {
        await writeFile(staging, bytes, { flag: 'wx', signal });
        signal.throwIfAborted();
        await link(staging, destination);
        saved = true;
      } finally {
        await unlink(staging).catch(() => {});
      }

      const imported = await unity.callTool('manage_asset', { action: 'import', path: assetPath }, signal);
      const asset = toolPayload(imported);
      const guid = asset?.data?.guid;
      if (imported.isError || asset?.success !== true || typeof guid !== 'string' || !/^[a-f0-9]{32}$/i.test(guid)) {
        throw new Error('Unity konnte das gespeicherte Bild noch nicht importieren.');
      }
      const sprite = await unity.callTool('manage_texture', {
        action: 'set_import_settings', path: assetPath, as_sprite: { pixels_per_unit: pixelsPerUnit },
        import_settings: { alpha_is_transparency: extension === 'png', generate_mipmaps: false },
      }, signal);
      if (sprite.isError || toolPayload(sprite)?.success !== true) {
        throw new Error('Unity hat das Bild importiert, aber noch nicht als Sprite eingerichtet.');
      }

      return result({ path: assetPath, guid, width, height, pixelsPerUnit, importedAs: 'Sprite' });
    } catch (error) {
      let message = error instanceof Error && !error.code ? error.message : 'Der Import auf dem lokalen PC ist fehlgeschlagen.';
      if (error.code === 'EEXIST') message = 'Der Assetname ist bereits vergeben. Wähle einen neuen Namen.';
      if (signal.aborted) message = 'Zeitlimit beim Bildimport erreicht.';
      if (saved) {
        return result({
          path: assetPath,
          error: `${message} Die Datei ist vorhanden. Prüfe sie in Unity und setze bei Bedarf die Sprite-Einstellungen.`,
        }, true);
      }
      return result({ error: message }, true);
    }
  };
}
