#!/usr/bin/env node
// Reviewer aid: prints the live schema (sqlite_master.sql) of a freshly-migrated
// database, for diffing against migrations/0001_init.sql / Appendix D.1.
import { openMigrated } from "../src/db.ts";

const db = openMigrated();
const rows = db
  .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
  .all() as Array<{ sql: string }>;
for (const r of rows) console.log(r.sql + ";");
