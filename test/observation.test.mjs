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
