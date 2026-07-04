import { unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { topLevel } from '../git/rev.js';
import { readState, writeState } from '../repo/state.js';
import { getIdentity, listIdentities } from './map.js';
import { removeKey } from './agent.js';
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

async function shred(path: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    const r = spawnSync('shred', ['-u', path]);
    if (r.status === 0) return true;
  }
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Logout an identity's key: remove from ssh-agent, shred the keyfile, clear activeIdentity/heldBy
 * if it was active. Does NOT remove the identity from the map (use `rm`) nor touch user.* (use `revert`).
 * Note: the passphrase in VS Code SecretStorage can only be purged by the extension; shredding the
 * keyfile makes it useless, so this is the meaningful CLI-side cleanup.
 */
export async function logoutIdentity(opts: {
  source: Source;
  cwd?: string;
  id?: string;
}): Promise<{
  identity: { id: string; name: string; fingerprint?: string };
  agentRemoved: boolean;
  keyfileShredded: boolean;
}> {
  const state = await readState(opts.cwd);
  let id = opts.id ?? state.activeIdentity;
  if (!id) {
    const { identities } = await listIdentities();
    if (identities.length === 1) id = identities[0].id;
    else throw Errors.usage('no active identity — specify one: git colabor identity logout <id>');
  }
  const identity = await getIdentity(id);

  let agentRemoved = false;
  let keyfileShredded = false;
  if (identity.sshKeyPath) {
    agentRemoved = await removeKey(identity.sshKeyPath);
    keyfileShredded = await shred(identity.sshKeyPath);
  }

  if (state.activeIdentity === identity.id) {
    state.activeIdentity = undefined;
    state.heldBy = undefined;
    await writeState(state, opts.cwd);
  }

  await appendAudit({
    action: 'identity.logout',
    source: opts.source,
    identity: identity.id,
    identityName: identity.name,
    fingerprint: identity.sshKeyFingerprint,
    repo: await safeTopLevel(opts.cwd),
  });

  return {
    identity: { id: identity.id, name: identity.name, fingerprint: identity.sshKeyFingerprint },
    agentRemoved,
    keyfileShredded,
  };
}
