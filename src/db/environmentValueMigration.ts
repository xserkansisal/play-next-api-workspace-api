import { and, eq, isNull, like } from "drizzle-orm";
import type { RowDataPacket } from "mysql2/promise";
import type { AppDatabase } from "./client.js";
import { environmentVariables } from "./schema.js";
import { decryptEnvironmentValue, encryptEnvironmentValue, encryptionKeyId } from "../services/secretValues.js";

const BATCH_SIZE = 500;

async function encryptLegacyValues(db: AppDatabase, encryptionKey: string): Promise<void> {
  while (true) {
    const rows = await db.select({
      environmentId: environmentVariables.environmentId,
      position: environmentVariables.position,
      value: environmentVariables.value,
    })
      .from(environmentVariables)
      .where(isNull(environmentVariables.valueEncryptionVersion))
      .limit(BATCH_SIZE);
    if (rows.length === 0) return;

    await db.transaction(async (tx) => {
      for (const row of rows) {
        await tx.update(environmentVariables)
          .set({
            value: encryptEnvironmentValue(row.value, encryptionKey),
            valueEncryptionVersion: 1,
          })
          .where(and(
            eq(environmentVariables.environmentId, row.environmentId),
            eq(environmentVariables.position, row.position),
            isNull(environmentVariables.valueEncryptionVersion),
          ));
      }
    });
  }
}

async function rotatePreviousKeyValues(
  db: AppDatabase,
  encryptionKey: string,
  previousKey: string,
): Promise<void> {
  if (encryptionKeyId(previousKey) === encryptionKeyId(encryptionKey)) return;
  const previousPrefix = `v1:${encryptionKeyId(previousKey)}:%`;
  while (true) {
    const rows = await db.select({
      environmentId: environmentVariables.environmentId,
      position: environmentVariables.position,
      value: environmentVariables.value,
      valueEncryptionVersion: environmentVariables.valueEncryptionVersion,
    })
      .from(environmentVariables)
      .where(and(
        eq(environmentVariables.valueEncryptionVersion, 1),
        like(environmentVariables.value, previousPrefix),
      ))
      .limit(BATCH_SIZE);
    if (rows.length === 0) return;

    await db.transaction(async (tx) => {
      for (const row of rows) {
        const decrypted = decryptEnvironmentValue(row.value, row.valueEncryptionVersion, encryptionKey, previousKey);
        await tx.update(environmentVariables)
          .set({
            value: encryptEnvironmentValue(decrypted.value, encryptionKey),
            valueEncryptionVersion: 1,
          })
          .where(and(
            eq(environmentVariables.environmentId, row.environmentId),
            eq(environmentVariables.position, row.position),
          ));
      }
    });
  }
}

export async function migrateEnvironmentValues(
  db: AppDatabase,
  encryptionKey: string,
  previousKey?: string,
): Promise<void> {
  const [keyRows] = await db.$client.query<Array<RowDataPacket & { key_id: string }>>(
    "SELECT DISTINCT SUBSTRING_INDEX(SUBSTRING_INDEX(value, ':', 2), ':', -1) AS key_id " +
      "FROM environment_variables WHERE value_encryption_version = 1",
  );
  const knownKeyIds = new Set([encryptionKeyId(encryptionKey), ...(previousKey ? [encryptionKeyId(previousKey)] : [])]);
  const unavailableKeyId = keyRows.find((row) => !knownKeyIds.has(row.key_id))?.key_id;
  if (unavailableKeyId) {
    throw new Error("An environment encryption key is missing; configure the current and previous keys before startup");
  }

  await encryptLegacyValues(db, encryptionKey);
  if (previousKey) await rotatePreviousKeyValues(db, encryptionKey, previousKey);
}
