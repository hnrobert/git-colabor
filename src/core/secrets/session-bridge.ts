import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.js';

/**
 * All live candidate bridges from session-*.json in the data dir, NEWEST
 * first: {socketPath, token} per running extension instance. Several
 * instances coexist routinely — multiple windows, exthost restarts — each
 * with its OWN in-memory session store, so the newest bridge is not
 * necessarily the one holding a given passphrase. Callers fall through the
 * list until one answers.
 */
export function discoverSessionBridges(): { socketPath: string; token: string }[] {
  try {
    const dir = dataDir();
    const sessions = readdirSync(dir)
      .filter((f) => /^session-.*\.json$/.test(f))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const out: { socketPath: string; token: string }[] = [];
    for (const s of sessions) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, s.f), 'utf8')) as {
          socketPath?: string;
          token?: string;
        };
        if (parsed.socketPath && parsed.token) out.push({ socketPath: parsed.socketPath, token: parsed.token });
      } catch {
        // unreadable session file — skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Newest session-*.json in the data dir: {socketPath, token} of the extension's
 * askpass bridge, if one is running on this host. Shared by apply (decide
 * whether baking the SSH_ASKPASS prefix into core.sshCommand can ever pay off).
 */
export function discoverSessionBridge(): { socketPath: string; token: string } | undefined {
  return discoverSessionBridges()[0];
}
