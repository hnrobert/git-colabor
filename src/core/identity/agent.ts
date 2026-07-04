import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type LoadKeyOpts = {
  keyPath: string;
  fingerprint: string;
  /** absolute path to the bundled askpass.cjs */
  askpassScriptPath?: string;
  socketPath?: string;
  token?: string;
  passphraseCommand?: string;
  useAppleKeychain?: boolean;
};

export type LoadResult = { loaded: boolean; via: 'plain' | 'apple-keychain' | 'askpass' | 'tty' | 'none'; message?: string };

function runInherit(cmdArgs: string[], env?: NodeJS.ProcessEnv, stdinNull = false): Promise<number> {
  return new Promise((resolve) => {
    const [cmd, ...args] = cmdArgs;
    const child = spawn(cmd, args, {
      env: env ?? process.env,
      stdio: [stdinNull ? 'ignore' : 'inherit', 'inherit', 'pipe'],
    });
    child.on('error', () => resolve(127));
    child.on('close', (c) => resolve(c ?? 127));
  });
}

function hasBin(bin: string): boolean {
  if (process.platform === 'win32') {
    return spawnSync('where', [bin]).status === 0;
  }
  // `command` is a shell builtin; run a single command string (no args+shell) to avoid Node DEP0190.
  return spawnSync(`command -v ${bin}`, { shell: true }).status === 0;
}

async function supportsAppleKeychain(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const r = await runBinQuiet('ssh-add', ['-h']);
  return r.includes('--apple-use-keychain');
}

async function runBinQuiet(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

/**
 * Load a key into ssh-agent. Tries, in order: plain load (covers passphraseless / already-loaded),
 * macOS keychain, SSH_ASKPASS bridge (socket/passphraseCommand), then interactive tty.
 * Never throws — returns a LoadResult so callers can warn without failing.
 */
export async function loadKey(opts: LoadKeyOpts): Promise<LoadResult> {
  if (!existsSync(opts.keyPath)) return { loaded: false, via: 'none', message: 'key file missing' };

  // 1. plain (passphraseless or already in agent)
  let code = await runInherit(['ssh-add', opts.keyPath], undefined, !process.stdin.isTTY);
  if (code === 0) return { loaded: true, via: 'plain' };

  // 2. macOS keychain
  if (opts.useAppleKeychain && (await supportsAppleKeychain())) {
    code = await runInherit(['ssh-add', '--apple-use-keychain', opts.keyPath]);
    if (code === 0) return { loaded: true, via: 'apple-keychain' };
  }

  // 3. SSH_ASKPASS bridge (non-interactive; passphrase never on argv / never ps-visible)
  const haveSource = (opts.socketPath && opts.token) || opts.passphraseCommand;
  if (opts.askpassScriptPath && haveSource) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.SSH_ASKPASS = opts.askpassScriptPath;
    env.SSH_ASKPASS_REQUIRE = 'force';
    env.DISPLAY = env.DISPLAY ?? ':0';
    if (opts.socketPath) env.GIT_COLABOR_ASKPASS_SOCK = opts.socketPath;
    if (opts.token) env.GIT_COLABOR_ASKPASS_TOKEN = opts.token;
    if (opts.passphraseCommand) env.GIT_COLABOR_PASSPHRASE_COMMAND = opts.passphraseCommand;
    env.GIT_COLABOR_FINGERPRINT = opts.fingerprint;
    const useSetsid = process.platform !== 'win32' && hasBin('setsid');
    code = await runInherit(useSetsid ? ['setsid', 'ssh-add', opts.keyPath] : ['ssh-add', opts.keyPath], env, true);
    if (code === 0) return { loaded: true, via: 'askpass' };
    return { loaded: false, via: 'askpass', message: `ssh-add exited ${code}` };
  }

  // 4. interactive tty
  if (process.stdin.isTTY) {
    code = await runInherit(['ssh-add', opts.keyPath]);
    if (code === 0) return { loaded: true, via: 'tty' };
    return { loaded: false, via: 'tty', message: `ssh-add exited ${code}` };
  }

  return { loaded: false, via: 'none', message: 'no passphrase source and no tty' };
}

/** `ssh-add -l` output ("" if agent unavailable or no identities). */
export async function listAgent(): Promise<string> {
  return runBinQuiet('ssh-add', ['-l']);
}

/** Remove a key from the agent (`ssh-add -d <key>`). */
export async function removeKey(keyPath: string): Promise<boolean> {
  const code = await runInherit(['ssh-add', '-d', keyPath], undefined, true);
  return code === 0;
}
