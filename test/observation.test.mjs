import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { Devices } from '../src/device.mjs';
import { join } from 'node:path';
import { fixture, value } from './fixture.mjs';

// A phone over a network tunnel takes seconds per accessibility read; the fixture's delay stands in for it.
test('a tap on a phone with slow accessibility reads still ends with the screen', { timeout: 30000 }, async t => {
 const f=await fixture(t);await f.set({axDelayMs:2200});
 const result=await f.call('tap',{x:10,y:10});
 assert.notEqual(result.isError,true,result.content[0].text);
 const receipt=value(result);
 assert.equal(receipt.screen.unavailable,undefined,JSON.stringify(receipt));
 assert.ok(receipt.screen.text.includes('Button: First'),JSON.stringify(receipt));
});

test('a readback cut off by its deadline reports the last complete read instead of nothing', { timeout: 30000 }, async t => {
 const f=await fixture(t);await f.set({afterInput:{axDelays:[300,20000]}});
 const result=await f.call('tap',{x:10,y:10});
 assert.notEqual(result.isError,true,result.content[0].text);
 const receipt=value(result);
 assert.equal(receipt.screen.partial,true,JSON.stringify(receipt));
 assert.ok(receipt.screen.text.includes('Button: First'));
 assert.match(receipt.screen.reason,/deadline/);
});

test('screen_change says changed, unchanged, or unknown, and only unchanged carries the no-change advice', { timeout: 60000 }, async t => {
 const f=await fixture(t);await f.set({label:'Row 1',afterInput:{label:'Row 9',axDelays:[300,20000]}});
 // The readback is cut off, but its one complete read already differs from the screen before the scroll.
 const moved=value(await f.call('scroll',{direction:'down'}));
 assert.equal(moved.screen.partial,true);assert.equal(moved.screen_change,'changed');assert.equal(moved.screen_changed,true);
 await f.set({label:'Same',afterInput:{axDelays:[300,20000]}});
 const unknown=value(await f.call('tap',{x:10,y:10}));
 assert.equal(unknown.screen_change,'unknown');assert.equal(unknown.screen_changed,undefined);assert.equal(unknown.instruction,undefined);
 await f.set({label:'Same'});
 const still=value(await f.call('tap',{x:10,y:10}));
 assert.equal(still.screen_change,'unchanged');assert.match(still.instruction,/no change was observed/);
});

// The field report's Photos selection: six coordinate taps in one batch took about 61 s.
test('six coordinate taps in one batch read the screen once at the end, not around every tap', { timeout: 90000 }, async t => {
 const f=await fixture(t);await f.set({axDelayMs:2200});
 const started=performance.now();
 const result=await f.call('batch_commands',{commands:Array.from({length:6},(_,i)=>({tool:'tap',arguments:{x:10+i*10,y:100}}))});
 const elapsed=performance.now()-started;
 assert.notEqual(result.isError,true,JSON.stringify(result.content));
 const events=await f.events();
 assert.equal(events.filter(e=>e.op==='tap').length,6);
 assert.equal(events.filter(e=>e.args?.includes('screenshot')).length,1);
 // The last tap is compared with the screen before it, and the batch's own readback reuses that read.
 assert.ok(events.filter(e=>e.op==='ax_tree').length<=5,String(events.filter(e=>e.op==='ax_tree').length));
const summary=JSON.parse(result.content.at(-1).text);
 assert.ok(summary.screen.text.includes('Button: First'));
 assert.ok(elapsed<20000,`batch took ${Math.round(elapsed)} ms`);
});

test('a gated tool says who approved it, and the status names the tools approval covers', { timeout: 30000 }, async t => {
 const f=await fixture(t,{approvalMode:'allow'});await f.set({simulatorOnly:true,simulatorBooted:true});
 const status=value(await f.call('poki_mcp_status'));
 assert.equal(status.approval_mode,'operator-preapproved');
 assert.ok(status.approval_covers.includes('open_url')&&!status.approval_covers.includes('tap'));
 const opened=await f.call('open_url',{url:'https://example.com'});
 assert.notEqual(opened.isError,true,JSON.stringify(opened));
 assert.deepEqual(value(opened).approval,{mode:'operator-preapproved',approved_by:'operator'});
 assert.equal(value(await f.call('tap',{x:10,y:10})).approval,undefined);
});

test('a server without the OCR helper says so in status and in a failed text fallback', { timeout: 30000 }, async t => {
 const f=await fixture(t,{beforeStart:dir=>rm(join(dir,'build/ocr'))});
 const status=value(await f.call('poki_mcp_status'));
 assert.equal(status.ocr.available,false);assert.match(status.ocr.path,/build\/ocr$/);
 await f.set({axEmpty:true});
 const listed=await f.call('list_elements');
 assert.equal(listed.isError,true);
 assert.match(listed.content[0].text,/Accessibility returned nothing.*Text recognition is not installed.*bin\/build-ocr-linux/s);
 assert.doesNotMatch(listed.content[0].text,/ENOENT/);
});

