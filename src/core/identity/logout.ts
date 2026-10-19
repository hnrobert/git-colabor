import { topLevel } from '../git/rev.js';
import { getIdentity, getKeyBinding, listIdentities } from './map.js';
import { resolveActive } from './resolve.js';
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
 * Logout an identity's key: remove it from ssh-agent; when the identity is
 * the config-derived ACTIVE one in this repo, also clear its git-config
 * layer (user.name/email/sshCommand/signing) so the repo stops using it.
 * Does NOT remove the identity from the map (use `rm`). Key files are
 * referenced, never touched.
 */
export async function logoutIdentity(opts: {
  source: Source;
  cwd?: string;
  id?: string;
}): Promise<{
  identity: { id: string; name: string; fingerprint?: string };
  agentRemoved: boolean;
}> {
  const resolved = await resolveActive(opts.cwd);
  let id = opts.id ?? resolved?.identity.id;
  if (!id) {
    const { identities } = await listIdentities();
    if (identities.length === 1) id = identities[0].id;
    else throw Errors.usage('no active identity — specify one: git colabor identity logout <id>');
  }
  const identity = await getIdentity(id);
  const binding = await getKeyBinding(id);

  const agentRemoved = binding.pushKey ? await removeKey(binding.pushKey.path) : false;

  // config layer: when the logging-out identity is what config currently
  // says, clear its standard keys (content-matched, no markers needed)
  let clearedConfig = false;
  if (resolved?.identity.id === id) {
    const { clearIdentityConfigLayer } = await import('./configClear.js');
    clearedConfig = await clearIdentityConfigLayer({ name: identity.name, email: identity.email }, opts.cwd);
  }
  // co-author selection + commit template ride along — logout leaves the
  // repo with zero colabor-managed state
  if (clearedConfig) {
    const { unsetAllConfig } = await import('../git/config.js');
    const { clearTemplate } = await import('../message/template.js');
    await unsetAllConfig('colabor.selected', 'local', opts.cwd);
    await clearTemplate(opts.cwd).catch(() => {});
  }

  await appendAudit({
    action: 'identity.logout',
    source: opts.source,
    identity: identity.id,
    identityName: identity.name,
    fingerprint: binding.pushKey?.fingerprint,
    repo: await safeTopLevel(opts.cwd),
    message: clearedConfig ? 'cleared config + agent' : 'agent only',
  });

  return {
    identity: { id: identity.id, name: identity.name, fingerprint: binding.pushKey?.fingerprint },
    agentRemoved,
  };
}
