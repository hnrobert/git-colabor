import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.js';

/**
 * Newest session-*.json in the data dir: {socketPath, token} of the extension's
 * askpass bridge, if one is running on this host. Shared by the standalone
 * askpass helper (bare mode) and by apply (decide whether baking the
 * SSH_ASKPASS prefix into core.sshCommand can ever pay off).
 */
export function discoverSessionBridge(): { socketPath: string; token: string } | undefined {
  try {
    const dir = dataDir();
    const sessions = readdirSync(dir)
      .filter((f) => /^session-.*\.json$/.test(f))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (sessions.length === 0) return undefined;
    const parsed = JSON.parse(readFileSync(join(dir, sessions[0].f), 'utf8')) as {
      socketPath?: string;
      token?: string;
    };
    if (parsed.socketPath && parsed.token) return { socketPath: parsed.socketPath, token: parsed.token };
    return undefined;
  } catch {
    return undefined;
  }
}