test('launch_app on a phone ends with the screen, says when the app resumed, and fresh relaunches it', { timeout: 60000 }, async t => {
 const f=await fixture(t);
 const first=value(await f.call('launch_app',{bundle_id:'local.fixture'}));
 assert.equal(first.foreground_verified,true);assert.equal(first.resumed,false);
 assert.ok(first.screen.text.includes('Button: First'),JSON.stringify(first));
 const again=value(await f.call('launch_app',{bundle_id:'local.fixture'}));
 assert.equal(again.resumed,true);assert.match(again.notice,/fresh=true/);
 const fresh=value(await f.call('launch_app',{bundle_id:'local.fixture',fresh:true}));
 assert.equal(fresh.resumed,false);
 assert.equal((await f.events()).filter(e=>e.op==='launch_app').at(-1).request.terminate_existing,true);
});

test('a screenshot says it was not saved to the device Photos library', { timeout: 30000 }, async t => {
 const f=await fixture(t);
 const shot=await f.call('take_screenshot');
 assert.ok(shot.content.some(c=>c.type==='text'&&/not saved to the device's Photos library/.test(c.text)));
});

// On the phone an app opening from the Home Screen kept reporting the Home Screen's tree for two reads.
test('a screen that only lags behind the touch is not called unchanged', { timeout: 60000 }, async t => {
 const f=await fixture(t);
 await f.set({label:'Settings',afterInput:{label:'General',staleReads:2,staleLabel:'Settings'}});
 const lagging=value(await f.call('tap_text',{text:'Settings'}));
 assert.equal(lagging.screen_change,'changed',JSON.stringify(lagging));assert.equal(lagging.instruction,undefined);
 assert.ok(lagging.screen.text.includes('Button: General'));
 // An app icon is given longer to bring its app to the front.
 await f.set({label:'Settings',role:'Icon',afterInput:{label:'General',staleReads:5,staleLabel:'Settings'}});
 assert.equal(value(await f.call('tap_text',{text:'Settings'})).screen_change,'changed');
 // Anything else gets one more look, not a long wait.
 await f.set({label:'Settings',afterInput:{label:'General',staleReads:5,staleLabel:'Settings'}});
 assert.equal(value(await f.call('tap_text',{text:'Settings'})).screen_change,'unchanged');
});

test('a different app in front counts as a change even when its tree has not arrived', { timeout: 30000 }, async t => {
 const f=await fixture(t);await f.set({launched:true,afterInput:{foregroundPid:999}});
 const receipt=value(await f.call('tap',{x:10,y:10}));
 assert.equal(receipt.screen_change,'changed',JSON.stringify(receipt));
});

test('a screen says when its read began and how old it is', { timeout: 30000 }, async t => {
 const f=await fixture(t);
 const receipt=value(await f.call('tap',{x:10,y:10}));
 assert.ok(!Number.isNaN(Date.parse(receipt.screen.observed_at)),JSON.stringify(receipt.screen));
 assert.ok(receipt.screen.tree_age_ms>=0);
});

test('launch_app gives the app a moment to come to the front and says how long it took', { timeout: 30000 }, async t => {
 const f=await fixture(t);await f.set({foregroundLagReads:6});
 const result=await f.call('launch_app',{bundle_id:'local.fixture'});
 assert.notEqual(result.isError,true,result.content[0].text);
 const launched=value(result);
 assert.equal(launched.foreground_verified,true);assert.ok(launched.foreground_after_ms>0);
});

test('the Home Screen is named com.apple.springboard, and later reads of it say so too', async () => {
 const devices=new Devices(),id='fixture-phone';
 devices.target=async()=>({id,kind:'physical',name:'Phone'});devices.size={device:id,width:100,height:200};
 devices.bridge=async request=>request.op==='ax'?{foreground:{object_id:'o1',name:' ',bundle_id:null,pid:34},elements:[{label:'Phone',role:'Icon',frame:{x:10,y:10,width:40,height:40}}]}:{pid:34,running:true,executable:'/System/Library/CoreServices/SpringBoard.app/SpringBoard',bundle_id:null,name:null};
 const front=JSON.parse((await devices.dispatch('get_foreground_app',{})).content[0].text);
 assert.equal(front.bundle_id,'com.apple.springboard');assert.equal(front.bundle_id_source,'executable');
 assert.equal((await devices.structure()).foreground.bundle_id,'com.apple.springboard');
});

test('the status shows the commit recorded at build time when git is not there', { timeout: 30000 }, async t => {
 const f=await fixture(t,{beforeStart:dir=>writeFile(join(dir,'build/commit'),'abc1234\n')});
 assert.equal(value(await f.call('poki_mcp_status')).commit,'abc1234');
});
