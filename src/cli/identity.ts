import { spawnSync } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { parseCommandArgs, type CmdParsed, type GlobalFlags } from './parse-args.js';
import { Errors } from '../core/errors.js';
import { ok } from './json.js';
import {
  addIdentity,
  getIdentity,
  hideIdentityEmail,
  listHiddenEmails,
  listIdentities,
  readMap,
  removeIdentity,
  setDefault,
  unhideIdentityEmail,
  updateIdentity,
} from '../core/identity/map.js';
import { historyCommitters } from '../core/git/committers.js';
import { importKey } from '../core/identity/keys.js';
import { applyIdentity, applyResolvedIdentity, ensureAskpassWrapper } from '../core/identity/apply.js';
import { revertRepo } from '../core/identity/revert.js';
import { setCommitSigning } from '../core/identity/sign.js';
import { logoutIdentity } from '../core/identity/logout.js';
import { appendAudit, readAudit } from '../core/logging/audit.js';
import { agentFingerprints, keyInAgent, listAgent, loadKey, removeKey, verifyKey } from '../core/identity/agent.js';
import { getConfig } from '../core/git/config.js';
import { insideWorkTree, topLevel } from '../core/git/rev.js';
import { readState, writeState } from '../core/repo/state.js';
import { repoStatus } from '../core/repo/status.js';
import { auditLogPath, mapPath } from '../core/paths.js';
import type { Diagnostic, Identity, JsonResult, Source, Warning } from '../core/types.js';

export type IdCtx = {
  cwd?: string;
  flags: GlobalFlags;
  askpassScriptPath?: string;
  socketPath?: string;
  token?: string;
};

const USE_SPEC = { valueFlags: ['--source', '--as-name', '--as-email'], boolFlags: ['--no-override'] };
const ADD_SPEC = {
  valueFlags: ['--name', '--email', '--key', '--host', '--source'],
  boolFlags: ['--default', '--no-encrypt'],
};
const AUDIT_SPEC = { valueFlags: ['--repo', '--since', '--tail'] };
const APPLY_SPEC = { valueFlags: ['--name', '--email', '--ssh-command', '--source'] };
const SET_SPEC = { valueFlags: ['--name', '--email', '--key', '--scope'], boolFlags: ['--no-key'] };
const SIGN_SPEC = { valueFlags: [], boolFlags: ['--off'] };
const AGENT_SPEC = { valueFlags: [], boolFlags: ['--remove', '--verify'] };

function identityToJson(i: Identity, defaultId?: string, agentPrints?: Set<string>) {
  return {
    id: i.id,
    name: i.name,
    email: i.email,
    sshKeyFingerprint: i.sshKeyFingerprint,
    host: i.host,
    // reference mode: a key counts only while the referenced file is still there
    hasKey: !!i.sshKeyPath && existsSync(i.sshKeyPath),
    sshKeyPath: i.sshKeyPath,
    keyEncrypted: !!i.sshKeyEncrypted,
    /** key fingerprint currently held by ssh-agent (live check, one listAgent per call) */
    inAgent: !!i.sshKeyFingerprint && (agentPrints?.has(i.sshKeyFingerprint) ?? false),
    imported: !!i.imported,
    disabled: !!i.disabled,
    scope: i.scope ?? (i.imported ? 'project' : 'machine'),
    remoteKeys: i.remoteKeys,
    isDefault: i.id === defaultId,
  };
}

function asSource(v: string | undefined): Source {
  return v === 'ext' ? 'ext' : 'cli';
}

async function safeTopLevel(cwd?: string): Promise<string | undefined> {
  try {
    return await topLevel(cwd);
  } catch {
    return undefined;
  }
}

export async function dispatch(command: string | undefined, tokens: string[], ctx: IdCtx): Promise<JsonResult> {
  switch (command) {
    case undefined:
    case 'ls':
      return ls();
    case 'use':
      return use(parseCommandArgs(tokens, USE_SPEC), ctx);
    case 'add':
      return add(parseCommandArgs(tokens, ADD_SPEC));
    case 'import':
      return importFromHistory(ctx);
    case 'set':
      return setIdentity(parseCommandArgs(tokens, SET_SPEC));
    case 'sign':
      return sign(parseCommandArgs(tokens, SIGN_SPEC), ctx);
    case 'disable':
      return disable(parseCommandArgs(tokens), ctx);
    case 'unhide':
      return unhide(parseCommandArgs(tokens));
    case 'hidden':
      return hiddenLs();
    case 'rm':
      return rm(parseCommandArgs(tokens), ctx);
    case 'logout':
      return logout(parseCommandArgs(tokens), ctx);
    case 'agent':
      return agentKey(parseCommandArgs(tokens, AGENT_SPEC), ctx);
    case 'hide':
      return hideIdentityCmd(parseCommandArgs(tokens));
    case 'audit':
      return audit(parseCommandArgs(tokens, AUDIT_SPEC));
    case 'doctor':
      return doctor(ctx);
    case 'revert':
      return revert(ctx);
    case 'status':
      return status(ctx);
    case '_apply':
      return hiddenApply(parseCommandArgs(tokens, APPLY_SPEC), ctx);
    default:
      throw Errors.usage(`unknown identity command "${command}"`);
  }
}

