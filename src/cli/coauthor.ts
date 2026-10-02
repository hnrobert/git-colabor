import { createInterface } from 'node:readline/promises';
import { Author, genKey } from '../core/authors/types.js';
import { addIdentity, listIdentities } from '../core/identity/map.js';
import { clearSelected, getSelected, setSelected } from '../core/coauthors/state.js';
import { printTrailers } from '../core/message/formatter.js';
import { repoAuthors } from '../core/git/shortlog.js';
import { insideWorkTree } from '../core/git/rev.js';
import { Errors } from '../core/errors.js';
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

/** All identities as potential co-author Authors. */
async function identityAuthors(): Promise<{ id: string; author: Author }[]> {
  const { identities } = await listIdentities();
  return identities.map((i) => ({
    id: i.id,
    author: new Author(genKey(i.name, i.email), i.name, i.email),
  }));
}

/**
 * `git colabor coauthor ls [filter]` — lists identities as co-author candidates
 * (unified with the identity system; .git-coauthors is no longer the source).
 */
export async function ls(args: string[]): Promise<JsonResult> {
  const all = await identityAuthors();
  const filter = args[0]?.toLowerCase();
  const out = filter
    ? all.filter(({ author }) =>
        author.name.toLowerCase().includes(filter) || author.email.toLowerCase().includes(filter))
    : all;
  return ok(out.map(({ id, author }) => ({ id, key: author.key, name: author.name, email: author.email })));
}

/**
 * `git colabor coauthor use <email|id> [...]` — select co-authors by email or
 * identity ID (no args: print current selection).
 */
export async function use(args: string[], cwd?: string): Promise<JsonResult> {
  await requireRepo(cwd);
  if (args.length === 0) {
    const selected = await getSelected(cwd);
    const data = { selected: selected.map(authorToJson) };
    return selected.length === 0
      ? ok(data, [{ code: 'empty', message: 'no co-authors selected' }])
      : ok(data);
  }
  const all = await identityAuthors();
  const selected: Author[] = [];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    const found = all.find(({ id, author }) => author.email.toLowerCase() === lower || id === arg);
    if (!found) {
      throw Errors.authorNotFound(arg);
    }
    selected.push(found.author);
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

/**
 * `git colabor coauthor add "Name" <email>` — adds a key-less identity
 * (same as `identity add --name <n> --email <e>`). The old `.git-coauthors`
 * catalogue is no longer written.
 */
export async function add(args: string[]): Promise<JsonResult> {
  const [name, email] = args;
  if (!name || !email) {
    throw Errors.usage('git colabor coauthor add "Name" <email>  (or use identity add)');
  }
  const identity = await addIdentity({ name, email });
  return ok({ identity: { id: identity.id, name, email } });
}

/** `git colabor coauthor suggest [filter]` (JSON: return candidates from repo history). */
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

/**
 * Human-mode interactive suggest: list numbered committers, read indices,
 * add each as a key-less identity.
 */
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
  const added: { id: string; name: string; email: string }[] = [];
  for (const part of answer.split(',')) {
    const idx = Number(part.trim());
    if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
      const c = candidates[idx];
      const identity = await addIdentity({ name: c.name, email: c.email, imported: true, scope: 'project' });
      added.push({ id: identity.id, name: c.name, email: c.email });
    }
  }
  return ok({ added });
}
