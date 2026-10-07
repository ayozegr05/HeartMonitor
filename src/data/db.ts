import { openDatabaseSync } from 'expo-sqlite';
import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';

import migrations from '@/drizzle/migrations';

import * as schema from './schema';

let db: ExpoSQLiteDatabase<typeof schema> | null = null;

/** Lazily opened database — avoids side effects at import time (tests, tooling). */
export function getDb(): ExpoSQLiteDatabase<typeof schema> {
  if (!db) {
    db = drizzle(openDatabaseSync('heartmonitor.db'), { schema });
  }
  return db;
}

/** Applies pending SQL migrations. Call once at app startup. */
export async function initializeDatabase(): Promise<void> {
  await migrate(getDb(), migrations);
}
