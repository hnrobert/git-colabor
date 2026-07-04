import { Errors } from '../core/errors.js';
import { failFromError, emit } from './json.js';
import { parseArgv, type Parsed } from './parse-args.js';
import { renderAuthors, type AuthorJson } from './render.js';
import * as coauthor from './coauthor.js';
import type { JsonResult } from '../core/types.js';

const VERSION = '0.1.0';

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
    '  git colabor identity ls|use|add|rm|logout|audit|doctor|revert   (ships in M2)',
    '',
    'Global flags: --json --log-level <level> -C <path> --no-color -h -v',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgv(argv);
  const { flags, subgroup, command, args } = parsed;
  const cwd = flags.cwd ?? process.cwd();

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (!subgroup || flags.help) {
    process.stdout.write(`${topHelp()}\n`);
    process.exit(0);
  }

  let result: JsonResult;
  try {
    if (subgroup === 'coauthor') {
      result = await dispatchCoauthor(command, args, parsed, cwd);
    } else if (subgroup === 'identity') {
      throw Errors.usage('identity commands ship in M2', [
        'Co-author commands are ready now — try: git colabor coauthor ls',
      ]);
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
  args: string[],
  parsed: Parsed,
  cwd: string,
): Promise<JsonResult> {
  const initials = parsed.localFlags.includes('-i') || parsed.localFlags.includes('--initials');
  switch (command) {
    case undefined:
    case 'ls':
      return coauthor.ls(args, cwd);
    case 'use':
      return coauthor.use(args, cwd);
    case 'solo':
      return coauthor.solo(cwd);
    case 'print':
      return coauthor.print({ initials }, cwd);
    case 'add':
      return coauthor.add(args, cwd);
    case 'suggest':
      return parsed.flags.json ? coauthor.suggest(args, cwd) : coauthor.suggestInteractive(args, cwd);
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
  if (subgroup === 'coauthor') {
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
      return added.length
        ? `Added ${added.length} co-author(s):\n${renderAuthors(added)}`
        : 'No co-authors added.';
    }
  }
  return JSON.stringify(d, null, 2);
}

main().catch((e) => {
  process.stderr.write(`internal error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
