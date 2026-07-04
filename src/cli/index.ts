import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Errors } from '../core/errors.js';
import { failFromError, emit } from './json.js';
import { parseCommandArgs, parseGlobals, type GlobalFlags } from './parse-args.js';
import { renderAuthors, type AuthorJson } from './render.js';
import * as coauthor from './coauthor.js';
import * as identity from './identity.js';
import type { JsonResult } from '../core/types.js';

const VERSION = '0.1.0';

// The CLI ships as a CJS bundle (dist/cli.cjs) where `__dirname` is the dist dir.
declare const __dirname: string | undefined;

/** Resolve the bundled askpass helper (dist/askpass.cjs), if present alongside this bundle. */
function resolveAskpass(): string | undefined {
  let dir: string | undefined;
  if (typeof __dirname === 'string' && __dirname.length > 0) dir = __dirname;
  else if (process.argv[1]) dir = dirname(process.argv[1]);
  if (!dir) return undefined;
  const p = join(dir, 'askpass.cjs');
  return existsSync(p) ? p : undefined;
}

function topHelp(): string {
  return [
    'git colabor — co-author + identity + SSH key management',
    '',
    'Usage:',
    '  git colabor coauthor ls [filter]',
    '  git colabor coauthor use <initials...>',
    '  git colabor coauthor solo',
    '  git colabor coauthor print [-i]',
    '  git colabor coauthor add <initials> "Name" <email>',
    '  git colabor coauthor suggest [filter]',
    '  git colabor identity ls',
    '  git colabor identity use <id> [--as-name <n> --as-email <e>]',
    '  git colabor identity add --name <n> --email <e> [--key <path>] [--passphrase-command <cmd>]',
    '  git colabor identity rm <id>',
    '  git colabor identity logout [id]',
    '  git colabor identity revert',
    '  git colabor identity audit [--repo <p>] [--tail N]',
    '  git colabor identity doctor',
    '',
    'Global flags: --json --log-level <level> -C <path> --no-color -h -v',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { flags, rest } = parseGlobals(argv);
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const subgroup = rest[0];
  const command = rest[1];
  const cmdTokens = rest.slice(2);
  if (!subgroup || flags.help) {
    process.stdout.write(`${topHelp()}\n`);
    process.exit(0);
  }
  const cwd = flags.cwd ?? process.cwd();

  let result: JsonResult;
  try {
    if (subgroup === 'coauthor') {
      result = await dispatchCoauthor(command, cmdTokens, flags, cwd);
    } else if (subgroup === 'identity') {
      result = await identity.dispatch(command, cmdTokens, {
        cwd,
        flags,
        askpassScriptPath: resolveAskpass(),
        socketPath: process.env.GIT_COLABOR_ASKPASS_SOCK,
        token: process.env.GIT_COLABOR_ASKPASS_TOKEN,
      });
    } else {
      throw Errors.usage(`unknown subgroup "${subgroup}"`);
    }
  } catch (e) {
    result = failFromError(e);
  }

  emit(result, { json: flags.json, human: (r) => humanFor(r, subgroup, command) });
}

async function dispatchCoauthor(
  command: string | undefined,
  tokens: string[],
  flags: GlobalFlags,
  cwd: string,
) {
  switch (command) {
    case undefined:
    case 'ls': {
      const p = parseCommandArgs(tokens);
      return coauthor.ls(p.positionals, cwd);
    }
    case 'use': {
      const p = parseCommandArgs(tokens);
      return coauthor.use(p.positionals, cwd);
    }
    case 'solo':
      return coauthor.solo(cwd);
    case 'print': {
      const p = parseCommandArgs(tokens, { boolFlags: ['-i', '--initials'] });
      return coauthor.print({ initials: p.bools.has('-i') || p.bools.has('--initials') }, cwd);
    }
    case 'add': {
      const p = parseCommandArgs(tokens);
      return coauthor.add(p.positionals, cwd);
    }
    case 'suggest': {
      const p = parseCommandArgs(tokens);
      return flags.json ? coauthor.suggest(p.positionals, cwd) : coauthor.suggestInteractive(p.positionals, cwd);
    }
    default:
      throw Errors.usage(`unknown coauthor command "${command}"`);
  }
}

function humanFor(r: JsonResult, subgroup: string, command?: string): string {
  if (!r.ok) {
    const lines = [`Error: ${r.error.message}`];
    for (const h of r.error.hints ?? []) lines.push(`  hint: ${h}`);
    return lines.join('\n');
  }
  const d = r.data;
  if (subgroup === 'coauthor') return coauthorHuman(command, d);
  if (subgroup === 'identity') return identityHuman(command, d);
  return JSON.stringify(d, null, 2);
}

function coauthorHuman(command: string | undefined, d: unknown): string {
  if (command === 'print') return String((d as { text?: string }).text ?? '');
  if (command === undefined || command === 'ls') {
    return renderAuthors((d as AuthorJson[]) ?? []);
  }
  if (command === 'use') {
    const sel = (d as { selected?: AuthorJson[] }).selected ?? [];
    return sel.length ? `Co-authoring with:\n${renderAuthors(sel)}` : 'No co-authors selected.';
  }
  if (command === 'solo') return 'Cleared co-authors.';
  if (command === 'add') return `${(d as { author: AuthorJson }).author.name} added to .git-coauthors`;
  if (command === 'suggest') {
    const added = (d as { added?: AuthorJson[] }).added ?? [];
    return added.length ? `Added ${added.length} co-author(s):\n${renderAuthors(added)}` : 'No co-authors added.';
  }
  return JSON.stringify(d, null, 2);
}

type IdentityJson = {
  id: string;
  name: string;
  email: string;
  sshKeyFingerprint?: string;
  hasKey: boolean;
  isDefault: boolean;
};

function identityHuman(command: string | undefined, d: unknown): string {
  if (command === undefined || command === 'ls') {
    const identities = (d as { identities: IdentityJson[] }).identities ?? [];
    if (identities.length === 0) return 'No identities. Add one: git colabor identity add --name <n> --email <e>';
    return identities
      .map(
        (i) =>
          `${i.isDefault ? '* ' : '  '}${i.id}  ${i.name} <${i.email}>${i.hasKey ? `  [key ${i.sshKeyFingerprint ?? ''}]` : ''}`,
      )
      .join('\n');
  }
  if (command === 'use') {
    const data = d as { identity: IdentityJson; applied: { userName: string; userEmail: string; sshCommand: string | null } };
    const lines = [
      `Applied identity "${data.identity.name}" <${data.identity.email}>`,
      `  user.name       = ${data.applied.userName}`,
      `  user.email      = ${data.applied.userEmail}`,
    ];
    if (data.applied.sshCommand) lines.push(`  core.sshCommand = ${data.applied.sshCommand}`);
    return lines.join('\n');
  }
  if (command === 'add') {
    const data = d as { identity: IdentityJson; encrypted: boolean | null };
    return `Added identity "${data.identity.name}" <${data.identity.email}> (${data.identity.id})${
      data.identity.hasKey ? ` key=${data.identity.sshKeyFingerprint ?? ''}` : ''
    }`;
  }
  if (command === 'rm') return `Removed identity ${(d as { removed: string }).removed}`;
  if (command === 'logout') {
    const data = d as { identity: { name: string }; cleared: { agent: boolean; keyfile: boolean } };
    return `Logged out "${data.identity.name}" (agent:${data.cleared.agent ? 'removed' : 'n/a'}, keyfile:${
      data.cleared.keyfile ? 'shredded' : 'n/a'
    })`;
  }
  if (command === 'revert') {
    const data = d as { hadBackup: boolean };
    return data.hadBackup ? 'Reverted repo identity to pre-tool state.' : 'Repo was not managed; nothing to revert.';
  }
  if (command === 'audit') {
    const entries = (d as { entries: Array<{ ts: string; action: string; identityName?: string; result: string }> }).entries ?? [];
    if (entries.length === 0) return '(no audit entries)';
    return entries.map((e) => `${e.ts}  ${e.result.padEnd(4)}  ${e.action}  ${e.identityName ?? ''}`).join('\n');
  }
  if (command === 'doctor') {
    const diags = (d as { diagnostics: Array<{ check: string; status: string; detail?: string }> }).diagnostics ?? [];
    return diags.map((x) => `[${x.status.padEnd(4)}] ${x.check}${x.detail ? ` — ${x.detail}` : ''}`).join('\n');
  }
  return JSON.stringify(d, null, 2);
}

main().catch((e) => {
  process.stderr.write(`internal error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
