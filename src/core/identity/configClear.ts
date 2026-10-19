import { getConfig, unsetConfig } from '../git/config.js';

/**
 * Content-based clear: unset the standard git keys that currently match the
 * given identity (repo-local scope). No markers, no backups — we compare
 * what config says against who is being cleared.
 */
export async function clearIdentityConfigLayer(
  identity: { name: string; email: string },
  cwd?: string,
): Promise<boolean> {
  const [n, e, ssh] = await Promise.all([
    getConfig('user.name', 'local', cwd),
    getConfig('user.email', 'local', cwd),
    getConfig('core.sshCommand', 'local', cwd),
  ]);
  const eq = (a: string | undefined, b: string): boolean => !!a && a.trim() === b.trim();
  let cleared = false;
  if (eq(n, identity.name)) {
    await unsetConfig('user.name', 'local', cwd);
    cleared = true;
  }
  if (eq(e, identity.email)) {
    await unsetConfig('user.email', 'local', cwd);
    cleared = true;
  }
  if (ssh) {
    await unsetConfig('core.sshCommand', 'local', cwd);
    cleared = true;
  }
  // signing follows the identity being cleared
  await unsetConfig('commit.gpgsign', 'local', cwd);
  await unsetConfig('gpg.format', 'local', cwd);
  await unsetConfig('user.signingKey', 'local', cwd);
  await unsetConfig('gpg.ssh.program', 'local', cwd);
  return cleared;
}
