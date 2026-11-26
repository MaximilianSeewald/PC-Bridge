import { constants } from 'node:fs';
import { copyFile, lstat, mkdtemp, open, rm, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { projectFile } from './blender-files.mjs';
import { toolPayload } from './unity-mcp.mjs';
import { join, dirname } from 'node:path';
import {
  importFolder, publishNewAsset, requireEditMode, requireNewAsset, unityImportGuid, unityProjectRoot, validAssetName,
} from './unity-asset-import.mjs';

const folderParts = ['Assets', 'Art', 'BlenderImports'];
const maxFbxBytes = 64 * 1024 * 1024;
const binaryFbxSignature = Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'ascii');
const objectNamePattern = /^[^\u0000-\u001f\u007f]{1,255}$/u;
const resultMarker = 'PC_BRIDGE_FBX ';

function exportScript(filepath, objectNames, animations) {
  const config = JSON.stringify({ filepath, objectNames, animations });
  return `
import bpy
import json

def export_to_unity():
    req = json.loads(${JSON.stringify(config)})
    if bpy.context.mode != 'OBJECT':
        raise RuntimeError('Wechsle in Blender vor dem FBX-Export in den Objektmodus.')
    objects = list(bpy.context.selected_objects)
    if req['objectNames']:
        objects = [bpy.context.view_layer.objects.get(name) for name in req['objectNames']]
        if None in objects:
            raise RuntimeError('Mindestens ein Objektname fehlt im aktiven View Layer.')
    if not objects:
        raise RuntimeError('Wähle Blender-Objekte aus oder übergib ihre Namen.')
    if any(obj.type not in {'MESH', 'ARMATURE', 'EMPTY'} for obj in objects):
        raise RuntimeError('Für den FBX-Export sind Meshes, Armatures und Empties erlaubt.')
    with bpy.context.temp_override(selected_objects=objects):
        status = bpy.ops.export_scene.fbx(filepath=req['filepath'], use_selection=True, check_existing=False,
            object_types={'MESH', 'ARMATURE', 'EMPTY'}, axis_forward='-Z', axis_up='Y', apply_unit_scale=True,
            use_mesh_modifiers=True, add_leaf_bones=False, path_mode='STRIP', bake_anim=req['animations'])
    if 'FINISHED' not in status:
        raise RuntimeError('Blender hat den FBX-Export abgebrochen.')
    return [obj.name for obj in objects]

print('${resultMarker}' + json.dumps(export_to_unity()))
`;
}

async function validateFbx(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size <= binaryFbxSignature.length || info.size > maxFbxBytes) {
    throw new Error('Blender muss eine lokale FBX-Datei bis 64 MiB liefern.');
  }
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(binaryFbxSignature.length);
    const { bytesRead } = await file.read(header);
    if (bytesRead !== header.length || !header.equals(binaryFbxSignature)) {
      throw new Error('Blender hat keine gültige binäre FBX-Datei geliefert.');
    }
  } finally {
    await file.close();
  }
  return info.size;
}

function result(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError };
}