async function ls(): Promise<JsonResult> {
  const { identities, defaultIdentity } = await listIdentities();
  const prints = await agentFingerprints();
  // machine-level hide suppresses the identity entirely — every scope,
  // user-remembered included (hide outranks remember)
  const hidden = new Set(await listHiddenEmails());
  const visible = identities.filter((i) => !hidden.has(i.email.toLowerCase()));
  return ok({ identities: visible.map((i) => identityToJson(i, defaultIdentity, prints)), defaultIdentity });
}

/** `identity hide <email>` — hide an identity on this machine (display + import). */
async function hideIdentityCmd(p: CmdParsed): Promise<JsonResult> {
  const email = p.positionals[0];
  if (!email) throw Errors.usage('git colabor identity hide <email>');
  await hideIdentityEmail(email);
  await appendAudit({
    action: 'identity.hide',
    source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
    message: email.toLowerCase(),
  });
  return ok({ hidden: email.toLowerCase() });
}

/**
 * The ONLY path that puts a key into ssh-agent (auto-load at use time was
 * removed): `identity agent <id>` loads it, `--remove` takes it out, and
 * `--verify` proves the session passphrase is correct without loading.
 */
async function agentKey(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity agent <id> [--remove | --verify]');
  const identity = await getIdentity(id);
  if (!identity.sshKeyPath || !identity.sshKeyFingerprint) {
    throw Errors.usage(`identity "${id}" has no SSH key`);
  }
  const remove = p.bools.has('--remove');
  const verify = p.bools.has('--verify');
  if (remove && verify) throw Errors.usage('--remove and --verify are mutually exclusive');

  if (remove) {
    const removed = await removeKey(identity.sshKeyPath);
    await appendAudit({
      action: 'key.remove',
      source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
      identity: id,
      identityName: identity.name,
      fingerprint: identity.sshKeyFingerprint,
    });
    return ok({ removed, inAgent: await keyInAgent(identity.sshKeyFingerprint) }, removed ? [] : [
      { code: 'not-in-agent', message: 'key was not loaded in ssh-agent' },
    ]);
  }

  const askpassScriptPath = ctx.askpassScriptPath ? await ensureAskpassWrapper(ctx.askpassScriptPath) : undefined;
  if (verify) {
    // session-passphrase check without any agent write (ssh-keygen -y under askpass)
    const verified = await verifyKey({
      keyPath: identity.sshKeyPath,
      fingerprint: identity.sshKeyFingerprint,
      askpassScriptPath,
      socketPath: ctx.socketPath,
      token: ctx.token,
    });
    return ok({ verified, inAgent: await keyInAgent(identity.sshKeyFingerprint) });
  }

  const loaded = await loadKey({
    keyPath: identity.sshKeyPath,
    fingerprint: identity.sshKeyFingerprint,
    askpassScriptPath,
    socketPath: ctx.socketPath,
    token: ctx.token,
    useAppleKeychain: true,
  });
  if (loaded.loaded) {
    await appendAudit({
      action: 'key.load',
      source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
      identity: id,
      identityName: identity.name,
      fingerprint: identity.sshKeyFingerprint,
      message: `via ${loaded.via}`,
    });
  }
  return ok(
    // inAgent is a live re-check: keygen-verify (agent-less host) reports
    // loaded=true even though no agent holds the key
    { loaded: loaded.loaded, via: loaded.via, inAgent: await keyInAgent(identity.sshKeyFingerprint), message: loaded.message },
    loaded.loaded ? [] : [{ code: 'key-not-loaded', message: loaded.message ?? `via ${loaded.via}` }],
  );
}

