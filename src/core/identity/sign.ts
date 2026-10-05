import { setConfig, unsetConfig } from '../git/config.js';
import { topLevel, insideWorkTree } from '../git/rev.js';
import { readState, writeState } from '../repo/state.js';
import { getIdentity } from './map.js';
import { keyUsable } from './keys.js';
import { keyInAgent } from './agent.js';
import { appendAudit } from '../logging/audit.js';
import { Errors } from '../errors.js';
import { dataDir } from '../paths.js';
import { ensureAskpassWrapper } from './apply.js';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Source } from '../types.js';

async function safeTopLevel(cwd?: string): Promise<string | undefined> {
  try {
    return await topLevel(cwd);
  } catch {
    return undefined;
  }
}

/**
 * Create the signing wrapper: a shell script that execs `ssh-keygen` with
 * SSH_ASKPASS pointing at our askpass helper. git invokes `gpg.ssh.program`
 * for every commit-signing operation, so the passphrase is fetched from the
 * extension's session store without prompting the user each time.
 *
 * The wrapper also extracts `-f <signingKey>` from its own argv and exports
 * it as GIT_COLABOR_SIGNING_KEY: some OpenSSH builds (notably Ubuntu's
 * ssh-keygen signing path) invoke the askpass with a BARE "Enter passphrase:"
 * prompt — no key path — so the helper cannot fingerprint the key from the
 * prompt and needs this side channel instead.
 */
export async function ensureSignWrapper(askpassScriptPath?: string): Promise<string> {
  const wrapperPath = join(dataDir(), 'sign-wrapper.sh');
  const askpass = askpassScriptPath ? await ensureAskpassWrapper(askpassScriptPath) : join(dataDir(), 'askpass-wrapper.sh');
  const content = [
    '#!/bin/sh',
    '# extract -f <key> so the askpass helper can fingerprint it even when',
    '# the prompt carries no key path (bare "Enter passphrase:" on some OpenSSH)',
    'signkey=',
    'prev=',
    'for a in "$@"; do',
    '  if [ "$prev" = "-f" ]; then signkey="$a"; break; fi',
    '  prev="$a"',
    'done',
    `SSH_ASKPASS="${askpass}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 GIT_COLABOR_SIGNING_KEY="$signkey" exec ssh-keygen "$@"`,
    '',
  ].join('\n');
  if (existsSync(wrapperPath)) {
    const existing = await readFile(wrapperPath, 'utf8');
    if (existing === content) return wrapperPath;
  }
  await writeFile(wrapperPath, content, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);
  return wrapperPath;
}

/**
 * The `user.signingKey` value for an identity's key. `ssh-keygen -Y sign`
 * with a PRIVATE key path loads the file (askpass prompt for encrypted keys —
 * it never consults ssh-agent); with a PUBLIC key path it looks the key up in
 * ssh-agent instead. So when the key is agent-held and the `.pub` sibling
 * exists, sign via the public half — no passphrase involved.
 */
async function signingKeyPath(sshKeyPath: string, fingerprint?: string): Promise<string> {
  if (fingerprint && (await keyInAgent(fingerprint))) {
    const pub = `${sshKeyPath}.pub`;
    if (existsSync(pub)) return pub;
  }
  return sshKeyPath;
}

/**
 * Toggle SSH commit signing for a repo (the right-click "Sign commits with
 * this key" / "Stop signing" action). Opt-in: `identity use` never turns
 * signing on by itself; when signing is enabled it re-binds to the applied
 * identity's usable key. When driven by the extension (askpassScriptPath
 * known) `gpg.ssh.program` is set to a wrapper so commit signing gets its
 * passphrase from the session store without prompting every commit.
 */
export async function setCommitSigning(opts: {
  source: Source;
  cwd?: string;
  id: string;
  on: boolean;
  askpassScriptPath?: string;
}): Promise<{ signing: boolean; key?: string }> {
  if (!(await insideWorkTree(opts.cwd))) throw Errors.notARepo(opts.cwd);
  const state = await readState(opts.cwd);

  if (!opts.on) {
    state.signing = false;
    await writeState(state, opts.cwd);
    await unsetConfig('commit.gpgsign', 'local', opts.cwd);
    await unsetConfig('gpg.format', 'local', opts.cwd);
    await unsetConfig('user.signingKey', 'local', opts.cwd);
    await unsetConfig('gpg.ssh.program', 'local', opts.cwd);
    await appendAudit({ action: 'identity.sign', source: opts.source, identity: opts.id, repo: await safeTopLevel(opts.cwd), result: 'ok', message: 'signing off' });
    return { signing: false };
  }

  const identity = await getIdentity(opts.id);
  if (!identity.sshKeyPath || !(await keyUsable(identity.sshKeyPath))) {
    throw Errors.usage(`identity "${identity.name}" has no usable key to sign with`);
  }
  state.signing = true;
  await writeState(state, opts.cwd);
  await setConfig('commit.gpgsign', 'true', 'local', opts.cwd);
  await setConfig('gpg.format', 'ssh', 'local', opts.cwd);
  await setConfig('user.signingKey', await signingKeyPath(identity.sshKeyPath, identity.sshKeyFingerprint), 'local', opts.cwd);
  if (opts.askpassScriptPath) {
    const signWrapper = await ensureSignWrapper(opts.askpassScriptPath);
    await setConfig('gpg.ssh.program', signWrapper, 'local', opts.cwd);
  }
  await appendAudit({
    action: 'identity.sign',
    source: opts.source,
    identity: opts.id,
    identityName: identity.name,
    fingerprint: identity.sshKeyFingerprint,
    repo: await safeTopLevel(opts.cwd),
    result: 'ok',
    message: 'signing on',
  });
  return { signing: true, key: identity.sshKeyPath };
}
