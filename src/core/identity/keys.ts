import { readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { runBin } from '../git/exec.js';
import { AppError } from '../errors.js';
import { keyFilePath, keysDir } from '../paths.js';

const FP_RE = /SHA256:[A-Za-z0-9+/=]+/;

/** Fingerprint of a key file via `ssh-keygen -lf` → "SHA256:…". */
export async function fingerprintOfFile(path: string): Promise<string> {
  const r = await runBin('ssh-keygen', ['-lf', path]);
  if (r.exitCode !== 0) {
    throw new AppError({
      code: 'KEY_READ_FAILED',
      message: `cannot read key fingerprint: ${r.stderr.trim() || 'ssh-keygen failed'}`,
    });
  }
  const m = r.stdout.match(FP_RE);
  if (!m) throw new AppError({ code: 'KEY_READ_FAILED', message: `unparseable ssh-keygen output: ${r.stdout}` });
  return m[0];
}

/**
 * Whether a key is passphrase-protected. Probe: `ssh-keygen -y -P "" -f key`
 * exits 0 for an unencrypted key, non-zero for an encrypted (or unreadable) one.
 */
export async function isEncrypted(path: string): Promise<boolean> {
  const r = await runBin('ssh-keygen', ['-y', '-P', '', '-f', path]);
  return r.exitCode !== 0;
}

/** Write key bytes to ~/.config/git-colabor/keys/<fingerprint> (mode 0600), return path + fingerprint. */
export async function materializeKey(privateKeyPem: string): Promise<{ path: string; fingerprint: string }> {
  await mkdir(keysDir(), { recursive: true });
  const tmp = join(keysDir(), `.import.${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, privateKeyPem.endsWith('\n') ? privateKeyPem : privateKeyPem + '\n', 'utf8');
  await chmod(tmp, 0o600);
  const fingerprint = await fingerprintOfFile(tmp);
  const dest = keyFilePath(fingerprint);
  await rename(tmp, dest);
  await chmod(dest, 0o600).catch(() => {});
  return { path: dest, fingerprint };
}

/** Import a key from a source path: materialize + report fingerprint + encrypted flag. */
export async function importKey(sourcePath: string): Promise<{ path: string; fingerprint: string; encrypted: boolean }> {
  const pem = await readFile(sourcePath, 'utf8');
  const { path, fingerprint } = await materializeKey(pem);
  const encrypted = await isEncrypted(path);
  return { path, fingerprint, encrypted };
}
