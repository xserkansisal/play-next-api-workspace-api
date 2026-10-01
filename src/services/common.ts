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

export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false };

  let end = maxBytes;
  let start = end - 1;
  while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  if (start >= 0) {
    const lead = bytes[start]!;
    const sequenceLength = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (start + sequenceLength > end) end = start;
  }
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export async function resolveAttribution(
  db: DbExecutor,
  createdBy: string | null,
  updatedBy: string | null,
): Promise<{ createdBy: string | null; updatedBy: string | null }> {
  const ids = [...new Set([createdBy, updatedBy].filter((id): id is string => id !== null))];
  if (ids.length === 0) return { createdBy: null, updatedBy: null };
  const rows = await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids));
  const emails = new Map(rows.map((u) => [u.id, u.email]));
  return {
    createdBy: createdBy ? emails.get(createdBy) ?? null : null,
    updatedBy: updatedBy ? emails.get(updatedBy) ?? null : null,
  };
}

// Case-insensitive comparison key for names; the MySQL database uses binary collation after this fold.
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
