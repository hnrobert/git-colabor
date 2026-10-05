import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setConfig } from '../git/config.js';
import { dataDir } from '../paths.js';
import { topLevel } from '../git/rev.js';
import { captureBackupIfFirstTouch, readState, writeState } from '../repo/state.js';
import { detectConflict, nowHeldBy, cliSessionId, type ConflictInfo } from '../repo/coordination.js';
import { appendAudit } from '../logging/audit.js';
import { keyInAgent } from './agent.js';
import { getIdentity, updateIdentity } from './map.js';
import { importKey } from './keys.js';
import { ensureSignWrapper } from './sign.js';
import { discoverSessionBridge } from '../secrets/session-bridge.js';
import { AppError } from '../errors.js';
import { existsSync } from 'node:fs';
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
  /** is the identity's key fingerprint currently held by ssh-agent (undefined when no key) */
  agent?: { inAgent: boolean };
  /** the askpass prefix was baked into core.sshCommand (a bridge session exists) */
  bridgeUsed?: boolean;
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
 * capture backup on first touch, record heldBy, report agent presence, audit. Keys are NEVER
 * auto-loaded into ssh-agent here — loading is an explicit manual action (`identity agent`).
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
  // leaves the existing signing config untouched. Agent-held keys sign via
  // their public half (see signingKeyPath in sign.ts). The sign wrapper is
  // also refreshed (content-compare rewrite) so older wrappers update to the
  // current layout without a manual sign re-toggle.
  if (state.signing === true && identity?.sshKeyPath && sshCommand) {
    await setConfig('commit.gpgsign', 'true', 'local', opts.cwd);
    await setConfig('gpg.format', 'ssh', 'local', opts.cwd);
    const pub = `${identity.sshKeyPath}.pub`;
    const viaAgent = !!identity.sshKeyFingerprint
      && (await keyInAgent(identity.sshKeyFingerprint))
      && existsSync(pub);
    await setConfig('user.signingKey', viaAgent ? pub : identity.sshKeyPath, 'local', opts.cwd);
    if (opts.askpassScriptPath) {
      await setConfig('gpg.ssh.program', await ensureSignWrapper(opts.askpassScriptPath), 'local', opts.cwd);
    }
  }
  await writeState(state, opts.cwd);

  // report-only: is the key already in the agent? (never auto-load — loading
  // is the explicit `identity agent` command)
  let agent: ApplyResult['agent'];
  if (identity?.sshKeyFingerprint) {
    agent = { inAgent: await keyInAgent(identity.sshKeyFingerprint) };
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

  return { name, email, sshCommand, conflict, agent };
}

/**
 * The `core.sshCommand` for a key. When driven by the extension (askpass
 * bundle known), bake the SSH_ASKPASS prefix into the command so push/fetch
 * over this key gets its passphrase from the extension's session store even
 * with no tty and no ssh-agent — git runs core.sshCommand through a shell,
 * so the env assignment prefix is honored. Plain CLI use (no bundle) keeps
 * the bare ssh command.
 *
 * ssh execve()s the SSH_ASKPASS path, so the .cjs bundle needs an executable
 * wrapper that re-execs it with the running node (the VS Code Server's node
 * on remote hosts — not necessarily on PATH). The wrapper is written to the
 * data dir (idempotent) and used as the SSH_ASKPASS value.
 */
export async function ensureAskpassWrapper(askpassScriptPath: string): Promise<string> {
  const wrapperPath = join(dataDir(), 'askpass-wrapper.sh');
  const content = `#!/bin/sh\nexec "${process.execPath}" "${askpassScriptPath}" "$@"\n`;
  try {
    const existing = await readFile(wrapperPath, 'utf8');
    if (existing === content) return wrapperPath;
  } catch {
    // not there yet — write below
  }
  await writeFile(wrapperPath, content, { mode: 0o700 });
  await chmod(wrapperPath, 0o700); // existing file keeps its old mode
  return wrapperPath;
}

/**
 * Resolve an identity from the map, then apply it. `asName`/`asEmail` override the committer
 * name/email (used by the extension reconcile path where the VS Code setting wins).
 */
export async function applyIdentity(
  id: string,
  opts: ApplyOpts & { asName?: string; asEmail?: string },
): Promise<{ identity: Identity; result: ApplyResult }> {
  let identity = await getIdentity(id);
  let sshCommand: string | undefined;
  let bridgeUsed = false;
  let keyMissing = false;
  if (identity.sshKeyPath) {
    // Reference mode: the key lives wherever the user put it. A broken
    // reference (moved/renamed/deleted) degrades to a key-less apply —
    // name/email still switch, no core.sshCommand is written, agent load skipped.
    let imp: Awaited<ReturnType<typeof importKey>> | undefined;
    try {
      imp = await importKey(identity.sshKeyPath); // parse = usability check
    } catch {
      imp = undefined;
    }
    if (imp) {
      // Self-heal derived fields: the PATH is the source of truth, fingerprint
      // and the encryption flag are derived from the file. Legacy rows created
      // before sshKeyEncrypted existed — and keys attached via the old
      // `identity set --key` (which skipped the flag) — carry a stale flag;
      // a replaced key file also rotates the fingerprint. Heal on use so the
      // passphrase prompt and the agent fingerprint match see reality.
      if (imp.fingerprint !== identity.sshKeyFingerprint || imp.encrypted !== !!identity.sshKeyEncrypted) {
        await updateIdentity(id, { sshKeyFingerprint: imp.fingerprint, sshKeyEncrypted: imp.encrypted });
        identity = { ...identity, sshKeyFingerprint: imp.fingerprint, sshKeyEncrypted: imp.encrypted };
      }
      const bare = `ssh -i ${identity.sshKeyPath} -o IdentitiesOnly=yes`;
      // Bake the SSH_ASKPASS prefix only when the extension bridge is actually
      // reachable (env socket or a live session file). SSH_ASKPASS_REQUIRE=force
      // kills ssh's tty fallback, so baking it with no bridge behind would turn
      // every push into "no passphrase available" for pure-CLI users — they get
      // the bare command instead: ssh-agent if the key is loaded, else a per-
      // operation passphrase prompt on the tty.
      const bridge = (opts.socketPath && opts.token) || discoverSessionBridge();
      if (opts.askpassScriptPath && bridge) {
        const wrapper = await ensureAskpassWrapper(opts.askpassScriptPath);
        sshCommand = `SSH_ASKPASS="${wrapper}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ${bare}`;
        bridgeUsed = true;
      } else {
        sshCommand = bare;
      }
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
  result.bridgeUsed = bridgeUsed;
  return { identity, result };
}
