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
  await writeMap(map);
  return identity;
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
