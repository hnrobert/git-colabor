import { addConfigValue, getAllConfig, unsetAllConfig } from '../git/config.js';
import { listAuthors } from '../authors/store.js';
import { Author } from '../authors/types.js';
import { writeCoAuthorsToTemplate, clearTemplate, ensureCommitTemplate } from '../message/template.js';

/** Per-repo selected co-authors, stored as a local multi-value git config key. */
const KEY = 'colabor.selected';
const LINE_RE = /^(.*)\s<([^>]+)>$/;

export async function getSelected(cwd?: string): Promise<Author[]> {
  const raw = (await getAllConfig(KEY, 'local', cwd))
    .split(/\r?\n/)
    .filter(Boolean);
  if (raw.length === 0) return [];
  const all = await listAuthors(undefined, cwd);
  const out: Author[] = [];
  for (const line of raw) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const name = m[1].trim();
    const email = m[2].trim();
    const found = all.find((a) => a.email === email);
    out.push(found ?? new Author(email.split('@')[0] || 'co', name, email));
  }
  return out;
}

/** Replace the per-repo selection and refresh the commit template (dual local/global). */
export async function setSelected(authors: Author[], cwd?: string): Promise<void> {
  await unsetAllConfig(KEY, 'local', cwd);
  for (const a of authors) await addConfigValue(KEY, a.toString(), 'local', cwd);
  await ensureCommitTemplate(cwd);
  await writeCoAuthorsToTemplate(authors, cwd);
}

export async function clearSelected(cwd?: string): Promise<void> {
  await unsetAllConfig(KEY, 'local', cwd);
  await ensureCommitTemplate(cwd);
  await clearTemplate(cwd);
}
