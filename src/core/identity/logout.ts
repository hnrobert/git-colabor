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

/**
 * Logout an identity's key: remove it from ssh-agent and clear
 * activeIdentity/heldBy if it was active. Does NOT remove the identity from
 * the map (use `rm`) nor touch user.* (use `revert`).
 *
 * Keys are REFERENCED, never copied — the file on disk belongs to the user
 * and is never modified or deleted by us; deleting the key itself is the
 * user's call.
 */
export async function logoutIdentity(opts: {
  source: Source;
  cwd?: string;
  id?: string;
}): Promise<{
  identity: { id: string; name: string; fingerprint?: string };
  agentRemoved: boolean;
}> {
  const state = await readState(opts.cwd);
  let id = opts.id ?? state.activeIdentity;
  if (!id) {
    const { identities } = await listIdentities();
    if (identities.length === 1) id = identities[0].id;
    else throw Errors.usage('no active identity — specify one: git colabor identity logout <id>');
  }
  const identity = await getIdentity(id);

  const agentRemoved = identity.sshKeyPath ? await removeKey(identity.sshKeyPath) : false;

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
  };
}
