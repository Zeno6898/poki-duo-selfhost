import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, cp, mkdir, writeFile, readFile, symlink, rm, watch, utimes, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import sharp from 'sharp';
import { root } from '../src/config.mjs';

const fixtureProgram = `#!/usr/bin/env node
const listSlid=s=>Boolean(s.list)&&!s.list.slideReads&&!s.list.alwaysHits;
const afterTap=(s,ratio)=>s.shiftsOnTap?(s.shifted?{focused:false}:{focused:true,shifted:true}):s.revealsTwinOnTap?{otherField:s.field,focused:false,revealsTwinOnTap:false}:s.list&&(s.list.alwaysHits||(listSlid(s)&&ratio>=0.2&&ratio<=0.3))?{list:{...s.list,editing:true},field:undefined,focused:false}:{focused:true};
const editingBit=2**21;
const phoneTop=(s,r)=>s.phone.keyboard?r.up:r.down;
const phoneRowAt=(s,hidY)=>{const y=hidY/65535*199;return s.phone.rows.find(r=>y>=phoneTop(s,r)&&y<=phoneTop(s,r)+20);};
const phoneTap=(s,hidY)=>{const hit=s.phone.tapLandsOn?s.phone.rows.find(r=>r.id===s.phone.tapLandsOn):phoneRowAt(s,hidY);if(!hit||s.phone.tapsIgnored)return;for(const r of s.phone.rows)r.editing=r===hit;s.phone.keyboard=true;};
const readList=(s,file)=>{if(s.list?.slideReads)file(JSON.stringify({...s,list:{...s.list,slideReads:s.list.slideReads-1}}));};
import { readFileSync, writeFileSync, appendFileSync, copyFileSync, mkdirSync, renameSync } from 'node:fs';
// Several fixture processes read the state while others write it, so a write must never be seen half done.
const writeState=text=>{const temporary=process.env.FIXTURE_STATE+'.'+process.pid+'.tmp';writeFileSync(temporary,text);renameSync(temporary,process.env.FIXTURE_STATE);};
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
const args=process.argv.slice(2), tool=basename(process.argv[1]), state=JSON.parse(readFileSync(process.env.FIXTURE_STATE));
const log=(event)=>appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(event)+'\\n');
log({tool,args,pid:process.pid});
if(tool==='python3') console.log(JSON.stringify(state.simulatorOnly?[]:state.twoPhones?[{id:'fixture-phone',connection:'USB'},{id:'fixture-phone-2',connection:'USB'}]:[{id:'fixture-phone',connection:'USB'}]));
else if(tool==='xcrun') {if(args.includes('listapps')){console.log('<?xml version="1.0"?><plist version="1.0"><dict><key>local.fixture</key><dict><key>CFBundleName</key><string>Fixture</string></dict></dict></plist>');process.exit(0);}if(args.includes('launch')){console.log('local.fixture: 4242');process.exit(0);}if(args.includes('keyboard')){writeState(JSON.stringify({...state,keyboard:args.at(-1)}));process.exit(0);}if(args.includes('screenshot')){copyFileSync(process.env.FIXTURE_IMAGE,args.at(-1));process.exit(0);}if(args.includes('devicectl')&&args.includes('copy')){if(state.denyContainer){console.error('Container access denied by device');process.exit(1);}const destination=args[args.indexOf('--destination')+1];mkdirSync(destination+'/Documents',{recursive:true});writeFileSync(destination+'/Documents/check.txt','fixture container contents');console.log(JSON.stringify({info:{outcome:'success'},result:{}}));process.exit(0);}if(state.coreDeviceUnavailable&&args.includes('devicectl')){console.error('ERROR: The specified device was not found. (com.apple.dt.CoreDeviceError error 1000)');process.exit(1);} console.log(JSON.stringify({devices:state.simulatorOnly?{'com.apple.CoreSimulator.SimRuntime.iOS-27-0':[{udid:'fixture-sim',name:'Fixture Simulator',state:state.simulatorBooted?'Booted':'Shutdown',dataPath:process.env.HOME+'/simulator'},...(state.secondSimulator?[{udid:'fixture-sim-2',name:'Second Simulator',state:'Booted',dataPath:process.env.HOME+'/simulator-2'}]:[])]}:{}}));}
else if(tool==='idevice') {
 if(args.includes('screenshot')) {if(state.screenshotUnavailable){console.error('Screenshot service unavailable');process.exit(1);}copyFileSync(process.env.FIXTURE_IMAGE,args.at(-1));console.log('Screenshot saved to: fixture');}
 else if(args.includes('screencapture')) {if(state.failRecording)process.exit(1);if(!state.recordingBlock)process.stdout.write('frame');process.stdin.resume();setInterval(()=>{},10000);}
 else console.log(JSON.stringify(args.at(-1)==='ScreenScaleFactor'?1:args.at(-1)==='DeviceName'?'Fixture Phone':'fixture'));
} else if(tool==='ocr') {if(state.ocrUnavailable){console.error('Text recognition unavailable');process.exit(1);}if(state.ocrXs?.length>1)writeState(JSON.stringify({...state,ocrXs:state.ocrXs.slice(1)}));console.log(JSON.stringify([{text:state.appearsAfterReads?'Loading':state.ocrLabel??state.label??'First',x:state.ocrXs?.[0]??10,y:10,width:40,height:20}]));}
else if(tool==='simulator') {
 const connectionKeyboard=state.keyboard;
 const applyInput=req=>{
  const now=JSON.parse(readFileSync(process.env.FIXTURE_STATE)),save=change=>writeState(JSON.stringify({...now,...change}));
  if(req.events.some(e=>e.messageType==='IndigoDigitizerEvent')){if(Date.now()-(now.touchedAt??0)<(now.busyAfterTouchMs??0))log({op:'touch_ignored'});else if(now.tapsIgnored)save({tapsIgnored:now.tapsIgnored-1});else save({...afterTap(now,req.events.find(e=>e.payload?.pointOne)?.payload.pointOne.y),touchedAt:Date.now(),...(now.toggle?{selected:!now.selected}:{})});}else if(now.list?.editing)save({list:{...now.list,row:now.typed}});else if(now.typingGoesToOther)save({otherField:now.typed,focused:false});else if(now.sameName!==undefined&&!now.focused)save({otherField:now.typed});else if(now.fieldVanishesOnTyping||(now.backspaceDeletesEmptyField&&now.field===''&&req.events.some(e=>e.messageType==='IndigoKeyboardButtonEvent'&&e.payload?.usageCode===42)))save({field:undefined,focused:false});else if(now.typed!==undefined&&now.focused)save({field:connectionKeyboard==='en_US'&&now.keyboard==='en_US'&&!now.keyboardIgnored?now.typed:now.imeResult});
  console.log(JSON.stringify({sent:true,screen_change_verified:false,events:req.events.length}));
 };
 if(args[0]==='--hid-session'){console.log(JSON.stringify({ready:true}));for await(const line of createInterface({input:process.stdin})){const now=JSON.parse(readFileSync(process.env.FIXTURE_STATE));if(now.inputExit){writeState(JSON.stringify({...now,inputExit:0}));console.error('The simulator closed its input connection.');process.exit(now.inputExit);}const req=JSON.parse(line);log({op:'hid',device:args[1],request:req});applyInput(req);}process.exit(0);}
 let input='';for await(const chunk of process.stdin)input+=chunk;const req=JSON.parse(input);log({op:req.op,request:req});
 const save=change=>writeState(JSON.stringify({...state,...change}));
 if(req.op==='info')console.log(JSON.stringify({width:100,height:200,scale:1}));
 else if(req.op==='ax'){if(state.axEmptyReads)save({axEmptyReads:state.axEmptyReads-1});readList(state,text=>writeState(text));console.log(JSON.stringify({source:'accessibility',bundle_id:state.systemPrompt?'com.apple.springboard':'local.fixture',label:'Fixture',pid:4242,elements:state.axEmptyReads?[]:[{label:state.labels?.[req.id]??state.label??'First',type:2,selected:Boolean(state.selected),x:10,y:10,width:40,height:20},...(state.field===undefined?[]:[{placeholder:state.sameName??'Name',value:state.field,type:15,focused:state.focused,x:10,y:(listSlid(state)?140:40)-(state.shifted?30:0),width:40,height:20}]),...(state.list?.editing?[{placeholder:'Name',value:state.list.row,type:15,focused:true,x:10,y:40,width:40,height:20}]:listSlid(state)?[{label:state.list.row,type:4,x:10,y:40,width:40,height:20}]:[]),...(state.otherField===undefined?[]:[{placeholder:state.sameName??'Other',value:state.otherField,type:15,focused:!state.focused,x:10,y:70-(state.shifted?30:0),width:40,height:20}])]}));}
 else if(req.op==='paste_text'){save({field:''});console.log(JSON.stringify({sent:true,screen_change_verified:false,clipboard_changed:true}));}
 else throw Error('Unexpected simulator request '+req.op);
}
else if(tool==='poki-native') {
 let input='';for await(const chunk of process.stdin)input+=chunk;const req=JSON.parse(input);log({op:req.op,request:req});
 if(state.block===req.op){setInterval(()=>{},10000);}
 else if(req.op==='install_app'||req.op==='uninstall_app'){if(req.op==='install_app'&&!execFileSync('/usr/bin/unzip',['-p',req.ipa_path,'Payload/InstallFixture.app/Info.plist'],{encoding:'utf8'}).includes('local.installfixture'))throw Error('Invalid package layout');if(state.installUnknown){console.log(JSON.stringify({isError:true,outcome:'unknown',operation:req.op,bundle_id:req.bundle_id,error:'Connection closed after sending request'}));process.exit(0);}writeState(JSON.stringify({...state,installed:req.op==='install_app',inventoryFailed:state.failInventoryAfterMutation}));console.log(JSON.stringify({outcome:'completed',bundle_id:req.bundle_id,staging_cleanup:{removed:true}}));}
 else if(req.op==='list_apps'&&state.inventoryFailed){console.error('Inventory connection unavailable');process.exit(1);}
 else if(req.op==='list_apps'&&state.appDirectoryFailures){writeState(JSON.stringify({...state,appDirectoryFailures:state.appDirectoryFailures-1}));console.error('bad device');process.exit(1);}
 else if(req.op==='list_apps')console.log(JSON.stringify({apps:state.apps??[...(state.installed?[{bundle_id:'local.installfixture',name:'Install Fixture',system:false,version:'3'}]:[]),{bundle_id:'com.apple.Preferences',name:'Settings',system:true,version:'1.0',path:'/Applications/Preferences.app',developer:false},{bundle_id:'local.fixture',name:'Fixture',system:false,version:'2.0',path:'/private/var/containers/Bundle/Application/fixture.app',developer:true}]}));
 else if(req.op==='launch_app'){if(state.launchNotSent){console.log(JSON.stringify({isError:true,outcome:'not_sent',launched:false,error:'No installed app matches the given name.'}));process.exit(0);}if(state.launchError){console.error('Launch service rejected the request');process.exit(1);}writeState(JSON.stringify({...state,launched:true}));console.log(JSON.stringify({bundle_id:req.bundle_id??'com.apple.Preferences',name:'Settings',pid:state.invalidPid?0:4242,launched:true}));}
 else if(req.op==='ax_tree'){if(state.launched&&state.axHangs){writeState(JSON.stringify({...state,axHangs:state.axHangs-1}));await new Promise(()=>setInterval(()=>{},10000));}if(state.axUnavailable){console.error('Foreground observation unavailable');process.exit(1);}if(state.axDelayMs)await new Promise(done=>setTimeout(done,state.axDelayMs));if(state.axDelays?.length){writeState(JSON.stringify({...state,axDelays:state.axDelays.slice(1)}));await new Promise(done=>setTimeout(done,state.axDelays[0]));}if(state.axEmpty){console.log(JSON.stringify({elements:[]}));process.exit(0);}const stale=state.staleReads>0;if(stale){state.staleReads-=1;writeState(JSON.stringify(state));}if(state.moving){state.moving+=1;writeState(JSON.stringify(state));}if(state.appearsAfterReads)writeState(JSON.stringify({...state,appearsAfterReads:state.appearsAfterReads-1}));readList(state,text=>writeState(text));console.log(JSON.stringify({...(state.launched?{foreground_app:{pid:state.foregroundPid??4242}}:{}),elements:state.elements??[...(state.phone?state.phone.rows.map(r=>({role:'TextField',object_id:r.id,...(r.placeholder?{placeholder:r.placeholder}:{}),value:r.value||r.placeholder||'',traits:r.editing?editingBit:0,focused:Boolean(r.editing),frame:{x:10,y:phoneTop(state,r),width:40,height:20}})):[]),...(state.appRoot?[{label:state.appRoot,role:'Application',frame:{x:0,y:0,width:100,height:200}}]:[]),{label:stale?state.staleLabel:state.appearsAfterReads?'Loading':state.label??'First',role:state.role??'Button',selected:Boolean(state.selected),frame:{x:10,y:10+(state.moving??0)%9*10,width:40,height:20}},...(state.field===undefined?[]:[{role:'TextField',value:state.field,placeholder:'Name',focused:state.focused,frame:{x:10,y:(listSlid(state)?140:40)+(state.moving??0)%9*10,width:40,height:20}}]),...(state.otherField===undefined?[]:[{role:'TextField',value:state.otherField,placeholder:'Other',focused:!state.focused,frame:{x:10,y:70,width:40,height:20}}]),...(state.list?.editing?[{role:'TextField',value:state.list.row,placeholder:'Name',focused:true,frame:{x:10,y:40,width:40,height:20}}]:listSlid(state)?[{label:state.list.row,role:'StaticText',frame:{x:10,y:40,width:40,height:20}}]:[])]}));}
 else {
  if(state.inputStopsRecording){const events=readFileSync(process.env.FIXTURE_LOG,'utf8').trim().split('\\n').map(JSON.parse);const receiver=events.filter(e=>e.args?.includes('screencapture')).at(-1);if(receiver){try{process.kill(receiver.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}}}
  if(state.inputError)process.exit(1);
  if(state.afterInput){Object.assign(state,state.afterInput,{afterInput:undefined});writeState(JSON.stringify(state));}
  if(state.phone&&req.op==='tap'){phoneTap(state,req.y);writeState(JSON.stringify(state));}
  else if(req.op==='tap'&&state.field!==undefined){state.focused=true;writeState(JSON.stringify(state));}
  if(state.phone&&req.op==='type_text'&&!state.typeReply){
   // Registering the hardware keyboard drops the soft keyboard, and the fields move before anything else in this request.
   state.phone.keyboard=false;
   if('x' in req)phoneTap(state,req.y);
   const editing=state.phone.rows.filter(r=>r.editing),into=editing[0];
   const wrong=req.target&&(editing.length!==1||into.id!==req.target.object_id||(into.value||into.placeholder||'')!==req.target.value);
   state.phone.keyboard=true;
   if(wrong){writeState(JSON.stringify(state));console.log(JSON.stringify({isError:true,outcome:'not_sent',stop_reason:'error',reason:'other_field_editing',sent:false,text_verified:false,submit_sent:false,instruction:'Nothing was typed.'}));process.exit(0);}
   if(into)into.value=req.clear?req.text:into.value+req.text;
   if(req.submit)state.phone.returns=(state.phone.returns??0)+1;
   writeState(JSON.stringify(state));
   console.log(JSON.stringify({sent:true,text_verified:Boolean(into),submit_sent:Boolean(req.submit)}));process.exit(0);
  }
  console.log(JSON.stringify(req.op==='type_text'&&state.typeReply?state.typeReply:{sent:true,text_verified:true,submit_sent:true}));
 }
} else if(tool==='ffmpeg') {writeFileSync(args.at(-1),'movie');process.stdin.on('data',()=>log({encoded:true}));process.stdin.on('end',()=>process.exit());}
else if(tool==='ffprobe') console.log(JSON.stringify({streams:[{codec_name:'h264'}],format:{duration:'1'}}));
else if(tool==='osascript') {log({dialog:true});setInterval(()=>{},10000);}
else throw Error('Unexpected fixture command '+tool);
`;
export const value = result => JSON.parse(result.content.find(c => c.type === 'text').text);
export async function fixture(t, { approvalMode = 'ask', staleNative = false, toolsProfile = '', beforeStart } = {}) {
 const dir=await mkdtemp(join(tmpdir(),'poki-coordination-'));
 await cp(join(root,'src'),join(dir,'src'),{recursive:true});
 await cp(join(root,'package.json'),join(dir,'package.json'));
 await symlink(join(root,'node_modules'),join(dir,'node_modules'));
 await mkdir(join(dir,'build'));await mkdir(join(dir,'bin'));await mkdir(join(dir,'native'));
 const image=join(dir,'image.png');await sharp({create:{width:100,height:200,channels:3,background:'white'}}).png().toFile(image);
 const state=join(dir,'fixture.json'),log=join(dir,'commands.jsonl');await writeFile(state,'{}');await writeFile(log,'');
 for(const tool of ['python3','xcrun','idevice','ffmpeg','ffprobe','osascript'])await writeFile(join(dir,'bin',tool),fixtureProgram,{mode:0o755});
 for(const tool of ['poki-native','ocr','simulator'])await writeFile(join(dir,'build',tool),fixtureProgram,{mode:0o755});
 if(staleNative){await mkdir(join(dir,'native/bridge/src'),{recursive:true});await writeFile(join(dir,'native/bridge/src/main.rs'),'fn main() {}');await utimes(join(dir,'build/poki-native'),1,1);}
 const env={...process.env,POKI_MCP_TOOLS:toolsProfile,POKI_MCP_APPROVAL_MODE:approvalMode,HOME:dir,PATH:join(dir,'bin')+':'+process.env.PATH,POKI_MCP_STATE_DIR:join(dir,'state'),IDEVICE_TOOLS:join(dir,'bin/idevice'),FIXTURE_STATE:state,FIXTURE_LOG:log,FIXTURE_IMAGE:image};
 let stderr='';
 const daemons=[];
 const startDaemon=async(port=0)=>{const child=spawn(process.execPath,[join(dir,'src/daemon.mjs'),'--port',String(port)],{env,stdio:['ignore','pipe',staleNative?'pipe':'inherit']});child.stderr?.on('data',chunk=>{stderr+=chunk;});const exited=once(child,'exit'),lines=createInterface({input:child.stdout});await once(lines,'line');const running={stop:async(signal='SIGTERM')=>{child.kill(signal);await exited;lines.close();}};daemons.push(running);return running;};
 await beforeStart?.(dir);
 const daemon=await startDaemon();
 const clients=[];
 t.after(async()=>{await Promise.allSettled(clients.map(c=>c.close()));await Promise.all(daemons.map(d=>d.stop()));await rm(dir,{recursive:true,force:true});});
 const connect=async(profile=toolsProfile)=>{const c=new Client({name:'fixture-client',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[join(dir,'src/stdio.mjs')],env:{...env,POKI_MCP_TOOLS:profile}}));clients.push(c);return c;};
 const a=await connect();
 const until=async predicate=>{ const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);try {const changes=watch(dir,{signal:controller.signal});if(predicate(await readFile(log,'utf8')))return;for await(const event of changes)if(event.filename==='commands.jsonl'&&predicate(await readFile(log,'utf8')))return;}finally{clearTimeout(timer);controller.abort();}};
 return {a,connect,dir,env,until,image,daemon,startDaemon,get stderr(){return stderr;},set:async data=>{await writeFile(state+'.set.tmp',JSON.stringify(data));await rename(state+'.set.tmp',state);},events:async()=> (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),call:(name,args={})=>a.callTool({name,arguments:args})};
}
