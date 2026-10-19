import { getConfig, unsetConfig } from '../git/config.js';
import type { SignKeyRef } from '../types.js';

/** strip a `.pub` suffix — signing via the agent uses the public half */
const bare = (p: string): string => p.trim().replace(/\.pub$/, '');

/** does an sshCommand reference the given key path (`ssh -i <key> …`)? */
const sshCommandUses = (command: string, keyPath: string): boolean => command.includes(bare(keyPath));

/** does a configured signing key belong to the identity (SSH path or GPG fingerprint)? */
function signingKeyOwned(configured: string, keys: { sshPaths: string[]; gpgFingerprint?: string }): boolean {
  const value = configured.trim();
  if (!value) return false;
  if (keys.sshPaths.some((p) => bare(p) === bare(value))) return true;
  if (keys.gpgFingerprint) {
    // a GPG key id matches the tail of its fingerprint
    const hex = (k: string) => (/^(0x)?[0-9a-f]{8,}!?$/i.test(k) ? k.replace(/^0x/i, '').replace(/!$/, '').toUpperCase() : undefined);
    const a = hex(value);
    const b = hex(keys.gpgFingerprint);
    if (a && b && (a.endsWith(b) || b.endsWith(a))) return true;
  }
  return false;
}

export type ClearedConfig = {
  /** the identity's name/email was removed from config */
  identityLayer: boolean;
  /** core.sshCommand was removed */
  sshCommand: boolean;
  /** the signing keys (user.signingKey + friends) were removed */
  signing: boolean;
};

/**
 * Content-based clear: unset the standard git keys that belong to the given
 * identity (repo-local scope). No markers, no backups — we compare what
 * config says against who is being cleared. Name/email clear on an exact
 * match ONLY (another person's committer config always survives); the KEY
 * configs clear when they reference one of the identity's keys — so a
 * logout also removes keys a previous `use` left behind after the repo
 * moved on to someone else. `forceKeys` (the identity is the config-derived
 * active one) drops the key configs even when they no longer match any
 * bound key.
 */
export async function clearIdentityConfigLayer(
  identity: { name: string; email: string; pushKeyPath?: string; signKey?: SignKeyRef },
  opts: { cwd?: string; forceKeys?: boolean } = {},
): Promise<ClearedConfig> {
  const forceKeys = opts.forceKeys === true;
  const sshPaths = [
    ...(identity.pushKeyPath ? [identity.pushKeyPath] : []),
    ...(identity.signKey?.format === 'ssh' ? [identity.signKey.path] : []),
  ];
  const gpgFingerprint = identity.signKey?.format === 'openpgp' ? identity.signKey.key : undefined;

  const [n, e, ssh, signKey, sshProgram] = await Promise.all([
    getConfig('user.name', 'local', opts.cwd),
    getConfig('user.email', 'local', opts.cwd),
    getConfig('core.sshCommand', 'local', opts.cwd),
    getConfig('user.signingKey', 'local', opts.cwd),
    getConfig('gpg.ssh.program', 'local', opts.cwd),
  ]);
  const eq = (a: string | undefined, b: string): boolean => !!a && a.trim() === b.trim();

  const result: ClearedConfig = { identityLayer: false, sshCommand: false, signing: false };

  if (eq(n, identity.name)) {
    await unsetConfig('user.name', 'local', opts.cwd);
    result.identityLayer = true;
  }
  if (eq(e, identity.email)) {
    await unsetConfig('user.email', 'local', opts.cwd);
    result.identityLayer = true;
  }
  if (ssh && (forceKeys || sshPaths.some((p) => sshCommandUses(ssh, p)))) {
    await unsetConfig('core.sshCommand', 'local', opts.cwd);
    result.sshCommand = true;
  }
  // signing keys ride along with a matching user.signingKey (or a forced
  // clear): gpg.format / gpg.ssh.program / commit.gpgsign only matter as a
  // set, and colabor's own sign wrapper is always ours to remove
  const wrapperIsOurs = !!sshProgram && sshProgram.includes('git-colabor');
  if (signKey && (forceKeys || signingKeyOwned(signKey, { sshPaths, gpgFingerprint }))) {
    await unsetConfig('user.signingKey', 'local', opts.cwd);
    result.signing = true;
  }
  if (result.signing || wrapperIsOurs || forceKeys) {
    await unsetConfig('gpg.format', 'local', opts.cwd);
    await unsetConfig('gpg.ssh.program', 'local', opts.cwd);
    await unsetConfig('commit.gpgsign', 'local', opts.cwd);
  }
  return result;
}
