import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Author } from './types.js';
import { topLevel } from '../git/rev.js';
import { Errors } from '../errors.js';

export const COAUTHORS_FILENAME = '.git-coauthors';

export type CoAuthorSchema = {
  coauthors: Record<string, { name: string; email: string }>;
};

const EMAIL_RE =
  /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[(?:\d{1,3}\.){3}\d{1,3}])|((\w+\.)+[a-zA-Z]{2,}))$/;

export function validateEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function homeCoAuthorsPath(): string {
  return join(homedir(), COAUTHORS_FILENAME);
}

/**
 * 3-tier resolution (mirrors git-mob):
 *   env GIT_COLABOR_COAUTHORS_PATH > repo-root/.git-coauthors (if exists) > ~/.git-coauthors
 */
export async function coAuthorsPath(cwd?: string): Promise<string> {
  const envPath = process.env.GIT_COLABOR_COAUTHORS_PATH;
  if (envPath) return resolve(envPath);
  try {
    const root = await topLevel(cwd);
    const local = join(root, COAUTHORS_FILENAME);
    if (existsSync(local)) return local;
  } catch {
    // not inside a repo — fall through to home
  }
  return homeCoAuthorsPath();
}

export async function readAuthors(cwd?: string): Promise<CoAuthorSchema> {
  const p = await coAuthorsPath(cwd);
  const txt = await readFile(p, 'utf8');
  const parsed = JSON.parse(txt) as Partial<CoAuthorSchema>;
  if (!parsed || typeof parsed !== 'object' || !parsed.coauthors) {
    throw Errors.usage(`Invalid .git-coauthors at ${p}: missing "coauthors" object`);
  }
  return { coauthors: parsed.coauthors };
}

export async function writeAuthors(schema: CoAuthorSchema, cwd?: string): Promise<void> {
  const p = await coAuthorsPath(cwd);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(schema, null, 2) + '\n', 'utf8');
}

export function schemaToAuthors(schema: CoAuthorSchema): Author[] {
  return Object.entries(schema.coauthors).map(([key, v]) => new Author(key, v.name, v.email));
}

export async function listAuthors(filter?: string, cwd?: string): Promise<Author[]> {
  let schema: CoAuthorSchema;
  try {
    schema = await readAuthors(cwd);
  } catch {
    return [];
  }
  const all = schemaToAuthors(schema);
  if (!filter) return all;
  const f = filter.toLowerCase();
  return all.filter(
    (a) =>
      a.key.toLowerCase().includes(f) ||
      a.name.toLowerCase().includes(f) ||
      a.email.toLowerCase().includes(f),
  );
}

export async function getAuthor(key: string, cwd?: string): Promise<Author> {
  const all = await listAuthors(undefined, cwd);
  const found = all.find((a) => a.key === key);
  if (!found) throw Errors.authorNotFound(key);
  return found;
}

export async function addCoAuthor(author: Author, cwd?: string): Promise<void> {
  if (!validateEmail(author.email)) throw Errors.invalidEmail(author.email);
  let schema: CoAuthorSchema;
  try {
    schema = await readAuthors(cwd);
  } catch {
    schema = { coauthors: {} };
  }
  if (Object.prototype.hasOwnProperty.call(schema.coauthors, author.key)) {
    throw Errors.duplicateKey(author.key);
  }
  schema.coauthors[author.key] = { name: author.name, email: author.email };
  await writeAuthors(schema, cwd);
}
