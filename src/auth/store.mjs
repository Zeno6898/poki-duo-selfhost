// A small JSON file for registered clients and refresh-token grants, written atomically with mode 0600.
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export class JsonStore {
  data = { clients: {}, grants: {} }; writing = Promise.resolve();
  constructor(file) { this.file = file; }
  async load() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try { this.data = { clients: {}, grants: {}, ...JSON.parse(await readFile(this.file, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read ${this.file}: ${error.message}`); }
    return this;
  }
  save() {
    const text = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    });
    return this.writing;
  }
}
