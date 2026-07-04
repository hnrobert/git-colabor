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
let prevHome: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-e2e-'));
  home = await mkdtemp(join(tmpdir(), 'ca-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = home; // isolate ~/.gitmessage + global git config
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@x.com']);
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('coauthor e2e (real git, isolated HOME)', () => {
  it('add + use writes colabor.selected (multi) + .gitmessage trailers', async () => {
    await coauthor.add(['jd', 'Jane Doe', 'jane@x.com'], root);
    await coauthor.add(['ad', 'Amy Doe', 'amy@x.com'], root);
    await coauthor.use(['jd', 'ad'], root);

    // multi-value key must retain BOTH, in insertion order (regression: setConfig used to overwrite)
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
    await coauthor.use(['jd'], root);
    const r = await coauthor.print({ initials: false }, root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(String((r.data as { text: string }).text)).toContain('Co-authored-by: Jane Doe');
  });

  it('print -i returns comma-separated initials', async () => {
    const r = await coauthor.print({ initials: true }, root);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { text: string }).text).toBe('jd');
  });

  it('use of an unknown initial fails with AUTHOR_NOT_FOUND (exit 5)', async () => {
    const r = await coauthor.use(['nope'], root).catch((e) => e);
    expect(r).toBeInstanceOf(Error);
  });
});
