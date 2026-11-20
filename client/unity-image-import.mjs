import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolPayload } from './unity-mcp.mjs';
import {
  importFolder, publishNewAsset, requireEditMode, unityImportGuid, unityProjectRoot, validAssetName,
} from './unity-asset-import.mjs';

const maxImageBytes = 12 * 1024 * 1024;
const maxImageDimension = 8192;
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

function result(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError };
}

export function createUnityImageImporter(unity, configuredPath, fetchImpl = fetch) {
  return async (args, signal) => {
    let assetPath;
    let saved = false;
    try {
      const { file, assetName, pixelsPerUnit = 100 } = args;
      if (!validAssetName(assetName)) {
        throw new Error('Gib einen Assetnamen aus Buchstaben, Zahlen, Unterstrichen oder Bindestrichen an.');
      }
      if (!Number.isInteger(pixelsPerUnit) || pixelsPerUnit < 1 || pixelsPerUnit > 1024) {
        throw new Error('Pixels per Unit muss eine ganze Zahl zwischen 1 und 1024 sein.');
      }

      const root = await unityProjectRoot(unity, configuredPath, signal);
      await requireEditMode(unity, signal, 'Sprite-Import');

      const bytes = await downloadImage(file?.download_url, signal, fetchImpl);
      const { extension, width, height } = imageHeader(bytes);
      if (!width || !height || width > maxImageDimension || height > maxImageDimension || width * height > 32_000_000) {
        throw new Error('Das Bild ist zu groß. Erlaubt sind höchstens 8192 Pixel pro Seite und 32 Megapixel.');
      }

      const folder = await importFolder(root, ['Assets', 'Art', 'ChatImports']);
      const fileName = `${assetName}.${extension}`;
      const destination = join(folder, fileName);
      assetPath = `Assets/Art/ChatImports/${fileName}`;
      await publishNewAsset(destination, signal, staging => writeFile(staging, bytes, { flag: 'wx', signal }));
      saved = true;

      const guid = await unityImportGuid(unity, assetPath, signal);
      if (!guid) {
        throw new Error('Unity konnte das gespeicherte Bild noch nicht importieren.');
      }
      const sprite = await unity.callTool('manage_texture', {
        action: 'set_import_settings', path: assetPath, as_sprite: { pixels_per_unit: pixelsPerUnit },
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
