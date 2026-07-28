import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const page = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");

test("candidate status actions use application_id instead of job_id", () => {
  assert.match(page, /applications\/\$\{this\.applicationId\(item\)\}\/mark-applied/);
  assert.match(page, /applications\/\$\{this\.applicationId\(item\)\}\/ignore/);
  assert.match(page, /const id = item\?\.application_id \|\| item\?\.id/);
  assert.doesNotMatch(page, /applications\/\$\{item\.job_id \|\| item\.id\}\/mark-applied/);
  assert.doesNotMatch(page, /applications\/\$\{item\.job_id \|\| item\.id\}\/ignore/);
});