async function verifyExisting(unity, root, path, guid, signal) {
  const destination = await projectFile(root,path,'.fbx');
  const meta = await lstat(destination+'.meta');
  if(!meta.isFile() || meta.isSymbolicLink()) throw new Error('Ungültige Unity-Metadatei.');
  const metaBytes=await readFile(destination+'.meta');
  const actual = metaBytes.toString('utf8').match(/^guid:\s*([a-f0-9]{32})\s*$/mi)?.[1];
  if(actual?.toLowerCase()!==guid.toLowerCase()) throw new Error('Unity-GUID stimmt nicht überein.');
  const info=await unity.callTool('manage_asset',{action:'get_info',path,generate_preview:false},signal);
  const data=toolPayload(info);
  if(info.isError || data?.success!==true || data.data?.guid?.toLowerCase()!==guid.toLowerCase()) throw new Error('Unity bestätigt die erwartete GUID nicht.');
  return {destination,metaBytes,stat:await lstat(destination)};
}
export function createBlenderFbxToUnity(unity, configuredPath, callBlender) {
  return async (args, signal) => {
    let temporary;
    let savedPath;
    try {
      const { assetName, objectNames = [], animations = false, targetPath, expectedGuid } = args;
      if (Object.keys(args).some(key => !['assetName', 'objectNames', 'animations', 'targetPath', 'expectedGuid'].includes(key)) || !validAssetName(assetName)) {
        throw new Error('Gib einen neuen Assetnamen ohne Pfad oder Endung an.');
      }
      if (!Array.isArray(objectNames) || objectNames.length > 64 || new Set(objectNames).size !== objectNames.length ||
          !objectNames.every(name => typeof name === 'string' && objectNamePattern.test(name)) ||
          typeof animations !== 'boolean') {
        throw new Error('Gib eindeutige Blender-Objektnamen an und setze animations auf true oder false.');
      }
      const root = await unityProjectRoot(unity, configuredPath, signal);
      await requireEditMode(unity, signal, 'FBX-Import');
      const fileName = `${assetName}.fbx`;
      const updating = expectedGuid !== undefined;
      if ((updating && (typeof expectedGuid !== 'string' || !/^[a-f0-9]{32}$/i.test(expectedGuid))) ||
          (targetPath !== undefined && (!updating || typeof targetPath !== 'string' || !targetPath.startsWith('Assets/') || targetPath.split('/').at(-1)!==fileName))) {
        throw new Error('Aktualisierung erfordert erwartete GUID und einen passenden FBX-Pfad unter Assets.');
      }
      const path = targetPath ?? [...folderParts,fileName].join('/');
      const old = updating ? await verifyExisting(unity,root,path,expectedGuid,signal) : null;
      if (!updating) await requireNewAsset(join(root, ...folderParts, fileName));

      temporary = await mkdtemp(join(tmpdir(), 'pc-bridge-fbx-'));
      const source = join(temporary, 'model.fbx');
      const exported = await callBlender('blender_execute_code', { code: exportScript(source, objectNames, animations) }, signal);
      const text = exported.content?.find(block => block.type === 'text')?.text ?? '';
      if (exported.isError) throw new Error(text || 'Blender konnte das FBX nicht exportieren.');
      const resultLine = text.replace(/^Code executed successfully:\s*/, '')
        .split(/\r?\n/).findLast(line => line.startsWith(resultMarker));
      const objects = resultLine && JSON.parse(resultLine.slice(resultMarker.length));
      if (!Array.isArray(objects) || !objects.length || !objects.every(name => typeof name === 'string')) {
        throw new Error('Blender hat den FBX-Export nicht bestätigt.');
      }
      const bytes = await validateFbx(source);
      if (await unityProjectRoot(unity, configuredPath, signal) !== root) {
        throw new Error('Das aktive Unity-Projekt wurde während des Exports gewechselt.');
      }
      await requireEditMode(unity, signal, 'FBX-Import');
      signal.throwIfAborted();
      if (updating) {
        const now = await verifyExisting(unity,root,path,expectedGuid,signal);
        if (!old.metaBytes.equals(now.metaBytes) || old.stat.size!==now.stat.size || old.stat.mtimeMs!==now.stat.mtimeMs || old.stat.ino!==now.stat.ino) throw new Error('FBX oder Metadatei wurde während des Exports geändert.');
        const staging = join(dirname(now.destination),'.pc-bridge-'+randomUUID()+'.tmp');
        try {
          await copyFile(source,staging,constants.COPYFILE_EXCL);
          signal.throwIfAborted();
          await rename(staging,now.destination);
        } finally { await rm(staging,{force:true}).catch(()=>{}); }
      } else {
        const folder = await importFolder(root, folderParts);
        await publishNewAsset(join(folder, fileName), signal, staging => copyFile(source, staging, constants.COPYFILE_EXCL));
      }
      savedPath = path;

      const guid = await unityImportGuid(unity, savedPath, signal);
      if (!guid) throw new Error('Unity hat den Modellimport noch nicht bestätigt.');
      if (updating && (guid.toLowerCase() !== expectedGuid.toLowerCase() || !old.metaBytes.equals(await readFile(old.destination+'.meta')))) throw new Error('Unity-Metadaten wurden beim Reimport verändert. Prüfe Referenzen.');
      return result({ path: savedPath, guid, objects, bytes, animations, ...(updating ? {updated:true} : {}) });
    } catch (error) {
      let message = error instanceof Error && !error.code ? error.message : 'Die lokale Blender-Unity-Übergabe ist fehlgeschlagen.';
      if (error?.code === 'EEXIST') message = 'Der Assetname ist bereits vergeben. Wähle einen neuen Namen.';
      if (signal.aborted) message = 'Zeitlimit bei der Blender-Unity-Übergabe erreicht.';
      if (savedPath) {
        return result({ path: savedPath, error: `${message} Das FBX liegt im Projekt und kann in Unity importiert werden.` }, true);
      }
      return result({ error: message }, true);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  };
}
