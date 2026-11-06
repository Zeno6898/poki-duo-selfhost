#!/usr/bin/env node
// Manages the one account allowed to sign in to the built-in OAuth server (POKI_OAUTH=builtin).
//
//   node bin/poki-oauth-account.mjs create [username]   set the password and enrol a TOTP app
//   node bin/poki-oauth-account.mjs password            change the password, keep the TOTP secret
//   node bin/poki-oauth-account.mjs list                list registered clients and live grants
//   node bin/poki-oauth-account.mjs revoke [client_id]  end every grant (or one client's) now
//
// Files live under $POKI_MCP_STATE_DIR/oauth (POKI_OAUTH_ACCOUNT_FILE overrides the account file).
// Run it in your own terminal: it prints the TOTP enrolment URI, which is a secret.
import { mkdir, writeFile, rename, chmod, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { stateDir } from '../src/config.mjs';
import { hashPassword } from '../src/auth/password.mjs';
import { generateSecret, otpauthUri, verifyTotp } from '../src/auth/totp.mjs';
import { JsonStore } from '../src/auth/store.mjs';

const accountFile = process.env.POKI_OAUTH_ACCOUNT_FILE || join(stateDir, 'oauth/account.json');
const storeFile = join(stateDir, 'oauth/store.json');
const [command, argument] = process.argv.slice(2);

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(text); };
    rl.question(question, answer => { rl.close(); if (hidden && process.stdin.isTTY) process.stdout.write('\n'); resolve(answer); });
  });
}

async function save(account) {
  await mkdir(dirname(accountFile), { recursive: true, mode: 0o700 });
  const temporary = `${accountFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(account, null, 2), { mode: 0o600 });
  await rename(temporary, accountFile);
  await chmod(accountFile, 0o600);
}

async function newPassword() {
  const password = await ask('New password (12+ characters): ', { hidden: true });
  if ((await ask('Repeat password: ', { hidden: true })) !== password) throw new Error('The passwords differ.');
  return hashPassword(password);
}

const restart = 'Restart the daemon to load the change.';

if (command === 'create') {
  const username = argument || await ask('Account name: ');
  if (!/^[\w.@+-]{1,64}$/.test(username)) throw new Error('Use letters, digits and . @ + - _ for the account name.');
  const password_hash = await newPassword();
  const totp_secret = generateSecret();
  console.log('\nAdd this to your authenticator app (it is a secret; do not paste it into chat):\n');
  console.log(`  ${otpauthUri(totp_secret, username)}\n`);
  console.log(`Or enter the key by hand: ${totp_secret}\n`);
  const code = await ask('Enter the 6-digit code the app shows now: ');
  if (verifyTotp(totp_secret, code) === undefined) throw new Error('That code does not match; run create again.');
  await save({ username, password_hash, totp_secret, created_at: new Date().toISOString() });
  console.log(`Saved ${accountFile}. ${restart}`);
} else if (command === 'password') {
  const account = JSON.parse(await readFile(accountFile, 'utf8'));
  await save({ ...account, password_hash: await newPassword() });
  console.log(`Password changed. ${restart}`);
} else if (command === 'list') {
  const store = await new JsonStore(storeFile).load();
  for (const client of Object.values(store.data.clients)) {
    const grants = Object.values(store.data.grants).filter(g => g.client_id === client.client_id);
    console.log(`${client.client_id}  ${client.client_name}  ${client.redirect_uris.map(u => new URL(u).host).join(',')}  grants: ${grants.length}`);
  }
} else if (command === 'revoke') {
  const store = await new JsonStore(storeFile).load();
  let count = 0;
  for (const [id, grant] of Object.entries(store.data.grants)) if (!argument || grant.client_id === argument) { delete store.data.grants[id]; count++; }
  if (argument) delete store.data.clients[argument];
  await store.save();
  console.log(`Revoked ${count} grant(s). ${restart} Access tokens stop working once it reloads.`);
} else {
  console.log('Usage: node bin/poki-oauth-account.mjs create [username] | password | list | revoke [client_id]');
  process.exitCode = command ? 1 : 0;
}
