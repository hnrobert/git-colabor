import { spawnSync } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { parseCommandArgs, type CmdParsed, type GlobalFlags } from './parse-args.js';
import { Errors } from '../core/errors.js';
import { ok } from './json.js';
import {
  addIdentity,
  getIdentity,
  hideIdentityEmail,
  listIdentities,
  readMap,
  removeIdentity,
  setDefault,
  updateIdentity,
} from '../core/identity/map.js';
import { historyCommitters } from '../core/git/committers.js';
import { importKey } from '../core/identity/keys.js';
import { applyIdentity, applyResolvedIdentity } from '../core/identity/apply.js';
import { revertRepo } from '../core/identity/revert.js';
import { logoutIdentity } from '../core/identity/logout.js';
import { appendAudit, readAudit } from '../core/logging/audit.js';
import { listAgent } from '../core/identity/agent.js';
import { getConfig } from '../core/git/config.js';
import { insideWorkTree } from '../core/git/rev.js';
import { readState } from '../core/repo/state.js';
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
  valueFlags: ['--name', '--email', '--key', '--passphrase-command', '--host', '--source'],
  boolFlags: ['--default', '--no-encrypt'],
};
const AUDIT_SPEC = { valueFlags: ['--repo', '--since', '--tail'] };
const APPLY_SPEC = { valueFlags: ['--name', '--email', '--ssh-command', '--source'] };
const SET_SPEC = { valueFlags: ['--name', '--email', '--key', '--passphrase-command'], boolFlags: ['--no-key'] };

function identityToJson(i: Identity, defaultId?: string) {
  return {
    id: i.id,
    name: i.name,
    email: i.email,
    sshKeyFingerprint: i.sshKeyFingerprint,
    host: i.host,
    // reference mode: a key counts only while the referenced file is still there
    hasKey: !!i.sshKeyPath && existsSync(i.sshKeyPath),
    imported: !!i.imported,
    isDefault: i.id === defaultId,
  };
}

function asSource(v: string | undefined): Source {
  return v === 'ext' ? 'ext' : 'cli';
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
    case 'rm':
      return rm(parseCommandArgs(tokens), ctx);
    case 'logout':
      return logout(parseCommandArgs(tokens), ctx);
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
  return ok({ identities: identities.map((i) => identityToJson(i, defaultIdentity)), defaultIdentity });
}

async function use(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity use <id>');
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
  if (result.keyLoaded && !result.keyLoaded.loaded) {
    warnings.push({ code: 'key-not-loaded', message: `key not loaded into agent: ${result.keyLoaded.message ?? result.keyLoaded.via}` });
  }
  return ok(
    {
      identity: identityToJson(identity),
      applied: { userName: result.name, userEmail: result.email, sshCommand: result.sshCommand ?? null },
      keyLoaded: result.keyLoaded ?? null,
      conflict: result.conflict,
    },
    warnings,
  );
}

async function add(p: CmdParsed): Promise<JsonResult> {
  const name = p.values['--name'];
  const email = p.values['--email'];
  if (!name || !email) {
    throw Errors.usage('git colabor identity add --name <n> --email <e> [--key <path>] [--passphrase-command <cmd>] [--host <h>] [--default]');
  }
  const warnings: Warning[] = [];
  let sshKeyFingerprint: string | undefined;
  let sshKeyPath: string | undefined;
  let encrypted: boolean | null = null;
  const keySource = p.values['--key'];
  if (keySource) {
    if (!existsSync(keySource)) throw Errors.usage(`key file not found: ${keySource}`);
    const imp = await importKey(keySource);
    sshKeyFingerprint = imp.fingerprint;
    sshKeyPath = imp.path;
    encrypted = imp.encrypted;
    if (imp.encrypted && !p.values['--passphrase-command']) {
      warnings.push({
        code: 'encrypted-key',
        message: 'key is encrypted; provide --passphrase-command or run via the extension to load it at use time',
      });
    } else if (!imp.encrypted) {
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
    passphraseCommand: p.values['--passphrase-command'],
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
    const identity = await addIdentity({ name: c.name, email: c.email, imported: true });
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
    if (imp.encrypted && !p.values['--passphrase-command']) {
      warnings.push({
        code: 'encrypted-key',
        message: 'key is encrypted; provide --passphrase-command or run via the extension to load it at use time',
      });
    }
  }
  if (p.values['--passphrase-command']) patch.passphraseCommand = p.values['--passphrase-command'];
  if (Object.keys(patch).length === 0) {
    throw Errors.usage('identity set needs at least one of --name / --email / --key / --no-key / --passphrase-command');
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
  return ok({
    repo: rs.repo,
    inRepo: rs.inRepo,
    managed: rs.managed,
    managedBy: rs.managedBy,
    heldBy: rs.heldBy,
    activeIdentity: active ? identityToJson(active, defaultIdentity) : null,
    identities: identities.map((i) => ({ ...identityToJson(i, defaultIdentity), active: i.id === rs.activeIdentityId })),
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
