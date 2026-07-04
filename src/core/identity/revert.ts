import { getConfig, setConfig, unsetConfig, unsetAllConfig } from '../git/config.js';
import { topLevel } from '../git/rev.js';
import { readState, writeState } from '../repo/state.js';
import { appendAudit } from '../logging/audit.js';
import { getIdentity } from './map.js';
import { removeKey } from './agent.js';
import { clearTemplate } from '../message/template.js';
import type { Backups, Source } from '../types.js';

async function safeTopLevel(cwd?: string): Promise<string | undefined> {
  try {
    return await topLevel(cwd);
  } catch {
    return undefined;
  }
}

async function restoreKey(key: string, value: string | undefined, cwd?: string): Promise<void> {
  if (value === undefined) await unsetConfig(key, 'local', cwd);
  else await setConfig(key, value, 'local', cwd);
}

/**
 * Restore a repo to its pre-tool state: user.name / user.email / core.sshCommand from backup,
 * drop our markers and co-author selection, best-effort remove the active key from the agent.
 * when no backup exists (just clears markers).
 */
export async function revertRepo(opts: { source: Source; cwd?: string }): Promise<{
  restored: Backups | undefined;
  hadBackup: boolean;
}> {
  const state = await readState(opts.cwd);
  const backups = state.backups;
  const managed = await getConfig('colabor.managed', 'local', opts.cwd);

  if (backups) {
    await restoreKey('user.name', backups.userName, opts.cwd);
    await restoreKey('user.email', backups.userEmail, opts.cwd);
    await restoreKey('core.sshCommand', backups.sshCommand, opts.cwd);
    await restoreKey('commit.template', backups.commitTemplate, opts.cwd);
  }

  if (state.activeIdentity) {
    try {
      const id = await getIdentity(state.activeIdentity);
      if (id.sshKeyPath) await removeKey(id.sshKeyPath);
    } catch {
      // identity removed from map — nothing to remove from agent
    }
  }

  await unsetConfig('colabor.managed', 'local', opts.cwd);
  await unsetConfig('colabor.managed-by', 'local', opts.cwd);
  await unsetAllConfig('colabor.selected', 'local', opts.cwd);
  await clearTemplate(opts.cwd).catch(() => {});

  state.activeIdentity = undefined;
  state.backups = undefined;
  state.heldBy = undefined;
  await writeState(state, opts.cwd);

  await appendAudit({
    action: 'identity.revert',
    source: opts.source,
    repo: await safeTopLevel(opts.cwd),
    result: managed === 'true' ? 'ok' : 'warn',
    message: managed === 'true' ? undefined : 'repo was not managed',
  });

  return { restored: backups, hadBackup: !!backups };
}
