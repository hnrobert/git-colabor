import { gitRaw } from './exec.js';

export type Committer = { name: string; email: string };

/**
 * Distinct committers in the repo history (`git log --format=%cn%x1f%ce`),
 * most frequent first, deduped by email (case-insensitive).
 */
export async function historyCommitters(cwd?: string): Promise<Committer[]> {
  const r = await gitRaw(['log', '--format=%cn%x1f%ce'], { cwd });
  if (r.exitCode !== 0) return [];
  const counts = new Map<string, { name: string; email: string; count: number }>();
  for (const line of r.stdout.split('\n')) {
    const sep = line.indexOf('\x1f');
    if (sep < 0) continue;
    const name = line.slice(0, sep).trim();
    const email = line.slice(sep + 1).trim();
    if (!name || !email) continue;
    const key = email.toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { name, email, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).map(({ name, email }) => ({ name, email }));
}
