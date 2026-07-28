import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "vendor");
const assets = [
  {
    url: "https://unpkg.com/vue@3.5.16/dist/vue.global.prod.js",
    file: "vue.js",
    sha256: "33f0ca93acf0a3f00c2a94a2173637d0321f96632d11d15535005e6e0a75e058"
  },
  {
    url: "https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css",
    file: "tailwind.css",
    sha256: "b6ad97402eddb903e7a5d7a73ee47a679204efbdda4521a391cbad9df509b932"
  }
];

await fs.mkdir(vendorDir, { recursive: true });
for (const asset of assets) {
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`download_failed:${asset.file}`);
  const body = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  if (hash !== asset.sha256) throw new Error(`integrity_check_failed:${asset.file}`);
  await fs.writeFile(path.join(vendorDir, asset.file), body);
  console.log(`${asset.file} sha256=${hash}`);
}
