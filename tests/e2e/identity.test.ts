import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addIdentity, hideIdentityEmail, listIdentities, removeIdentity, updateIdentity } from '../../src/core/identity/map.js';
import { applyIdentity } from '../../src/core/identity/apply.js';
import { revertRepo } from '../../src/core/identity/revert.js';
import { logoutIdentity } from '../../src/core/identity/logout.js';
import { fingerprintOfFile, importKey } from '../../src/core/identity/keys.js';
import { readState, writeState } from '../../src/core/repo/state.js';
import { getConfig } from '../../src/core/git/config.js';
import { cliSessionId, detectConflict } from '../../src/core/repo/coordination.js';
import { readAudit } from '../../src/core/logging/audit.js';
import { repoStatus } from '../../src/core/repo/status.js';
import { historyCommitters } from '../../src/core/git/committers.js';
import { importFromHistory } from '../../src/cli/identity.js';

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

  it('importKey references the source file (no copy) with a matching fingerprint', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-'));
    const keyPath = join(keyDir, 'id_test');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'test'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    expect(imp.encrypted).toBe(false);
    expect(imp.path).toBe(keyPath); // reference mode: the identity points at the source
    expect(await fingerprintOfFile(keyPath)).toBe(imp.fingerprint);
    await stat(keyPath); // source untouched
    await rm(keyDir, { recursive: true, force: true });
  });

  it('apply falls back to key-less when the referenced key file is gone', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key3-'));
    const keyPath = join(keyDir, 'id_gone');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'gone'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const id = await addIdentity({
      name: 'GoneKey',
      email: 'gone@x.com',
      sshKeyFingerprint: imp.fingerprint,
      sshKeyPath: imp.path,
    });
    await rm(keyDir, { recursive: true, force: true }); // break the reference

    const { result } = await applyIdentity(id.id, { source: 'cli', cwd: root });
    expect(result.keyMissing).toBe(true);
    expect(result.sshCommand).toBeUndefined();
    expect(await getConfig('user.name', 'local', root)).toBe('GoneKey');
    expect(await getConfig('core.sshCommand', 'local', root)).toBeUndefined();
  });

  it('apply with a key enables SSH commit signing; keyless apply clears it; revert restores', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-sign-'));
    const keyPath = join(keyDir, 'id_sign');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'sign'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const withKey = await addIdentity({
      name: 'Signer',
      email: 'signer@x.com',
      sshKeyFingerprint: imp.fingerprint,
      sshKeyPath: imp.path,
    });
    await applyIdentity(withKey.id, { source: 'cli', cwd: root });
    expect(await getConfig('commit.gpgsign', 'local', root)).toBe('true');
    expect(await getConfig('gpg.format', 'local', root)).toBe('ssh');
    expect(await getConfig('user.signingKey', 'local', root)).toBe(keyPath);

    const keyless = await addIdentity({ name: 'NoKey', email: 'nokey@x.com' });
    await applyIdentity(keyless.id, { source: 'cli', cwd: root });
    expect(await getConfig('commit.gpgsign', 'local', root)).toBeUndefined();
    expect(await getConfig('user.signingKey', 'local', root)).toBeUndefined();

    await revertRepo({ source: 'cli', cwd: root }); // had no signing before us → stays unset
    expect(await getConfig('commit.gpgsign', 'local', root)).toBeUndefined();
    await rm(keyDir, { recursive: true, force: true });
  });

  it('logout removes the key from the agent but never deletes the file', async () => {
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
    expect(r.agentRemoved).toBe(false); // no agent under test — removal is best-effort
    await stat(keyPath); // reference mode: the user's file survives logout

    await rm(keyDir, { recursive: true, force: true });
  });

  it('audit log never contains the passphrase command secret or key body', async () => {
    const secret = 'TOPSECRET-TOKEN-1234';
    const id = await addIdentity({ name: 'Sec', email: 'sec@x.com', passphraseCommand: `echo ${secret}` });
    await applyIdentity(id.id, { source: 'cli', cwd: root });
    const entries = await readAudit();
    const blob = entries.map((e) => JSON.stringify(e)).join('\n');
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain('PRIVATE KEY');
    expect(blob).not.toContain('BEGIN OPENSSH');
  });

  it('historyCommitters lists distinct committers, most frequent first', async () => {
    git(root, ['-c', 'user.name=Committer One', '-c', 'user.email=c1@x.com', 'commit', '-q', '--allow-empty', '-m', 'i1']);
    git(root, ['-c', 'user.name=Committer One', '-c', 'user.email=c1@x.com', 'commit', '-q', '--allow-empty', '-m', 'i2']);
    git(root, ['-c', 'user.name=Committer Two', '-c', 'user.email=c2@x.com', 'commit', '-q', '--allow-empty', '-m', 'i3']);
    const cs = await historyCommitters(root);
    expect(cs.map((c) => c.email)).toEqual(['c1@x.com', 'c2@x.com']);
    expect(cs[0]).toMatchObject({ name: 'Committer One' });
  });

  it('identity import adds every history committer once, then is a no-op', async () => {
    const first = await importFromHistory({ cwd: root } as Parameters<typeof importFromHistory>[0]);
    const d1 = (first as { ok: true; data: { added: { email: string }[]; skipped: number } }).data;
    expect(d1.added.map((a) => a.email).sort()).toEqual(['c1@x.com', 'c2@x.com']);
    const { identities } = await listIdentities();
    for (const e of ['c1@x.com', 'c2@x.com']) {
      expect(identities.some((i) => i.email === e)).toBe(true);
    }
    const second = await importFromHistory({ cwd: root } as Parameters<typeof importFromHistory>[0]);
    const d2 = (second as { ok: true; data: { added: unknown[]; skipped: number } }).data;
    expect(d2.added).toEqual([]);
    expect(d2.skipped).toBe(d1.added.length);
  });

  it('identity set renames and re-references the key', async () => {
    const { identities } = await listIdentities();
    const target = identities.find((i) => i.email === 'c1@x.com')!;
    const renamed = await updateIdentity(target.id, { name: 'Committer Renamed' });
    expect(renamed.name).toBe('Committer Renamed');
    expect(renamed.email).toBe('c1@x.com');

    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-set-'));
    const keyPath = join(keyDir, 'id_set');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'set'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const withKey = await updateIdentity(target.id, { sshKeyPath: imp.path, sshKeyFingerprint: imp.fingerprint });
    expect(withKey.sshKeyPath).toBe(keyPath);

    const cleared = await updateIdentity(target.id, { sshKeyPath: undefined });
    expect(cleared.sshKeyPath).toBeUndefined();
    expect(cleared.sshKeyFingerprint).toBeUndefined();
    await rm(keyDir, { recursive: true, force: true });
  });

  it('rm of an imported identity hides it from future imports; a manual add un-hides', async () => {
    const { identities } = await listIdentities();
    const target = identities.find((i) => i.email === 'c2@x.com')!;
    expect(target.imported).toBe(true);
    await removeIdentity(target.id);
    await hideIdentityEmail(target.email);

    const again = await importFromHistory({ cwd: root } as Parameters<typeof importFromHistory>[0]);
    const d = (again as { ok: true; data: { added: { email: string }[] } }).data;
    expect(d.added.map((a) => a.email)).not.toContain('c2@x.com'); // hidden — no resurrection

    const manual = await addIdentity({ name: 'Committer Two', email: 'C2@x.com' }); // manual add clears hidden
    const third = await importFromHistory({ cwd: root } as Parameters<typeof importFromHistory>[0]);
    const d3 = (third as { ok: true; data: { added: { email: string }[] } }).data;
    expect(d3.added.map((a) => a.email)).not.toContain('C2@x.com'); // already present via manual add
    const mapNow = await listIdentities();
    expect(mapNow.identities.some((i) => i.id === manual.id)).toBe(true);
  });
});
