import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlenderFiles, blenderFileToolNames } from '../client/blender-files.mjs';
import { createBlenderFbxToUnity } from '../client/blender-fbx-to-unity.mjs';
import { runJob } from '../client/pc-bridge.mjs';

async function fixture(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'pc-bridge-blend-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const folder of ['Assets','Packages','ProjectSettings','Library']) await mkdir(join(root,folder));
  await writeFile(join(root,'Packages','manifest.json'),'{}');
  await writeFile(join(root,'ProjectSettings','ProjectVersion.txt'),'test');
  await writeFile(join(root,'Library','ignored.blend'),'ignored');
  let playing=false;
  const unity={
    async readResource(uri) {
      return {success:true,data:uri.endsWith('project/info')?{projectRoot:root}:{editor:{play_mode:{is_playing:playing}}}};
    }
  };
  return {root,unity,setPlaying:v=>playing=v};
}

test('project-scoped Blender lifecycle including lost switch response and dirty protection',async t=>{
  const {root,unity,setPlaying}=await fixture(t);
  let state={filepath:'',dirty:false,objects:0};
  let writes=0;
  let unavailableOnce=false;
  const fakeBlender=async (name,{code})=>{
    assert.equal(name,'blender_execute_code');
    if(code.includes('PC_BRIDGE_BLEND_STATUS')) {
      if(unavailableOnce) {unavailableOnce=false;return {isError:true,content:[]};}
      return {content:[{type:'text',text:'Code executed successfully: PC_BRIDGE_BLEND_STATUS '+JSON.stringify(state)}]};
    }
    writes++;
    const match=code.match(/filepath=json\.loads\(("(?:[^"\\]|\\.)*")\)/);
    const target=match?JSON.parse(JSON.parse(match[1])):null;
    if(code.includes('wm.read_homefile')) {
      state={filepath:'',dirty:false,objects:0};
      unavailableOnce=true;
      return {isError:true,content:[]};
    }
    if(code.includes('wm.open_mainfile')) {
      assert.match(code,/use_scripts=False/);
      state={filepath:target,dirty:false,objects:Number(await readFile(target,'utf8'))};
      unavailableOnce=true;
      return {isError:true,content:[]};
    }
    assert.ok(code.includes('wm.save_as_mainfile')||code.includes('wm.save_mainfile'));
    await writeFile(target,String(state.objects));
    state={...state,filepath:target,dirty:false};
    return {content:[{type:'text',text:'Code executed successfully:'}]};
  };
  const dispatch=createBlenderFiles(unity,root,fakeBlender);
  const call=async(name,args={})=>{
    const result=await runJob({tool:name,arguments:args,expires_at:Date.now()+10000},
      ()=>assert.fail('unexpected Unity route'),undefined,undefined,undefined,dispatch);
    assert.equal(result.ok,true);
    return result.output;
  };
  assert.equal(blenderFileToolNames.size,6);
  const a='ArtSource/Blender/Pumpe ä.blend',b='Assets/Schott.blend';
  assert.equal((await call('blender_new_file')).isError,false);
  state={...state,dirty:true,objects:3};
  assert.equal((await call('blender_save_as',{path:a})).structuredContent.path,a);
  assert.equal((await call('blender_save_as',{path:a})).isError,true);
  state={...state,dirty:true,objects:4};
  const before=writes;
  assert.equal((await call('blender_new_file')).isError,true);
  assert.equal((await call('blender_open_file',{path:a})).isError,true);
  assert.equal(writes,before);
  assert.equal((await call('blender_save_file')).structuredContent.dirty,false);
  assert.equal((await call('blender_new_file')).structuredContent.objects,0);
  state={...state,dirty:true,objects:1};
  assert.equal((await call('blender_save_as',{path:b})).isError,false);
  assert.equal((await call('blender_open_file',{path:a})).structuredContent.objects,4);
  assert.equal((await call('blender_file_status')).structuredContent.path,a);
  assert.deepEqual((await call('blender_list_files',{limit:1})).structuredContent,{files:[a],total:2,nextOffset:1});
  assert.deepEqual((await call('blender_list_files',{offset:1})).structuredContent.files,[b]);
  for(const path of ['../evil.blend','C:/outside.blend','Library/ignored.blend','/outside.blend','Assets/CON.blend','Assets/a.blend1']) {
    assert.equal((await call('blender_open_file',{path})).isError,true,path);
  }
  if(process.platform!=='win32') {
    await symlink(join(root,'Assets'),join(root,'ArtLink'));
    assert.equal((await call('blender_open_file',{path:'ArtLink/Schott.blend'})).isError,true);
  }
  setPlaying(true);
  assert.equal((await call('blender_save_file')).isError,true);
});

test('explicit FBX update preserves metadata and requires matching GUID',async t=>{
  const {root,unity}=await fixture(t);
  const path='Assets/Model.fbx',target=join(root,path);
  const guid='ab'.repeat(16);
  const meta=Buffer.from('fileFormatVersion: 2\nguid: '+guid+'\nModelImporter:\n  serializedVersion: 1\n');
  await writeFile(target,'previous');
  await writeFile(target+'.meta',meta);
  let imports=0,exports=0;
  unity.callTool=async(name,args)=>{
    assert.equal(name,'manage_asset');assert.equal(args.path,path);
    if(args.action==='import') imports++;
    else assert.equal(args.action,'get_info');
    return {content:[],structuredContent:{success:true,data:{guid}}};
  };
  const fbx=Buffer.concat([Buffer.from('Kaydara FBX Binary  \0\x1a\0','ascii'),Buffer.from('updated model')]);
  const blender=async(name,{code})=>{
    exports++;
    const line=code.split('\n').find(l=>l.includes('req = json.loads(')).trim();
    const req=JSON.parse(JSON.parse(line.slice('req = json.loads('.length,-1)));
    await writeFile(req.filepath,fbx);
    return {content:[{type:'text',text:'Code executed successfully: PC_BRIDGE_FBX ["Model"]'}]};
  };
  const transfer=createBlenderFbxToUnity(unity,root,blender);
  const call=args=>transfer(args,AbortSignal.timeout(10000));
  const args={assetName:'Model',targetPath:path,objectNames:['Model']};
  assert.equal((await call(args)).isError,true);
  assert.equal((await call({...args,expectedGuid:'cd'.repeat(16)})).isError,true);
  assert.equal(exports,0);
  assert.equal(await readFile(target,'utf8'),'previous');
  const result=await call({...args,expectedGuid:guid});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.equal(result.structuredContent.updated,true);
  assert.equal(result.structuredContent.guid,guid);
  assert.deepEqual(await readFile(target),fbx);
  assert.deepEqual(await readFile(target+'.meta'),meta);
  assert.equal(imports,1);
});
