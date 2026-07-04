import { createInterface } from 'node:readline/promises';
import { Author } from '../core/authors/types.js';
import {
  addCoAuthor,
  getAuthor,
  listAuthors,
  validateEmail,
} from '../core/authors/store.js';
import { clearSelected, getSelected, setSelected } from '../core/coauthors/state.js';
import { printTrailers } from '../core/message/formatter.js';
import { repoAuthors } from '../core/git/shortlog.js';
import { insideWorkTree } from '../core/git/rev.js';
import { AppError, Errors } from '../core/errors.js';
import type { JsonResult } from '../core/types.js';
import { authorToJson, type AuthorJson } from './render.js';
import { ok } from './json.js';

async function requireRepo(cwd?: string): Promise<void> {
  if (!(await insideWorkTree(cwd))) throw Errors.notARepo(cwd);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** `git colabor coauthor ls [filter]` */
export async function ls(args: string[], cwd?: string): Promise<JsonResult> {
  const authors = await listAuthors(args[0], cwd);
  return ok(authors.map(authorToJson));
}

/** `git colabor coauthor use [initials...]` — with no args, print current selection. */
export async function use(args: string[], cwd?: string): Promise<JsonResult> {
  await requireRepo(cwd);
  if (args.length === 0) {
    const selected = await getSelected(cwd);
    const data = { selected: selected.map(authorToJson) };
    return selected.length === 0
      ? ok(data, [{ code: 'empty', message: 'no co-authors selected' }])
      : ok(data);
  }
  const all = await listAuthors(undefined, cwd);
  const selected: Author[] = [];
  for (const k of args) {
    const found = all.find((a) => a.key === k);
    if (!found) throw Errors.authorNotFound(k);
    selected.push(found);
  }
  await setSelected(selected, cwd);
  return ok({ selected: selected.map(authorToJson) });
}

/** `git colabor coauthor solo` */
export async function solo(cwd?: string): Promise<JsonResult> {
  await requireRepo(cwd);
  await clearSelected(cwd);
  return ok({ selected: [] as AuthorJson[] });
}

/** `git colabor coauthor print [-i]` */
export async function print(opts: { initials: boolean }, cwd?: string): Promise<JsonResult> {
  const selected = await getSelected(cwd);
  const text = opts.initials ? selected.map((a) => a.key).join(',') : printTrailers(selected);
  return ok({ text });
}

/** `git colabor coauthor add <initials> "Name" <email>` */
export async function add(args: string[], cwd?: string): Promise<JsonResult> {
  const [key, name, email] = args;
  if (!key || !name || !email) {
    throw Errors.usage('git colabor coauthor add <initials> "Name" <email>');
  }
  if (!validateEmail(email)) throw Errors.invalidEmail(email);
  const author = new Author(key, name, email);
  await addCoAuthor(author, cwd);
  return ok({ author: authorToJson(author) });
}

/** `git colabor coauthor suggest [filter]` (JSON: return candidates). */
export async function suggest(args: string[], cwd?: string): Promise<JsonResult> {
  await requireRepo(cwd);
  const candidates = await repoAuthors(args[0], cwd);
  if (candidates.length === 0) {
    return ok({ candidates: [], added: [] }, [
      { code: 'none', message: 'no contributors found' },
    ]);
  }
  return ok({ candidates: candidates.map(authorToJson), added: [] });
}

/** Human-mode interactive suggest: list numbered contributors, read indices, add. */
export async function suggestInteractive(args: string[], cwd?: string): Promise<JsonResult> {
  await requireRepo(cwd);
  const candidates = await repoAuthors(args[0], cwd);
  if (candidates.length === 0) {
    process.stderr.write('No contributors found.\n');
    return ok({ added: [] as AuthorJson[] });
  }
  process.stderr.write(
    candidates.map((a, i) => `[${i}] ${a.name} <${a.email}>`).join('\n') + '\n',
  );
  const answer = await prompt('Add which? (comma-separated numbers, blank to skip) ');
  const added: Author[] = [];
  for (const part of answer.split(',')) {
    const idx = Number(part.trim());
    if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
      added.push(candidates[idx]);
    }
  }
  for (const a of added) {
    try {
      await addCoAuthor(a, cwd);
    } catch (e) {
      // duplicate key is fine — already in catalogue
      if (!(e instanceof AppError && e.code === 'DUPLICATE_KEY')) throw e;
    }
  }
  return ok({ added: added.map(authorToJson) });
}

/** Resolve a single author by key (used by tests / future commands). */
export async function show(args: string[], cwd?: string): Promise<JsonResult> {
  const a = await getAuthor(args[0] ?? '', cwd);
  return ok(authorToJson(a));
}
