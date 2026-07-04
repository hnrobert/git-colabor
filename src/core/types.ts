/**
 * Core data model & shared types for git-colabor.
 * Author lives in `./authors/types.ts`; this module holds everything else.
 */

export type Source = 'ext' | 'cli';

export type Identity = {
  /** stable opaque id, e.g. "id_" + 8 hex (NOT the fingerprint) */
  id: string;
  name: string;
  email: string;
  /** "SHA256:…" from `ssh-keygen -lf` */
  sshKeyFingerprint?: string;
  /** defaults to ~/.config/git-colabor/keys/<fingerprint> */
  sshKeyPath?: string;
  /** shell command whose stdout is the passphrase (escape hatch for pure-CLI) */
  passphraseCommand?: string;
  /** informational, e.g. "github.com" */
  host?: string;
  /** ISO8601 */
  createdAt: string;
};

export type IdentityMap = {
  schemaVersion: 1;
  identities: Record<string, Identity>;
  defaultIdentity?: string;
};

export type HeldBy = {
  /** ext: vscode sessionId ; cli: `cli:<pid>@<host>` */
  session: string;
  /** ISO8601 */
  since: string;
  host: string;
  osUser: string;
  source: Source;
};

export type Backups = {
  /** undefined ⇒ originally unset */
  userName?: string;
  userEmail?: string;
  sshCommand?: string;
  commitTemplate?: string;
};

export type RepoState = {
  schemaVersion: 1;
  activeIdentity?: string;
  heldBy?: HeldBy;
  /** captured on first touch */
  backups?: Backups;
};

export type AuditAction =
  | 'identity.use'
  | 'identity.logout'
  | 'identity.revert'
  | 'coauthor.use'
  | 'coauthor.solo'
  | 'key.load'
  | 'key.remove'
  | 'secret.store'
  | 'secret.delete';

export type AuditEntry = {
  ts: string;
  action: AuditAction;
  identity?: string;
  identityName?: string;
  /** SSH key fingerprint only — never the key/passphrase */
  fingerprint?: string;
  repo?: string;
  sha?: string;
  host: string;
  osUser: string;
  source: Source;
  result: 'ok' | 'warn' | 'error';
  /** redacted */
  message?: string;
};

export type Warning = { code: string; message: string; details?: unknown };

export type ErrorPayload = {
  code: string;
  message: string;
  hints?: string[];
  exitCode: number;
};

export type JsonResult =
  | { ok: true; data: unknown; warnings?: Warning[] }
  | { ok: false; error: ErrorPayload; data: null };

export type Diagnostic = { check: string; status: 'ok' | 'warn' | 'fail'; detail?: string };
