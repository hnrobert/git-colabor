export type GlobalFlags = {
  json: boolean;
  noColor: boolean;
  help: boolean;
  version: boolean;
  logLevel?: string;
  cwd?: string;
};

export type Parsed = {
  subgroup?: string;
  command?: string;
  args: string[];
  flags: GlobalFlags;
  /** per-command dash flags not consumed as globals (e.g. -i / --initials). */
  localFlags: string[];
};

export function parseArgv(argv: string[]): Parsed {
  const flags: GlobalFlags = { json: false, noColor: false, help: false, version: false };
  const positionals: string[] = [];
  const localFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok) continue;
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok === '-C') {
      flags.cwd = argv[++i];
      continue;
    }
    if (tok.startsWith('-C') && tok.length > 2) {
      flags.cwd = tok.slice(2);
      continue;
    }
    if (tok === '--log-level') {
      flags.logLevel = argv[++i];
      continue;
    }
    if (tok.startsWith('--log-level=')) {
      flags.logLevel = tok.slice('--log-level='.length);
      continue;
    }
    if (tok === '--json') {
      flags.json = true;
      continue;
    }
    if (tok === '--no-color') {
      flags.noColor = true;
      continue;
    }
    if (tok === '-h' || tok === '--help') {
      flags.help = true;
      continue;
    }
    if (tok === '-v' || tok === '--version') {
      flags.version = true;
      continue;
    }
    if (tok.startsWith('-')) {
      const key = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
      localFlags.push(key);
      continue;
    }
    positionals.push(tok);
  }

  return {
    subgroup: positionals[0],
    command: positionals[1],
    args: positionals.slice(2),
    flags,
    localFlags,
  };
}