async function use(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity use <id>');
  // an explicit use is explicit intent — re-enable a disabled identity
  const current = await getIdentity(id);
  if (current.disabled) await updateIdentity(id, { disabled: undefined });
  const { identity, result } = await applyIdentity(id, {
    source: asSource(p.values['--source']),
    cwd: ctx.cwd,
    asName: p.values['--as-name'],
    asEmail: p.values['--as-email'],
    noOverride: p.bools.has('--no-override'),
    askpassScriptPath: ctx.askpassScriptPath,
    socketPath: ctx.socketPath,
    token: ctx.token,
  });
  const warnings: Warning[] = [];
  if (result.conflict) warnings.push({ code: 'conflict', message: `overrode ${result.conflict.heldBy.session}` });
  if (result.keyMissing) {
    warnings.push({
      code: 'key-missing',
      message: `key file missing or unreadable: ${identity.sshKeyPath} — applied without a key (no core.sshCommand)`,
    });
  }
  // pure-CLI with an encrypted key that is neither in the agent nor served by
  // the extension bridge → every push will prompt on the tty; point at ssh-add
  if (identity.sshKeyEncrypted && result.agent && !result.agent.inAgent && !result.bridgeUsed) {
    warnings.push({
      code: 'agent-reminder',
      message: `key not in ssh-agent — run \`ssh-add ${identity.sshKeyPath}\` to cache it, or each push will prompt for the passphrase`,
    });
  }
  return ok(
    {
      identity: identityToJson(identity),
      applied: { userName: result.name, userEmail: result.email, sshCommand: result.sshCommand ?? null },
      agent: result.agent ?? null,
      conflict: result.conflict,
    },
    warnings,
  );
}

async function add(p: CmdParsed): Promise<JsonResult> {
  const name = p.values['--name'];
  const email = p.values['--email'];
  if (!name || !email) {
    throw Errors.usage('git colabor identity add --name <n> --email <e> [--key <path>] [--host <h>] [--default]');
  }
  const warnings: Warning[] = [];
  let sshKeyFingerprint: string | undefined;
  let sshKeyPath: string | undefined;
  let sshKeyEncrypted: boolean | undefined;
  let encrypted: boolean | null = null;
  const keySource = p.values['--key'];
  if (keySource) {
    if (!existsSync(keySource)) throw Errors.usage(`key file not found: ${keySource}`);
    const imp = await importKey(keySource);
    sshKeyFingerprint = imp.fingerprint;
    sshKeyPath = imp.path;
    encrypted = imp.encrypted;
    sshKeyEncrypted = imp.encrypted;
    if (imp.encrypted) {
      warnings.push({
        code: 'encrypted-key',
        message: 'key is encrypted; it loads via the extension askpass session or an ssh-agent',
      });
    } else {
      warnings.push({
        code: 'unencrypted-key',
        message: 'key is UNENCRYPTED — anyone who reads the key file can use it. Consider encrypting it.',
      });
    }
  }
  const identity = await addIdentity({
    name,
    email,
    sshKeyFingerprint,
    sshKeyPath,
    sshKeyEncrypted,
    host: p.values['--host'],
  });
  if (p.bools.has('--default')) await setDefault(identity.id);
  await appendAudit({ action: 'key.load', source: 'cli', identity: identity.id, identityName: name, fingerprint: sshKeyFingerprint });
  return ok({ identity: identityToJson(identity), encrypted }, warnings);
}

/**
 * Add every distinct committer from the repo history as a (key-less)
 * identity. Idempotent: committers already in the map (by email) are
 * skipped, as are emails hidden via hide(machine). Mostly driven by the
 * extension on repo open.
 */
export async function importFromHistory(ctx: IdCtx): Promise<JsonResult> {
  if (!(await insideWorkTree(ctx.cwd))) throw Errors.notARepo(ctx.cwd);
  const committers = await historyCommitters(ctx.cwd);
  const map = await readMap();
  const known = new Set(Object.values(map.identities).map((i) => i.email.toLowerCase()));
  const hidden = new Set(Object.keys(map.hidden ?? {}));
  const added: Identity[] = [];
  for (const c of committers) {
    const id = c.email.toLowerCase();
    if (known.has(id) || hidden.has(id)) continue;
    const identity = await addIdentity({
      name: c.name,
      email: c.email,
      imported: true,
      scope: 'project',
    });
    known.add(id);
    added.push(identity);
  }
  if (added.length > 0) {
    await appendAudit({
      action: 'identity.import',
      source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
      message: `imported ${added.length} committer(s) from history`,
    });
  }
  const warnings: Warning[] =
    committers.length === 0 ? [{ code: 'empty', message: 'no commits found in history' }] : [];
  return ok({ added: added.map((i) => identityToJson(i)), skipped: committers.length - added.length }, warnings);
}

