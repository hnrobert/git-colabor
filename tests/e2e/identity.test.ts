import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addIdentity, listIdentities } from '../../src/core/identity/map.js';
import { applyIdentity } from '../../src/core/identity/apply.js';
import { revertRepo } from '../../src/core/identity/revert.js';
import { logoutIdentity } from '../../src/core/identity/logout.js';
import { fingerprintOfFile, importKey } from '../../src/core/identity/keys.js';
import { readState, writeState } from '../../src/core/repo/state.js';
import { getConfig } from '../../src/core/git/config.js';
import { cliSessionId, detectConflict } from '../../src/core/repo/coordination.js';
import { readAudit } from '../../src/core/logging/audit.js';
import { repoStatus } from '../../src/core/repo/status.js';

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

let root: string;
let home: string;
let dataDir: string;
let prevHome: string | undefined;
let prevMap: string | undefined;
let prevAudit: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-id-e2e-'));
  home = await mkdtemp(join(tmpdir(), 'ca-id-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'ca-id-data-'));
  prevHome = process.env.HOME;
  prevMap = process.env.GIT_COLABOR_MAP;
  prevAudit = process.env.GIT_COLABOR_AUDIT_FILE;
  process.env.HOME = home; // isolates ~/.gitmessage, global git config, and keysDir()
  process.env.GIT_COLABOR_MAP = join(dataDir, 'identities.json');
  process.env.GIT_COLABOR_AUDIT_FILE = join(dataDir, 'audit.log');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Original Name']);
  git(root, ['config', 'user.email', 'original@x.com']);
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevMap === undefined) delete process.env.GIT_COLABOR_MAP;
  else process.env.GIT_COLABOR_MAP = prevMap;
  if (prevAudit === undefined) delete process.env.GIT_COLABOR_AUDIT_FILE;
  else process.env.GIT_COLABOR_AUDIT_FILE = prevAudit;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('identity e2e (real git + real ssh-keygen)', () => {
  it('adds a name/email-only identity', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    const { identities } = await listIdentities();
    expect(identities.find((i) => i.id === a.id)?.email).toBe('alice@x.com');
  });

  it('applyIdentity writes user.*/markers/state and backs up originals', async () => {
    const b = await addIdentity({ name: 'Bob', email: 'bob@x.com' });
    const { result } = await applyIdentity(b.id, { source: 'cli', cwd: root });
    expect(result.name).toBe('Bob');
    expect(await getConfig('user.name', 'local', root)).toBe('Bob');
    expect(await getConfig('user.email', 'local', root)).toBe('bob@x.com');
    expect(await getConfig('colabor.managed', 'local', root)).toBe('true');
    expect(await getConfig('colabor.managed-by', 'local', root)).toBe('cli');
    const st = await readState(root);
    expect(st.activeIdentity).toBe(b.id);
    expect(st.backups?.userName).toBe('Original Name');
    expect(st.backups?.userEmail).toBe('original@x.com');
  });

  it('repoStatus reports managed + active identity for the current repo', async () => {
    const c = await addIdentity({ name: 'Carol', email: 'carol@x.com' });
    await applyIdentity(c.id, { source: 'cli', cwd: root });
    const rs = await repoStatus(root);
    expect(rs.inRepo).toBe(true);
    expect(rs.managed).toBe(true);
    expect(rs.managedBy).toBe('cli');
    expect(rs.activeIdentityId).toBe(c.id);
  });

  it('audit log records identity.use', async () => {
    const entries = await readAudit();
    expect(entries.some((e) => e.action === 'identity.use' && e.identityName === 'Bob')).toBe(true);
  });

  it('revert restores original user.* and clears markers', async () => {
    const r = await revertRepo({ source: 'cli', cwd: root });
    expect(r.hadBackup).toBe(true);
    expect(await getConfig('user.name', 'local', root)).toBe('Original Name');
    expect(await getConfig('user.email', 'local', root)).toBe('original@x.com');
    expect(await getConfig('colabor.managed', 'local', root)).toBeUndefined();
    const st = await readState(root);
    expect(st.activeIdentity).toBeUndefined();
  });

  it('detectConflict flags a foreign recent heldBy', async () => {
    const st = await readState(root);
    st.heldBy = { session: 'ext:OTHER', since: new Date().toISOString(), host: 'h', osUser: 'u', source: 'ext' };
    await writeState(st, root);
    const conflict = await detectConflict(cliSessionId(), root);
    expect(conflict).not.toBeNull();
    expect(conflict?.heldBy.session).toBe('ext:OTHER');
  });

  it('stale heldBy is not a conflict', async () => {
    const st = await readState(root);
    st.heldBy = {
      session: 'ext:OTHER',
      since: new Date(Date.now() - 60 * 60_000).toISOString(),
      host: 'h',
      osUser: 'u',
      source: 'ext',
    };
    await writeState(st, root);
    expect(await detectConflict(cliSessionId(), root)).toBeNull();
    st.heldBy = undefined;
    await writeState(st, root);
  });

  it('importKey materializes a real key with 0600 + matching fingerprint', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-'));
    const keyPath = join(keyDir, 'id_test');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'test'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    expect(imp.encrypted).toBe(false);
    const st = await stat(imp.path);
    expect(st.mode & 0o777).toBe(0o600);
    expect(await fingerprintOfFile(imp.path)).toBe(imp.fingerprint);
    await rm(keyDir, { recursive: true, force: true });
  });

  it('logout shreds the active identity keyfile', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key2-'));
    const keyPath = join(keyDir, 'id_test');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'test'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const id = await addIdentity({
      name: 'Carol',
      email: 'carol@x.com',
      sshKeyFingerprint: imp.fingerprint,
      sshKeyPath: imp.path,
    });
    const st = await readState(root);
    st.activeIdentity = id.id;
    await writeState(st, root);

    const r = await logoutIdentity({ source: 'cli', cwd: root, id: id.id });
    expect(r.keyfileShredded).toBe(true);
    await expect(access(imp.path)).rejects.toThrow();

    await rm(keyDir, { recursive: true, force: true });
  });
});
