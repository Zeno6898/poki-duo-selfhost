import { lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';
import { execute } from './work.mjs';

// .ipa archives without Apple's ditto. macOS keeps calling ditto with the same arguments as
// before; other hosts use this ZIP reader and writer, which keeps file modes and symbolic
// links (app bundles carry both) and refuses entries that would land outside the destination.
const useDitto = platform => platform === 'darwin';
const limit = 0xffffffff;
const S_IFLNK = 0o120000, S_IFDIR = 0o040000, S_IFREG = 0o100000;

async function collect(directory, prefix, entries) {
  const info = await lstat(directory);
  entries.push({ name: `${prefix}/`, mode: S_IFDIR | (info.mode & 0o7777), data: Buffer.alloc(0) });
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), item = await lstat(path), entry = `${prefix}/${name}`;
    if (item.isDirectory()) await collect(path, entry, entries);
    else if (item.isSymbolicLink()) entries.push({ name: entry, mode: S_IFLNK | 0o755, data: Buffer.from(await readlink(path)) });
    else if (item.isFile()) entries.push({ name: entry, mode: S_IFREG | (item.mode & 0o7777), data: await readFile(path) });
    else throw new Error(`Cannot archive ${path}: only files, directories and symbolic links are supported.`);
  }
}

// Writes `directory` into a new ZIP at `archive`, with the directory's own name as the top
// entry, as `ditto -c -k --keepParent <directory> <archive>` does.
export async function zipDirectory(directory, archive, { platform = process.platform } = {}) {
  if (useDitto(platform)) { await execute('ditto', ['-c', '-k', '--keepParent', directory, archive]); return; }
  const entries = [];
  await collect(directory, basename(directory), entries);
  const locals = [], centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflate = (entry.mode & 0o170000) === S_IFREG && entry.data.length > 0;
    const body = deflate ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    if (body.length >= limit || entry.data.length >= limit || offset >= limit || entries.length >= 0xffff) throw new Error('The app is too large for a ZIP32 archive.');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(0x00210000, 10);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode << 16) | ((entry.mode & S_IFDIR) === S_IFDIR ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directoryBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  await writeFile(archive, Buffer.concat([...locals, directoryBytes, end]), { flag: 'wx', mode: 0o600 });
}

function entriesOf(zip) {
  const floor = Math.max(0, zip.length - 0xffff - 22);
  let end = -1;
  for (let at = zip.length - 22; at >= floor; at -= 1) if (zip.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error('The archive is not a ZIP file.');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === limit) throw new Error('ZIP64 archives are not supported.');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('The ZIP central directory is damaged.');
    const method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16), size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const madeBy = zip.readUInt16LE(at + 4) >> 8, attributes = zip.readUInt32LE(at + 38), local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`The ZIP entry ${name} is damaged.`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    entries.push({ name, method, crc, mode: madeBy === 3 ? attributes >>> 16 : 0, body: zip.subarray(start, start + size) });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

// Extracts a ZIP into the existing directory `destination`, as `ditto -x -k <archive> <destination>` does.
export async function unzipArchive(archive, destination, { platform = process.platform } = {}) {
  if (useDitto(platform)) { await execute('ditto', ['-x', '-k', archive, destination]); return; }
  const base = await realpath(destination);
  for (const entry of entriesOf(await readFile(archive))) {
    if (entry.name.startsWith('__MACOSX/')) continue;
    const name = normalize(entry.name.replaceAll('\\', '/'));
    const path = join(base, name);
    const inside = relative(base, path);
    if (!inside || isAbsolute(name) || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error(`Refusing ZIP entry outside the destination: ${entry.name}`);
    const type = entry.mode & 0o170000;
    if (entry.name.endsWith('/') || type === S_IFDIR) { await mkdir(path, { recursive: true, mode: 0o700 }); continue; }
    // A parent that is a symbolic link from an earlier entry could point anywhere.
    const parent = await mkdir(dirname(path), { recursive: true, mode: 0o700 }).then(() => realpath(dirname(path)));
    if (parent !== base && !parent.startsWith(base + sep)) throw new Error(`Refusing ZIP entry outside the destination: ${entry.name}`);
    let data;
    if (entry.method === 0) data = Buffer.from(entry.body);
    else if (entry.method === 8) data = inflateRawSync(entry.body);
    else throw new Error(`ZIP entry ${entry.name} uses an unsupported compression method (${entry.method}).`);
    if (crc32(data) !== entry.crc) throw new Error(`ZIP entry ${entry.name} failed its checksum.`);
    if (type === S_IFLNK) await symlink(data.toString('utf8'), path);
    else await writeFile(path, data, { flag: 'wx', mode: (entry.mode & 0o777) || 0o644 });
  }
}
