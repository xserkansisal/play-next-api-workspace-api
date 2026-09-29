import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Case-insensitive comparison key for names (Unicode-aware, unlike SQLite NOCASE).
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export function compareByName(a: { name: string; id: string }, b: { name: string; id: string }): number {
  const ak = nameKey(a.name);
  const bk = nameKey(b.name);
  if (ak !== bk) return ak < bk ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
