import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { World, compare, thumb } from '../src/world.mjs';

// A 100 x 200 point screen: white, with dark blocks where content is.
const screen = async (...blocks) => sharp({ create: { width: 100, height: 200, channels: 3, background: 'white' } })
  .composite(await Promise.all(blocks.map(async ([x, y, w, h]) => ({ input: await sharp({ create: { width: w, height: h, channels: 3, background: 'black' } }).png().toBuffer(), left: x, top: y }))))
  .png().toBuffer();

function fakeDevices(frames, trees) {
  let i = 0;
  return {
    size: { width: 100, height: 200 }, reads: 0,
    async capture() { const data = frames[Math.min(i++, frames.length - 1)]; return { data, width: 100, height: 200, capture_completed_at: new Date().toISOString() }; },
    async structure() { this.reads++; const next = trees.shift(); if (next instanceof Error) throw next; return typeof next === 'function' ? next() : next; },
    async settle() {}, captureCost: () => 5, bridge: async () => { throw new Error('no bridge'); }, run: async () => ({ stdout: '[]' }),
  };
}
const tree = (...labels) => ({ foreground: { pid: 7, bundle_id: 'local.ledger' }, elements: labels.map(([label, y]) => ({ label, role: 'Button', frame: { x: 10, y, width: 60, height: 20 } })) });

test('pixels decide change, and the status bar does not count', async () => {
 const a = await thumb(await screen([10, 40, 60, 20])), same = await thumb(await screen([10, 40, 60, 20]));
 const moved = await thumb(await screen([10, 120, 60, 20])), clock = await thumb(await screen([10, 40, 60, 20], [40, 2, 20, 8]));
 assert.equal(compare(a, same).changed, false);
 assert.equal(compare(a, clock).changed, false);
 const change = compare(a, moved);
 assert.equal(change.changed, true);
 assert.ok(change.region[1] < 0.25 && change.region[1] + change.region[3] > 0.65, JSON.stringify(change.region));
});

test('a settled frame is two captures that look alike, and a tree is current only for the epoch it was read in', async () => {
 const one = await screen([10, 40, 60, 20]), two = await screen([10, 120, 60, 20]);
 const devices = fakeDevices([one, two, two], [tree(['Open', 40]), tree(['Moved', 120])]);
 const world = new World(devices);
 const first = await world.current(), view = await world.read(first);
 assert.equal(view.tree, 'current'); assert.deepEqual(view.lines, ['Button: Open']);
 // Same picture again: the tree is reused, not read again.
 assert.equal((await world.read({ ...first })).tree, 'current'); assert.equal(devices.reads, 1);
 world.noteInput('tap');
 const settled = await world.settle(2000);
 assert.equal(settled.settled, true); assert.ok(settled.epoch > first.epoch);
 assert.deepEqual((await world.read(settled)).lines, ['Button: Moved']); assert.equal(devices.reads, 2);
});

test('a tree whose read overlaps a later change is dropped, and only the changed region loses its elements', async () => {
 const before = await screen([10, 40, 60, 20], [10, 150, 60, 20]), after = await screen([10, 40, 60, 20], [30, 150, 60, 20]);
 let world;
 const devices = fakeDevices([before, after], [tree(['Header', 40], ['Row', 150]), () => { world.noteInput('tap'); return tree(['Header', 40], ['Row moved', 150]); }]);
 world = new World(devices);
 await world.read(await world.current());
 const frame = await world.current(), view = await world.read(frame);
 assert.notEqual(view.tree, 'current');
 // The header's pixels did not move, so it keeps its place; the row's did, so it is not offered.
 assert.deepEqual(view.lines, ['Button: Header']); assert.equal(view.source, 'accessibility+region_ocr');
});
