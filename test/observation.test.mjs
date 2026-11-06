import test from 'node:test';
import assert from 'node:assert/strict';
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
