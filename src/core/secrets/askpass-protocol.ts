import { connect } from 'node:net';
import { spawn } from 'node:child_process';

const SOCKET_TIMEOUT_MS = 3000;

/**
 * Query the extension's askpass UNIX-socket server for a passphrase.
 * Request: a single JSON line `{token, fingerprint}`. Response: the passphrase text, then close.
 * Returns undefined on any failure (so callers fall through).
 */
export function askSocket(socketPath: string, token: string, fingerprint: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | undefined) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const sock = connect(socketPath, () => {
      sock.write(JSON.stringify({ token, fingerprint }) + '\n');
    });
    let data = '';
    sock.on('data', (d) => {
      data += d.toString('utf8');
    });
    sock.on('close', () => done(data.replace(/\r?\n$/, '') || undefined));
    sock.on('error', () => done(undefined));
    setTimeout(() => {
      sock.destroy();
      done(undefined);
    }, SOCKET_TIMEOUT_MS).unref?.();
  });
}

/** Run a user-configured passphrase command (e.g. `op read …`, `pass show …`); stdout = passphrase. */
export function runPassphraseCommand(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.on('error', () => resolve(undefined));
    child.on('close', () => resolve(out.replace(/\r?\n$/, '') || undefined));
  });
}
