/**
 * SSH_ASKPASS helper for git-colabor. Invoked by `ssh-add` (and `ssh-keygen`) when
 * SSH_ASKPASS=<this> + SSH_ASKPASS_REQUIRE=force. Reads the bridge env set by identity/agent.ts,
 * resolves the passphrase (extension socket → passphraseCommand), and prints it once to stdout.
 *
 * Bundled separately to dist/askpass.cjs (see tsup.config.ts).
 */
import { askSocket, runPassphraseCommand } from '../core/secrets/askpass-protocol.js';

async function main(): Promise<void> {
  const socketPath = process.env.GIT_COLABOR_ASKPASS_SOCK;
  const token = process.env.GIT_COLABOR_ASKPASS_TOKEN;
  const fingerprint = process.env.GIT_COLABOR_FINGERPRINT;
  const passphraseCommand = process.env.GIT_COLABOR_PASSPHRASE_COMMAND;

  if (socketPath && token && fingerprint) {
    const got = await askSocket(socketPath, token, fingerprint);
    if (got) {
      process.stdout.write(got);
      process.exit(0);
    }
  }
  if (passphraseCommand) {
    const got = await runPassphraseCommand(passphraseCommand);
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
