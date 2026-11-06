import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { LiveFeed } from '../src/live-frames.mjs';
import { World } from '../src/world.mjs';

// A stand-in for poki-bridged's socket: it records the subscribe line and lets the test send events.
async function fakeDaemon(t) {
  const dir = await mkdtemp(join(tmpdir(), 'feed-'));
  const path = join(dir, 'd.sock'), sockets = [], lines = [];
  const server = createServer(socket => {
    sockets.push(socket);
    socket.setEncoding('utf8');
    socket.on('data', chunk => { for (const line of chunk.split('\n').filter(Boolean)) { lines.push(JSON.parse(line)); socket.write(`${JSON.stringify({ id: 'feed', ok: true, event: 'subscribed', settle_ms: 150 })}\n`); } });
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(async () => { for (const s of sockets) s.destroy(); server.close(); await rm(dir, { recursive: true, force: true }); });
  let seq = 0;
  return { path, lines, sockets, send: event => sockets.at(-1).write(`${JSON.stringify({ seq: ++seq, at: new Date().toISOString(), ...event })}\n`), skip: () => { seq++; } };
}
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('the feed knows the screen only from a settled event on, and forgets it on a gap or a new session', { timeout: 10000 }, async t => {
  const daemon = await fakeDaemon(t);
  const feed = new LiveFeed(daemon.path, { backoffMs: [20] });
  t.after(() => feed.close());
  feed.start();
  await until(() => feed.connected);
  assert.deepEqual(daemon.lines[0], { id: 'feed', op: 'subscribe_frames' });
  assert.equal(feed.known, false);
  daemon.send({ event: 'settled', epoch: 7, generation: 1, captured_at: new Date().toISOString(), quiet_ms: 150 });
  await until(() => feed.known);
  assert.equal(feed.stillOn(7), true);
  daemon.send({ event: 'input', epoch: 7, generation: 1, sent_at: new Date().toISOString() });
  await until(() => feed.moving);
  assert.equal(feed.stillOn(7), false, 'an input on the settled picture means it may not show the screen any more');
  daemon.send({ event: 'changed', epoch: 8, generation: 1 });
  daemon.send({ event: 'settled', epoch: 9, generation: 1 });
  await until(() => feed.stillOn(9));
  // A skipped line: the state is unknown until the next settled.
  daemon.skip();
  daemon.send({ event: 'changed', epoch: 10, generation: 1 });
  await until(() => !feed.known);
  daemon.send({ event: 'settled', epoch: 10, generation: 1 });
  await until(() => feed.stillOn(10));
  daemon.send({ event: 'media', state: 'open', generation: 2 });
  await until(() => feed.seq === 8);
  assert.equal(feed.known, false, 'a new media session is not the screen the old one showed');
  daemon.send({ event: 'settled', epoch: 11, generation: 2 });
  await until(() => feed.stillOn(11));
});

test('a dropped feed reconnects by itself and stays unknown until it settles again', { timeout: 10000 }, async t => {
  const daemon = await fakeDaemon(t);
  const feed = new LiveFeed(daemon.path, { backoffMs: [20] });
  t.after(() => feed.close());
  feed.start();
  await until(() => feed.connected);
  daemon.send({ event: 'settled', epoch: 4 });
  await until(() => feed.known);
  daemon.sockets.at(-1).destroy();
  await until(() => !feed.connected);
  assert.equal(feed.known, false);
  await until(() => feed.connected && daemon.lines.length === 2);
  assert.equal(feed.known, false);
});

test('observe answers from the last frame while the feed says the screen has not moved', { timeout: 10000 }, async () => {
  let asked = 0;
  const feed = new LiveFeed('/nonexistent');
  let picture = { jpeg: await (await import('sharp')).default({ create: { width: 10, height: 20, channels: 3, background: 'white' } }).jpeg().toBuffer(), capturedAt: new Date().toISOString(), settled: true, epoch: 12 };
  const screen = { liveFeed: feed, latestFrame: async () => { asked++; return picture; }, waitSettled: async () => picture, op: async () => ({}) };
  const world = new World({ size: { width: 10, height: 20 } }, screen);
  const first = await world.current();
  assert.equal(asked, 1);
  feed.handle({ event: 'settled', epoch: 12 });
  assert.equal(await world.current(), first);
  assert.equal(asked, 1, 'no request while the feed vouches for the frame');
  feed.handle({ event: 'changed', epoch: 13 });
  picture = { ...picture, epoch: 13 };
  await world.current();
  assert.equal(asked, 2);
  feed.handle({ event: 'settled', epoch: 13 });
  assert.equal((await world.current()).bridgeEpoch, 13);
  assert.equal(asked, 2);
  world.noteInput('tap');
  await world.current();
  assert.equal(asked, 3, 'an input of ours makes the frame old, whatever the feed has seen');
});
