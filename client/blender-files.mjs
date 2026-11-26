import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, resolve, dirname, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { unityProjectRoot, requireEditMode } from './unity-asset-import.mjs';

export const blenderFileToolNames = new Set(['blender_list_files','blender_file_status','blender_open_file','blender_new_file','blender_save_file','blender_save_as']);
const ignored = new Set(['.git','library','temp','logs','obj','usersettings','packages','projectsettings','node_modules','build','builds','.vs']);
const inspect = path => lstat(path).catch(e => { if(e.code==='ENOENT') return null; throw e; });
const same = (a,b) => process.platform==='win32' ? resolve(a).toLowerCase()===resolve(b).toLowerCase() : resolve(a)===resolve(b);
const marker='PC_BRIDGE_BLEND_STATUS ';
function reply(data,isError=false) {
  return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError};
}
export function projectParts(path,extension) {
  if(typeof path!=='string'||path.length>512||!path.toLowerCase().endsWith(extension)||/[\\:\u0000-\u001f\u007f<>"|?*]/u.test(path)) throw new Error('Erwartet wird ein projektbezogener Dateipfad.');
  const parts=path.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||p.startsWith('.')||/[. ]$/.test(p)||ignored.has(p.toLowerCase())||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('Ungültiger oder ausgeschlossener Projektpfad.');
  return parts;
}
export async function projectFile(root,path,extension,{createParents=false,exists=true}={}) {
  const parts=projectParts(path,extension);
  let current=root;
  for(const part of parts.slice(0,-1)) {
    current=join(current,part);
    let stat=await inspect(current);
    if(!stat&&createParents) {
      await mkdir(current).catch(e=>{if(e.code!=='EEXIST') throw e;});
      stat=await inspect(current);
    }
    if(!stat?.isDirectory()||stat.isSymbolicLink()||!same(await realpath(current),current)) throw new Error('Projektordner fehlt oder ist ein symbolischer Link.');
  }
  const target=join(current,parts.at(-1));
  const stat=await inspect(target);
  if(stat&&(!stat.isFile()||stat.isSymbolicLink()||!same(await realpath(target),target))) throw new Error('Ungültige Zieldatei.');
  if(exists&&!stat) throw new Error('Projektdatei nicht gefunden.');
  if(!exists&&stat) throw new Error('Zieldatei existiert bereits.');
  return target;
}
function relativePath(root,absolute) {
  if(!absolute||!isAbsolute(absolute)) return null;
  const path=relative(root,absolute).split(sep).join('/');
  try {projectParts(path,'.blend');return path;} catch {return null;}
}
const statusCode="import bpy\nimport json\nprint('"+marker+"' + json.dumps({'filepath': bpy.data.filepath, 'dirty': bpy.data.is_dirty, 'objects': len(bpy.context.scene.objects)}))";
async function status(blender,signal) {
  const r=await blender('blender_execute_code',{code:statusCode},signal);
  const line=r.content?.find(b=>b.type==='text')?.text?.replace(/^Code executed successfully:\s*/,'').split(/\r?\n/).find(l=>l.startsWith(marker));
  if(r.isError||!line) throw new Error('Blender-Dateistatus konnte nicht gelesen werden.');
  const data=JSON.parse(line.slice(marker.length));
  if(typeof data.filepath!=='string'||typeof data.dirty!=='boolean'||!Number.isInteger(data.objects)) throw new Error('Ungültiger Blender-Dateistatus.');
  return data;
}
function publicStatus(root,data) {
  const path=relativePath(root,data.filepath);
  return {path,outsideProject:Boolean(data.filepath&&!path),dirty:data.dirty,objects:data.objects};
}
async function listFiles(root,signal) {
  const paths=[];let visited=0;
  async function walk(folder,prefix='') {
    signal.throwIfAborted();
    for(const entry of await readdir(folder,{withFileTypes:true})) {
      if(++visited>100000) throw new Error('Projekt zu groß für die vollständige Dateisuche.');
      if(entry.name.startsWith('.')||ignored.has(entry.name.toLowerCase())||entry.isSymbolicLink()) continue;
      const path=prefix+entry.name,full=join(folder,entry.name);
      if(entry.isDirectory()) {
        if(same(await realpath(full),full)) await walk(full,path+'/');
      } else if(entry.isFile()&&/\.blend$/i.test(entry.name)) {
        try {projectParts(path,'.blend');}catch {continue;}
        paths.push(path);
      }
    }
  }
  await walk(root);return paths.sort();
}
function guardedCode(before,op,requireClean=false) {
  return 'import bpy\nimport json\nexpected = json.loads('+JSON.stringify(JSON.stringify(before.filepath))+')\n'+
    "if bpy.data.filepath != expected:\n    raise RuntimeError('Aktive Datei hat sich geändert.')\n"+
    (requireClean?"if bpy.data.is_dirty:\n    raise RuntimeError('Ungespeicherte Änderungen zuerst speichern.')\n":'')+op;
}
async function verifyAfterSwitch(blender,signal,predicate) {
  // Reconnect with read-only probes; never retry a mutating operator.
  for(let attempt=0;attempt<5;attempt++) {
    signal.throwIfAborted();
    const current=await status(blender,signal).catch(()=>null);
    if(current&&predicate(current)) return current;
    if(attempt<4) await delay(400,undefined,{signal});
  }
  throw new Error('Dateiwechsel nicht bestätigt. Aktiven Dateistatus prüfen; nicht blind wiederholen.');
}
export function createBlenderFiles(unity,configuredPath,blender) {
  return async (name,args,signal)=>{
    try {
      const keys=name==='blender_list_files'?['offset','limit']:['blender_open_file','blender_save_as'].includes(name)?['path']:[];
      if(!blenderFileToolNames.has(name)||Object.keys(args).some(k=>!keys.includes(k))) throw new Error('Ungültige Parameter.');
      const root=await unityProjectRoot(unity,configuredPath,signal);
      if(name==='blender_list_files') {
        const {offset=0,limit=100}=args;
        if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200) throw new Error('Ungültige Seitengröße.');
        const paths=await listFiles(root,signal);
        return reply({files:paths.slice(offset,offset+limit),total:paths.length,nextOffset:offset+limit<paths.length?offset+limit:null});
      }
      const before=await status(blender,signal);
      if(name==='blender_file_status') return reply(publicStatus(root,before));
      await requireEditMode(unity,signal,'Blender-Dateioperation');
      let target;
      const switching=name==='blender_open_file'||name==='blender_new_file';
      if(switching&&before.dirty) throw new Error('Ungespeicherte Änderungen: zuerst blender_save_file oder blender_save_as verwenden.');
      if(name==='blender_open_file') target=await projectFile(root,args.path,'.blend');
      if(name==='blender_save_as') target=await projectFile(root,args.path,'.blend',{createParents:true,exists:false});
      if(name==='blender_save_file') {
        const path=relativePath(root,before.filepath);
        if(!path) throw new Error('Keine gespeicherte Blender-Projektdatei aktiv. Verwende blender_save_as.');
        target=await projectFile(root,path,'.blend');
      }
      if(target&&name.startsWith('blender_save')) {
        const filename=basename(target).toLowerCase();
        for(const entry of await readdir(dirname(target),{withFileTypes:true})) {
          if(entry.name.toLowerCase().startsWith(filename)&&/^\d+$/.test(entry.name.slice(filename.length))&&!entry.isFile()) throw new Error('Unsichere Blender-Sicherungsdatei.');
        }
      }
      if(await unityProjectRoot(unity,configuredPath,signal)!==root) throw new Error('Aktives Unity-Projekt hat sich geändert.');
      signal.throwIfAborted();
      if(name==='blender_open_file'&&before.filepath&&same(before.filepath,target)) return reply(publicStatus(root,before));
      // Encode path as JSON text then decode in Python, including Windows and Unicode paths.
      const literal=target?'json.loads('+JSON.stringify(JSON.stringify(target))+')':'';
      const op=name==='blender_open_file'?'bpy.ops.wm.open_mainfile(filepath='+literal+', load_ui=False, use_scripts=False)':
        name==='blender_new_file'?'bpy.ops.wm.read_homefile(load_ui=False, use_empty=True)':
        name==='blender_save_as'?'bpy.ops.wm.save_as_mainfile(filepath='+literal+', check_existing=False)':
        'bpy.ops.wm.save_mainfile(filepath='+literal+', check_existing=False)';
      const executed=await blender('blender_execute_code',{code:guardedCode(before,op,switching)},signal);
      if(!switching&&executed.isError) throw new Error(executed.content?.[0]?.text||'Speichern fehlgeschlagen.');
      const after=switching?await verifyAfterSwitch(blender,signal,d=>name==='blender_new_file'?!d.filepath&&d.objects===0:Boolean(d.filepath)&&same(d.filepath,target)&&!d.dirty):await status(blender,signal);
      if(!switching&&(!after.filepath||!same(after.filepath,target)||after.dirty||!(await inspect(target))?.isFile())) throw new Error('Speichern konnte nicht bestätigt werden.');
      return reply(publicStatus(root,after));
    }catch(error){
      return reply({error:signal.aborted?'Zeitlimit. Vor Wiederholung aktiven Blender-Dateistatus prüfen.':error.code?'Lokale Dateioperation fehlgeschlagen.':error.message},true);
    }
  };
}
