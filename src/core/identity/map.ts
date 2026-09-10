import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Errors } from '../errors.js';
import { mapPath } from '../paths.js';
import { atomicWriteJson } from '../io.js';
import type { Identity, IdentityMap } from '../types.js';

export function genId(): string {
  return 'id_' + randomBytes(4).toString('hex');
}

export async function readMap(): Promise<IdentityMap> {
  try {
    const txt = await readFile(mapPath(), 'utf8');
    const parsed = JSON.parse(txt) as Partial<IdentityMap>;
    return {
      schemaVersion: 1,
      identities: parsed.identities ?? {},
      defaultIdentity: parsed.defaultIdentity,
      hidden: parsed.hidden,
    };
  } catch {
    return { schemaVersion: 1, identities: {} };
  }
}

export async function writeMap(map: IdentityMap): Promise<void> {
  await atomicWriteJson(mapPath(), map, 0o600);
}

export async function getIdentity(id: string): Promise<Identity> {
  const map = await readMap();
  const found = map.identities[id];
  if (!found) throw Errors.usage(`identity "${id}" not found`);
  return found;
}

export type NewIdentity = Omit<Identity, 'id' | 'createdAt'> & { id?: string };

export async function addIdentity(input: NewIdentity): Promise<Identity> {
  const map = await readMap();
  const id = input.id ?? genId();
  if (map.identities[id]) throw Errors.usage(`identity "${id}" already exists`);
  const identity: Identity = { ...input, id, createdAt: new Date().toISOString() };
  map.identities[id] = identity;
  // a manual add of a previously hidden committer un-hides it for future imports
  if (map.hidden?.[identity.email.toLowerCase()]) delete map.hidden[identity.email.toLowerCase()];
  await writeMap(map);
  return identity;
}

/** Patch editable fields of an identity (name/email/key reference). */
export async function updateIdentity(
  id: string,
  patch: Partial<Pick<Identity, 'name' | 'email' | 'sshKeyPath' | 'sshKeyFingerprint' | 'passphraseCommand'>>,
): Promise<Identity> {
  const map = await readMap();
  const identity = map.identities[id];
  if (!identity) throw Errors.usage(`identity "${id}" not found`);
  const next = { ...identity, ...patch };
  // clearing the key reference clears its companions
  if (patch.sshKeyPath === undefined && Object.keys(patch).includes('sshKeyPath')) {
    delete next.sshKeyPath;
    delete next.sshKeyFingerprint;
    delete next.passphraseCommand;
  }
  map.identities[id] = next;
  await writeMap(map);
  return next;
}

/** Hide an email from future auto-imports (hide machine-level). */
export async function hideIdentityEmail(email: string): Promise<void> {
  const map = await readMap();
  map.hidden = { ...map.hidden, [email.toLowerCase()]: true };
  await writeMap(map);
}

export async function removeIdentity(id: string): Promise<void> {
  const map = await readMap();
  if (!map.identities[id]) throw Errors.usage(`identity "${id}" not found`);
  delete map.identities[id];
  if (map.defaultIdentity === id) delete map.defaultIdentity;
  await writeMap(map);
}

export async function setDefault(id: string): Promise<void> {
  const map = await readMap();
  if (!map.identities[id]) throw Errors.usage(`identity "${id}" not found`);
  map.defaultIdentity = id;
  await writeMap(map);
}

export async function listIdentities(): Promise<{ identities: Identity[]; defaultIdentity?: string }> {
  const map = await readMap();
  return { identities: Object.values(map.identities), defaultIdentity: map.defaultIdentity };
}
