import { gitRaw } from './exec.js';
import { Author, genKey } from '../authors/types.js';

const SHORTLOG_LINE = /^\d+\t(.+)\s<(.+)>$/;

/**
 * Enumerate contributors of the current repo via `git shortlog -seni HEAD`.
 * Optionally filter by author substring.
 */
export async function repoAuthors(filter?: string, cwd?: string): Promise<Author[]> {
  const args = ['shortlog', '-seni', 'HEAD'];
  if (filter) args.splice(1, 0, `--author=${filter}`);
  const r = await gitRaw(args, { cwd });
  if (r.exitCode !== 0) return [];
  const out: Author[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(SHORTLOG_LINE);
    if (!m) continue;
    const name = m[1].trim();
    const email = m[2].trim();
    out.push(new Author(genKey(name, email), name, email));
  }
  return out;
}
