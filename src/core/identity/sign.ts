import { setConfig, unsetConfig } from '../git/config.js';
import { topLevel } from '../git/rev.js';
import { insideWorkTree } from '../git/rev.js';
import { readState, writeState } from '../repo/state.js';
import { getIdentity } from './map.js';
import { keyUsable } from './keys.js';
import { appendAudit } from '../logging/audit.js';
import { Errors } from '../errors.js';
import type { Source } from '../types.js';

async function safeTopLevel(cwd?: string): Promise<string | undefined> {
  try {
    return await topLevel(cwd);
  } catch {
    return undefined;
  }
}

/**
 * Toggle SSH commit signing for a repo (the right-click "Sign commits with
 * this key" / "Stop signing" action). Opt-in: `identity use` never turns
 * signing on by itself; when signing is enabled it re-binds to the applied
 * identity's usable key.
 */
export async function setCommitSigning(opts: {
  source: Source;
  cwd?: string;
  id: string;
  on: boolean;
}): Promise<{ signing: boolean; key?: string }> {
  if (!(await insideWorkTree(opts.cwd))) throw Errors.notARepo(opts.cwd);
  const state = await readState(opts.cwd);

  if (!opts.on) {
    state.signing = false;
    await writeState(state, opts.cwd);
    await unsetConfig('commit.gpgsign', 'local', opts.cwd);
    await unsetConfig('gpg.format', 'local', opts.cwd);
    await unsetConfig('user.signingKey', 'local', opts.cwd);
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
  await setConfig('user.signingKey', identity.sshKeyPath, 'local', opts.cwd);
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
