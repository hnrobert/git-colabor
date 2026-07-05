import { getConfig } from '../git/config.js';
import { insideWorkTree } from '../git/rev.js';
import { getSelected } from '../coauthors/state.js';
import { listAuthors } from '../authors/store.js';
import { readState } from './state.js';
import type { HeldBy } from '../types.js';

export type CoAuthorBrief = { key: string; name: string; email: string };

export type RepoStatus = {
  inRepo: boolean;
  repo: string | null;
  managed: boolean;
  managedBy: string | null;
  activeIdentityId: string | null;
  heldBy: HeldBy | null;
  selected: CoAuthorBrief[];
  available: CoAuthorBrief[];
};

/**
 * Snapshot of a repo's colabor state: managed markers, active identity, selected + available
 * co-authors. Used by the CLI `identity status` command and (transitively) the extension TreeView.
 */
export async function repoStatus(cwd?: string): Promise<RepoStatus> {
  const inRepo = cwd ? await insideWorkTree(cwd) : false;
  if (!inRepo) {
    return {
      inRepo: false,
      repo: cwd ?? null,
      managed: false,
      managedBy: null,
      activeIdentityId: null,
      heldBy: null,
      selected: [],
      available: [],
    };
  }
  const [managed, managedBy, state, selected] = await Promise.all([
    getConfig('colabor.managed', 'local', cwd),
    getConfig('colabor.managed-by', 'local', cwd),
    readState(cwd),
    getSelected(cwd),
  ]);
  const allAuthors = await listAuthors(undefined, cwd);
  const selectedEmails = new Set(selected.map((a) => a.email));
  const available = allAuthors.filter((a) => !selectedEmails.has(a.email)).map(toBrief);
  return {
    inRepo: true,
    repo: cwd as string,
    managed: managed === 'true',
    managedBy: managedBy ?? null,
    activeIdentityId: state.activeIdentity ?? null,
    heldBy: state.heldBy ?? null,
    selected: selected.map(toBrief),
    available,
  };
}

function toBrief(a: { key: string; name: string; email: string }): CoAuthorBrief {
  return { key: a.key, name: a.name, email: a.email };
}
