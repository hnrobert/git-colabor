/**
 * SSH_ASKPASS helper for git-colabor. Invoked by `ssh-add`, `ssh-keygen` and
 * `ssh` (at push/fetch time via the SSH_ASKPASS prefix baked into
 * core.sshCommand) when SSH_ASKPASS=<this> + SSH_ASKPASS_REQUIRE=force.
 *
 * Two modes:
 *  - bridge env present (GIT_COLABOR_ASKPASS_SOCK/TOKEN/FINGERPRINT, set by
 *    identity/agent.ts for the ssh-add flow) → query the extension socket
 *    directly;
 *  - bare mode (push-time `ssh -i <key>` knows nothing about us) → parse the
 *    key path out of the prompt, fingerprint it with ssh-keygen, and discover
 *    the newest session-*.json for the socket/token.
 *
 * Bundled separately to dist/askpass.cjs (see tsup.config.ts).
 */
import { spawnSync } from 'node:child_process';
import { askSocket } from '../core/secrets/askpass-protocol.js';
import { discoverSessionBridge } from '../core/secrets/session-bridge.js';

/** Fingerprint of a key file via `ssh-keygen -lf`, or undefined. */
function fingerprintOf(path: string): string | undefined {
  const r = spawnSync('ssh-keygen', ['-lf', path], { encoding: 'utf8' });
  const m = r.stdout.match(/SHA256:[A-Za-z0-9+/=]+/);
  return m?.[0];
}

async function main(): Promise<void> {
  let socketPath = process.env.GIT_COLABOR_ASKPASS_SOCK;
  let token = process.env.GIT_COLABOR_ASKPASS_TOKEN;
  let fingerprint = process.env.GIT_COLABOR_FINGERPRINT;

  // push-time bare mode: prompt is argv[1], e.g. Enter passphrase for key '/home/x/k':
  if (!fingerprint) {
    const prompt = process.argv[2] ?? '';
    const keyPath = prompt.match(/for key '([^']+)'/)?.[1];
    if (keyPath) fingerprint = fingerprintOf(keyPath);
    if (!socketPath || !token) {
      const session = discoverSessionBridge();
      if (session) {
        socketPath ??= session.socketPath;
        token ??= session.token;
      }
    }
  }

  if (socketPath && token && fingerprint) {
    const got = await askSocket(socketPath, token, fingerprint);
    if (got) {
      process.stdout.write(got);
      process.exit(0);
    }
  }
  process.stderr.write('git-colabor askpass: no passphrase available\n');
  process.exit(1);
}

main().catch((e: unknown) => {
  process.stderr.write(`git-colabor askpass error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
