import { cleanupInvalidSupplementApplications, openDb } from "../src/db.js";

const db = openDb();
try {
  const removed = cleanupInvalidSupplementApplications(db);
  console.log(`Removed ${removed} invalid supplement records.`);
} finally {
  db.close();
}