async function rm(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity rm <id>');
  let email: string | undefined;
  let wasImported = false;
  try {
    const identity = await getIdentity(id);
    email = identity.email;
    wasImported = !!identity.imported;
  } catch {
    // fall through — removeIdentity reports the not-found error
  }
  try {
    await logoutIdentity({ source: 'cli', cwd: ctx.cwd, id });
  } catch {
    // identity may have no key / not active — that's fine for removal
  }
  await removeIdentity(id);
  if (wasImported && email) await hideIdentityEmail(email); // keep auto-import from resurrecting it
  return ok({ removed: id, hidden: wasImported ? (email ?? '').toLowerCase() : undefined });
}

/**
 * Edit an identity in place: --name / --email / --key <path> (re-reference)
 * / --no-key (clear the key reference). Changes land in the machine-level
 * identity store (~/.config/git-colabor/identities.json).
 */
async function setIdentity(p: CmdParsed): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity set <id> --name <n> | --email <e> | --key <path> | --no-key');
  await getIdentity(id); // validates existence
  const patch: Parameters<typeof updateIdentity>[1] = {};
  const warnings: Warning[] = [];
  if (p.values['--name']) patch.name = p.values['--name'];
  if (p.values['--email']) patch.email = p.values['--email'];
  if (p.bools.has('--no-key')) patch.sshKeyPath = undefined;
  if (p.values['--key']) {
    const keySource = p.values['--key'];
    if (!existsSync(keySource)) throw Errors.usage(`key file not found: ${keySource}`);
    const imp = await importKey(keySource);
    patch.sshKeyPath = imp.path;
    patch.sshKeyFingerprint = imp.fingerprint;
    patch.sshKeyEncrypted = imp.encrypted;
    if (imp.encrypted) {
      warnings.push({
        code: 'encrypted-key',
        message: 'key is encrypted; it loads via the extension askpass session or an ssh-agent',
      });
    }
  }
  if (p.values['--scope']) {
    const s = p.values['--scope'];
    // 'user' is the pre-rename spelling of 'vscode' — accepted as an alias
    if (s !== 'vscode' && s !== 'user' && s !== 'machine' && s !== 'project') {
      throw Errors.usage(`--scope must be vscode|machine|project, got "${s}"`);
    }
    patch.scope = s === 'user' ? 'vscode' : s;
  }
  if (Object.keys(patch).length === 0) {
    throw Errors.usage('identity set needs at least one of --name / --email / --key / --no-key');
  }
  const next = await updateIdentity(id, patch);
  await appendAudit({
    action: 'identity.set',
    source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
    identity: id,
    identityName: next.name,
    fingerprint: next.sshKeyFingerprint,
    message: `set ${Object.keys(patch).join(', ')}`,
  });
  return ok({ identity: identityToJson(next) }, warnings);
}

async function logout(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const r = await logoutIdentity({ source: 'cli', cwd: ctx.cwd, id: p.positionals[0] });
  return ok({
    identity: r.identity,
    cleared: { agent: r.agentRemoved },
  });
}

async function audit(p: CmdParsed): Promise<JsonResult> {
  const entries = await readAudit({
    repo: p.values['--repo'],
    since: p.values['--since'],
    tail: p.values['--tail'] ? Number(p.values['--tail']) : undefined,
  });
  return ok({ entries });
}

/** Remove an email from the hidden list (restore for auto-import). */
async function unhide(p: CmdParsed): Promise<JsonResult> {
  const email = p.positionals[0];
  if (!email) throw Errors.usage('git colabor identity unhide <email>');
  const removed = await unhideIdentityEmail(email);
  if (!removed) throw Errors.usage(`"${email}" is not hidden`);
  return ok({ unhid: email.toLowerCase() });
}

/** List all hidden emails. */
async function hiddenLs(): Promise<JsonResult> {
  return ok({ hidden: await listHiddenEmails() });
}

/** Toggle opt-in SSH commit signing for the repo with an identity's key. */
async function sign(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity sign <id> [--off]');
  const r = await setCommitSigning({
    source: 'cli',
    cwd: ctx.cwd,
    id,
    on: !p.bools.has('--off'),
    askpassScriptPath: ctx.askpassScriptPath,
  });
  return ok(r);
}

/**
 * Disable an identity (passphrase wrong / cancelled / unavailable) and clear
 * it as the repo's active identity — the repo is left identity-less
 * ("悬空"): no active identity, reconcile skips it, no prompt loop. An
 * explicit `identity use` re-enables. Repo config is left as-is.
 */
