import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { users } from "../db/schema.js";
import type { DbExecutor } from "./tree.js";

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function resolveAttribution(
  db: DbExecutor,
  createdBy: string | null,
  updatedBy: string | null,
): { createdBy: string | null; updatedBy: string | null } {
  const ids = [...new Set([createdBy, updatedBy].filter((id): id is string => id !== null))];
  if (ids.length === 0) return { createdBy: null, updatedBy: null };
  const emails = new Map(db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids)).all().map((u) => [u.id, u.email]));
  return {
    createdBy: createdBy ? emails.get(createdBy) ?? null : null,
    updatedBy: updatedBy ? emails.get(updatedBy) ?? null : null,
  };
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
