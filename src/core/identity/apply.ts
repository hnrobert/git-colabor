import { setConfig } from '../git/config.js';
import { topLevel } from '../git/rev.js';
import { captureBackupIfFirstTouch, readState, writeState } from '../repo/state.js';
import { detectConflict, nowHeldBy, cliSessionId, type ConflictInfo } from '../repo/coordination.js';
import { appendAudit } from '../logging/audit.js';
import { loadKey } from './agent.js';
import { getIdentity } from './map.js';
import { keyUsable } from './keys.js';
import { AppError } from '../errors.js';
import type { Identity, Source } from '../types.js';

export type ApplyOpts = {
  source: Source;
  cwd?: string;
  session?: string;
  staleMinutes?: number;
  noOverride?: boolean;
  /** askpass/agent (only relevant when the identity has a key) */
  askpassScriptPath?: string;
  socketPath?: string;
  token?: string;
};

export type ApplyResult = {
  name: string;
  email: string;
  sshCommand?: string;
  conflict: ConflictInfo | null;
  keyLoaded?: { loaded: boolean; via: string; message?: string };
  /** the referenced key file was missing/unreadable — applied without a key */
  keyMissing?: boolean;
};

async function safeTopLevel(cwd?: string): Promise<string | undefined> {
  try {
    return await topLevel(cwd);
  } catch {
    return undefined;
  }
}

/**
 * The single writer: write repo-local user.name / user.email / core.sshCommand, set markers,
 * capture backup on first touch, record heldBy, best-effort load the key into ssh-agent, audit.
 */
export async function applyResolvedIdentity(args: {
  name: string;
  email: string;
  sshCommand?: string;
  identity?: Identity;
  opts: ApplyOpts;
}): Promise<ApplyResult> {
  const { name, email, sshCommand, identity, opts } = args;
  const session = opts.session ?? (opts.source === 'cli' ? cliSessionId() : 'ext:unknown');

  const conflict = await detectConflict(session, opts.cwd, opts.staleMinutes);
  if (conflict && opts.noOverride) {
    throw new AppError({
      code: 'CONFLICT_BLOCKED',
      message: `repo is held by ${conflict.heldBy.session} (since ${conflict.heldBy.since})`,
      exitCode: 6,
      hints: ['re-run without --no-override to take over'],
    });
  }

  await captureBackupIfFirstTouch(opts.cwd);
  await setConfig('user.name', name, 'local', opts.cwd);
  await setConfig('user.email', email, 'local', opts.cwd);
  if (sshCommand) await setConfig('core.sshCommand', sshCommand, 'local', opts.cwd);
  await setConfig('colabor.managed', 'true', 'local', opts.cwd);
  await setConfig('colabor.managed-by', opts.source, 'local', opts.cwd);

  const state = await readState(opts.cwd);
  state.activeIdentity = identity?.id;
  state.heldBy = nowHeldBy(session, opts.source);
  // Commit signing is OPT-IN per repo (right-click toggle → `identity sign`).
  // When enabled, re-bind the signing key to the newly applied identity's
  // usable key so signatures follow the committer; a key-less identity
  // leaves the existing signing config untouched.
  if (state.signing === true && identity?.sshKeyPath && sshCommand) {
    await setConfig('commit.gpgsign', 'true', 'local', opts.cwd);
    await setConfig('gpg.format', 'ssh', 'local', opts.cwd);
    await setConfig('user.signingKey', identity.sshKeyPath, 'local', opts.cwd);
  }
  await writeState(state, opts.cwd);

  let keyLoaded: ApplyResult['keyLoaded'];
  if (identity?.sshKeyPath && identity.sshKeyFingerprint) {
    keyLoaded = await loadKey({
      keyPath: identity.sshKeyPath,
      fingerprint: identity.sshKeyFingerprint,
      askpassScriptPath: opts.askpassScriptPath,
      socketPath: opts.socketPath,
      token: opts.token,
      passphraseCommand: identity.passphraseCommand,
      useAppleKeychain: true,
    });
  }

  await appendAudit({
    action: 'identity.use',
    source: opts.source,
    identity: identity?.id,
    identityName: identity?.name ?? name,
    fingerprint: identity?.sshKeyFingerprint,
    repo: await safeTopLevel(opts.cwd),
    result: conflict ? 'warn' : 'ok',
    message: conflict ? `overrode ${conflict.heldBy.session}` : undefined,
  });

  return { name, email, sshCommand, conflict, keyLoaded };
}

/**
 * Resolve an identity from the map, then apply it. `asName`/`asEmail` override the committer
 * name/email (used by the extension reconcile path where the VS Code setting wins).
 */
export async function applyIdentity(
  id: string,
  opts: ApplyOpts & { asName?: string; asEmail?: string },
): Promise<{ identity: Identity; result: ApplyResult }> {
  const identity = await getIdentity(id);
  let sshCommand: string | undefined;
  let keyMissing = false;
  if (identity.sshKeyPath) {
    // Reference mode: the key lives wherever the user put it. A broken
    // reference (moved/renamed/deleted) degrades to a key-less apply —
    // name/email still switch, no core.sshCommand is written, agent load skipped.
    if (await keyUsable(identity.sshKeyPath)) {
      sshCommand = `ssh -i ${identity.sshKeyPath} -o IdentitiesOnly=yes`;
    } else {
      keyMissing = true;
    }
  }
  const result = await applyResolvedIdentity({
    name: opts.asName ?? identity.name,
    email: opts.asEmail ?? identity.email,
    sshCommand,
    identity: keyMissing ? { ...identity, sshKeyPath: undefined } : identity,
    opts,
  });
  result.keyMissing = keyMissing;
  return { identity, result };
}