async function disable(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity disable <id>');
  const identity = await getIdentity(id);
  await updateIdentity(id, { disabled: true });
  let deactivated = false;
  if (ctx.cwd) {
    const state = await readState(ctx.cwd);
    if (state.activeIdentity === id) {
      state.activeIdentity = undefined;
      state.heldBy = undefined;
      await writeState(state, ctx.cwd);
      deactivated = true;
    }
  }
  await appendAudit({
    action: 'identity.disable',
    source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
    identity: id,
    identityName: identity.name,
    repo: deactivated ? await safeTopLevel(ctx.cwd) : undefined,
    message: deactivated ? 'deactivated in repo' : 'disabled',
  });
  return ok({ disabled: id, deactivated });
}

async function revert(ctx: IdCtx): Promise<JsonResult> {
  const r = await revertRepo({ source: 'cli', cwd: ctx.cwd });
  return ok({ restored: r.restored ?? null, hadBackup: r.hadBackup });
}

async function hiddenApply(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const name = p.values['--name'];
  const email = p.values['--email'];
  if (!name || !email) throw Errors.usage('internal _apply requires --name and --email');
  const result = await applyResolvedIdentity({
    name,
    email,
    sshCommand: p.values['--ssh-command'],
    opts: { source: asSource(p.values['--source']), cwd: ctx.cwd },
  });
  return ok({
    applied: { userName: result.name, userEmail: result.email, sshCommand: result.sshCommand ?? null },
    conflict: result.conflict,
  });
}

async function status(ctx: IdCtx): Promise<JsonResult> {
  const { identities, defaultIdentity } = await listIdentities();
  const rs = await repoStatus(ctx.cwd);
  const active = rs.activeIdentityId ? identities.find((i) => i.id === rs.activeIdentityId) : undefined;
  const st = ctx.cwd ? await readState(ctx.cwd) : undefined;
  const signingKey = await getConfig('user.signingKey', 'local', ctx.cwd);
  const prints = await agentFingerprints();
  // hide outranks every display scope, but the ACTIVE identity survives —
  // it reflects the repo's current configuration, not a display preference
  const hidden = new Set(await listHiddenEmails());
  const rows = identities
    .filter((i) => i.id === rs.activeIdentityId || !hidden.has(i.email.toLowerCase()))
    .map((i) => ({ ...identityToJson(i, defaultIdentity, prints), active: i.id === rs.activeIdentityId }));
  return ok({
    repo: rs.repo,
    inRepo: rs.inRepo,
    managed: rs.managed,
    managedBy: rs.managedBy,
    heldBy: rs.heldBy,
    signing: { enabled: st?.signing === true, key: signingKey ?? null },
    activeIdentity: active ? identityToJson(active, defaultIdentity, prints) : null,
    identities: rows,
    selected: rs.selected,
    available: rs.available,
  });
}

async function doctor(ctx: IdCtx): Promise<JsonResult> {
  const diags: Diagnostic[] = [];
  const check = (check: string, fn: () => boolean | string, detail?: string) => {
    try {
      const r = fn();
      diags.push({ check, status: r === true ? 'ok' : r === false ? 'warn' : 'ok', detail: typeof r === 'string' ? r : detail });
    } catch (e) {
      diags.push({ check, status: 'fail', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const hasBin = (b: string) =>
    process.platform === 'win32'
      ? spawnSync('where', [b]).status === 0
      : spawnSync(`command -v ${b}`, { shell: true }).status === 0;
  check('git', () => hasBin('git'));
  check('ssh-keygen', () => hasBin('ssh-keygen'));
  check('ssh-add', () => hasBin('ssh-add'));

  try {
    accessSync(mapPath(), constants.R_OK | constants.W_OK);
    check('identity map', () => true, mapPath());
  } catch {
    check('identity map', () => true, `${mapPath()} (will be created on first add)`);
  }

  check('audit log', () => true, auditLogPath());
  check('askpass bundle', () => (!!ctx.askpassScriptPath && existsSync(ctx.askpassScriptPath)) as boolean, ctx.askpassScriptPath);

  const agentOut = await listAgent();
  check('ssh-agent', () => !agentOut.includes('Could not open a connection'), agentOut.split('\n')[0]);

  const inRepo = ctx.cwd ? await insideWorkTree(ctx.cwd) : false;
  check('inside git repo', () => inRepo, ctx.cwd);
  if (inRepo && ctx.cwd) {
    const managed = await getConfig('colabor.managed', 'local', ctx.cwd);
    check('repo managed', () => managed === 'true', `colabor.managed=${managed ?? 'unset'}`);
    const st = await readState(ctx.cwd);
    check('active identity', () => !!st.activeIdentity, st.activeIdentity ?? '(none)');
  }

  return ok({ diagnostics: diags });
}
