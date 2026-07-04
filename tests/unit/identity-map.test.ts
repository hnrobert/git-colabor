import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addIdentity,
  genId,
  getIdentity,
  listIdentities,
  readMap,
  removeIdentity,
  setDefault,
} from '../../src/core/identity/map.js';

let dir: string;
let prev: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ca-map-'));
  prev = process.env.GIT_COLABOR_MAP;
  process.env.GIT_COLABOR_MAP = join(dir, 'identities.json');
});

afterEach(async () => {
  if (prev === undefined) delete process.env.GIT_COLABOR_MAP;
  else process.env.GIT_COLABOR_MAP = prev;
  await rm(dir, { recursive: true, force: true });
});

describe('identity map', () => {
  it('genId is prefixed + 8 hex', () => {
    expect(genId()).toMatch(/^id_[0-9a-f]{8}$/);
  });

  it('add + get round-trips', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    expect(a.id).toMatch(/^id_/);
    const got = await getIdentity(a.id);
    expect(got.email).toBe('alice@x.com');
    expect(got.createdAt.length).toBeGreaterThan(0);
  });

  it('list + setDefault', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    await setDefault(a.id);
    const { identities, defaultIdentity } = await listIdentities();
    expect(identities).toHaveLength(1);
    expect(defaultIdentity).toBe(a.id);
  });

  it('remove deletes and clears default', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    await setDefault(a.id);
    await removeIdentity(a.id);
    const { identities, defaultIdentity } = await listIdentities();
    expect(identities).toHaveLength(0);
    expect(defaultIdentity).toBeUndefined();
  });

  it('persists across reads (atomic write)', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    expect((await readMap()).identities[a.id]).toBeDefined();
  });

  it('writes the map file mode 0600', async () => {
    await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    const st = await stat(join(dir, 'identities.json'));
    expect(st.mode & 0o777).toBe(0o600);
  });
});
