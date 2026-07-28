import { cleanupLegacyAutoSupplementData, openDb } from "../src/db.js";

const apply = process.argv.includes("--apply");
const db = openDb();

try {
  const result = cleanupLegacyAutoSupplementData(db, { apply });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) console.log("Dry run only. Re-run with --apply to make changes.");
} finally {
  db.close();
}
