import { describe, it, expect } from 'vitest';
import { parseArgv } from '../../src/cli/parse-args.js';

describe('parseArgv', () => {
  it('parses subgroup + command + args', () => {
    const p = parseArgv(['coauthor', 'use', 'jd', 'ea']);
    expect(p.subgroup).toBe('coauthor');
    expect(p.command).toBe('use');
    expect(p.args).toEqual(['jd', 'ea']);
    expect(p.localFlags).toEqual([]);
  });

  it('global --json flag', () => {
    expect(parseArgv(['--json', 'coauthor', 'ls']).flags.json).toBe(true);
  });

  it('-C takes the next token', () => {
    const p = parseArgv(['-C', '/tmp', 'coauthor', 'ls']);
    expect(p.flags.cwd).toBe('/tmp');
    expect(p.command).toBe('ls');
  });

  it('-C attached form', () => {
    expect(parseArgv(['-C/tmp', 'coauthor', 'ls']).flags.cwd).toBe('/tmp');
  });

  it('collects per-command dash flags into localFlags', () => {
    const p = parseArgv(['coauthor', 'print', '-i']);
    expect(p.command).toBe('print');
    expect(p.localFlags).toContain('-i');
  });

  it('-- terminator makes the rest positional', () => {
    const p = parseArgv(['coauthor', 'add', '--', '-weird', 'Name', 'e@x.com']);
    expect(p.args).toEqual(['-weird', 'Name', 'e@x.com']);
  });

  it('--log-level=value', () => {
    const p = parseArgv(['--log-level=debug', 'coauthor', 'ls']);
    expect(p.flags.logLevel).toBe('debug');
  });
});
