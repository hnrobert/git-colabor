import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genKey, Author } from '../../src/core/authors/types.js';
import { validateEmail, coAuthorsPath, readAuthors, addCoAuthor } from '../../src/core/authors/store.js';

describe('genKey', () => {
  it('initials + email prefix', () => {
    expect(genKey('Richard Kotze', 'rkotze@x.com')).toBe('rkrk');
    expect(genKey('Tony Stark', '20342323+tony@users.noreply.github.com')).toBe('ts20');
  });
});

describe('validateEmail', () => {
  it('accepts valid emails', () => {
    expect(validateEmail('a@b.co')).toBe(true);
    expect(validateEmail('tony+bot@users.noreply.github.com')).toBe(true);
  });
  it('rejects invalid emails', () => {
    expect(validateEmail('nope')).toBe(false);
    expect(validateEmail('a@')).toBe(false);
  });
});

describe('coAuthorsPath', () => {
  it('env override wins', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ca-path-'));
    const prev = process.env.GIT_COLABOR_COAUTHORS_PATH;
    process.env.GIT_COLABOR_COAUTHORS_PATH = join(d, 'custom.json');
    try {
      expect(await coAuthorsPath()).toBe(join(d, 'custom.json'));
    } finally {
      if (prev === undefined) delete process.env.GIT_COLABOR_COAUTHORS_PATH;
      else process.env.GIT_COLABOR_COAUTHORS_PATH = prev;
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('addCoAuthor + readAuthors', () => {
  it('writes then reads back, pretty-printed', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ca-io-'));
    const prev = process.env.GIT_COLABOR_COAUTHORS_PATH;
    process.env.GIT_COLABOR_COAUTHORS_PATH = join(d, '.git-coauthors');
    try {
      await addCoAuthor(new Author('jd', 'Jane Doe', 'jane@x.com'));
      const schema = await readAuthors();
      expect(schema.coauthors.jd).toEqual({ name: 'Jane Doe', email: 'jane@x.com' });
    } finally {
      if (prev === undefined) delete process.env.GIT_COLABOR_COAUTHORS_PATH;
      else process.env.GIT_COLABOR_COAUTHORS_PATH = prev;
      await rm(d, { recursive: true, force: true });
    }
  });
});
