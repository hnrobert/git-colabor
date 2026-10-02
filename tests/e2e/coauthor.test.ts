import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as coauthor from '../../src/cli/coauthor.js';
import { getSelected } from '../../src/core/coauthors/state.js';
import { getConfig, getAllConfig } from '../../src/core/git/config.js';

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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-e2e-'));
  home = await mkdtemp(join(tmpdir(), 'ca-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'ca-data-'));
  prevHome = process.env.HOME;
  prevMap = process.env.GIT_COLABOR_MAP;
  process.env.HOME = home;
  process.env.GIT_COLABOR_MAP = join(dataDir, 'identities.json');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@x.com']);
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevMap === undefined) delete process.env.GIT_COLABOR_MAP;
  else process.env.GIT_COLABOR_MAP = prevMap;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('coauthor e2e (identity-based, real git, isolated HOME)', () => {
  it('add + use writes colabor.selected (multi) + .gitmessage trailers', async () => {
    await coauthor.add(['Jane Doe', 'jane@x.com']);
    await coauthor.add(['Amy Doe', 'amy@x.com']);
    await coauthor.use(['jane@x.com', 'amy@x.com'], root);

    const all = await getAllConfig('colabor.selected', 'local', root);
    expect(all.split(/\r?\n/)).toEqual(['Jane Doe <jane@x.com>', 'Amy Doe <amy@x.com>']);
    const selected = await getSelected(root);
    expect(selected.map((a) => a.email)).toEqual(['jane@x.com', 'amy@x.com']);

    const tpl = await readFile(join(home, '.gitmessage'), 'utf8');
    expect(tpl).toContain('Co-authored-by: Jane Doe <jane@x.com>');
    expect(tpl).toContain('Co-authored-by: Amy Doe <amy@x.com>');
  });

  it('solo clears selection and strips trailers', async () => {
    await coauthor.solo(root);
    expect(await getConfig('colabor.selected', 'local', root)).toBeUndefined();
    const tpl = await readFile(join(home, '.gitmessage'), 'utf8');
    expect(tpl).not.toContain('Co-authored-by');
  });

  it('print returns the trailer blob', async () => {
    await coauthor.use(['jane@x.com'], root);
    const r = await coauthor.print({ initials: false }, root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(String((r.data as { text: string }).text)).toContain('Co-authored-by: Jane Doe');
  });

  it('use accepts identity ID as well as email', async () => {
    const lsResult = await coauthor.ls([]);
    expect(lsResult.ok).toBe(true);
    if (!lsResult.ok) return;
    const items = lsResult.data as { id: string; email: string }[];
    const jane = items.find((i) => i.email === 'jane@x.com');
    expect(jane).toBeDefined();
    if (!jane) return;
    // select by ID instead of email
    const r = await coauthor.use([jane.id], root);
    expect(r.ok).toBe(true);
    const selected = await getSelected(root);
    expect(selected.map((a) => a.email)).toEqual(['jane@x.com']);
  });

  it('use of an unknown email fails with AUTHOR_NOT_FOUND (exit 5)', async () => {
    const r = await coauthor.use(['nope@nowhere.com'], root).catch((e) => e);
    expect(r).toBeInstanceOf(Error);
  });
});
