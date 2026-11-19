/**
 * Copy the static assets that Next.js `output: standalone` does NOT include in
 * the standalone bundle. Without this, the deployed server returns 404 for
 * /_next/static/* and /public files (manifest, icons, etc.).
 *
 * Cross-platform (Windows/Linux/macOS) — replaces the old xcopy-based steps.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const srcStatic = path.join(root, ".next", "static");
const dstStatic = path.join(root, ".next", "standalone", ".next", "static");
const srcPublic = path.join(root, "public");
const dstPublic = path.join(root, ".next", "standalone", "public");

function copyDir(src, dst) {
  if (!fs.existsSync(src)) {
    console.log(`[standalone-assets] skip (missing): ${src}`);
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
  console.log(`[standalone-assets] copied ${src} -> ${dst}`);
}

copyDir(srcStatic, dstStatic);
copyDir(srcPublic, dstPublic);
