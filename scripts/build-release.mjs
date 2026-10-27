#!/usr/bin/env node
/**
 * Build a prebuilt release bundle for the VPS loader.
 *
 * Why this exists: some panels (Katabump/Pterodactyl, small containers) kill a
 * process for creating too many files too quickly, and give you far less than
 * the ~1 GB a pnpm install + Vite build needs. Building there is not viable.
 *
 * So we build once — on a normal machine or in CI — and publish a small zip:
 *
 *   release.zip
 *   ├── MANIFEST.json                  (commit, version, file count, built at)
 *   ├── package.json                   (runtime metadata)
 *   ├── artifacts/api-server/dist/**   (server, bundled to one file)
 *   ├── artifacts/video-call/dist/public/**  (built frontend)
 *   └── node_modules/**                (only the deps the bundle externalises)
 *
 * The loader just downloads, extracts and runs it. No pnpm, no build, no
 * thousands of files.
 *
 * Usage:
 *   node scripts/build-release.mjs            # build + zip into .release/
 *   node scripts/build-release.mjs --no-zip   # leave the folder for inspection
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(ROOT, ".release");
const STAGE = path.join(OUT_DIR, "server");
const ZIP_FILE = path.join(OUT_DIR, "release.zip");
const META_FILE = path.join(OUT_DIR, "release.json");

/**
 * Packages the esbuild bundle keeps external (see artifacts/api-server/build.mjs).
 * Everything else — express, socket.io, pino, helmet, zod… — is already inlined.
 */
const RUNTIME_DEPS = {
  // The only thing that cannot be bundled: a native .node binary.
  // pg, redis and @socket.io/redis-adapter are pure JS and are already inlined
  // into dist/index.mjs, which is what keeps this release to a few dozen files.
  "better-sqlite3": "^11.10.0",
};

function say(message) {
  console.log(`  ${message}`);
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA || "unknown";
  }
}

async function countFiles(dir) {
  let total = 0;
  const queue = [dir];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
      else total += 1;
    }
  }
  return total;
}

async function totalBytes(dir) {
  let bytes = 0;
  const queue = [dir];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      try {
        bytes += (await fsp.lstat(full)).size;
      } catch {
        /* dangling symlink — counts as 0 bytes */
      }
    }
  }
  return bytes;
}

async function main() {
  const noZip = process.argv.includes("--no-zip");
  const sha = gitSha();

  step("Checking build output");
  const serverDist = path.join(ROOT, "artifacts/api-server/dist/index.mjs");
  const frontendDist = path.join(ROOT, "artifacts/video-call/dist/public/index.html");

  for (const [label, file] of [
    ["server bundle", serverDist],
    ["frontend build", frontendDist],
  ]) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `${label} missing (${path.relative(ROOT, file)}). Run \`pnpm build\` first.`,
      );
    }
    say(`found ${label}`);
  }

  step("Preparing staging folder");
  await fsp.rm(OUT_DIR, { recursive: true, force: true });
  await fsp.mkdir(STAGE, { recursive: true });

  // 1. Copy the two dist folders.
  await fsp.cp(path.join(ROOT, "artifacts/api-server/dist"), path.join(STAGE, "artifacts/api-server/dist"), {
    recursive: true,
  });
  await fsp.cp(
    path.join(ROOT, "artifacts/video-call/dist/public"),
    path.join(STAGE, "artifacts/video-call/dist/public"),
    { recursive: true },
  );

  // Absolute paths inside sourcemaps only matter for local debugging; strip them
  // so the release does not leak build-machine paths.
  for (const map of ["index.mjs.map"]) {
    const mapPath = path.join(STAGE, "artifacts/api-server/dist", map);
    if (fs.existsSync(mapPath)) await fsp.rm(mapPath).catch(() => undefined);
  }

  // 2. Runtime dependencies only.
  step("Installing " + Object.keys(RUNTIME_DEPS).length + " runtime dependencies");
  await fsp.writeFile(
    path.join(STAGE, "package.json"),
    JSON.stringify(
      {
        name: "videocall-release",
        private: true,
        version: `0.0.0-${sha.slice(0, 8)}`,
        type: "module",
        description: "Prebuilt VideoCall server + frontend",
        dependencies: RUNTIME_DEPS,
      },
      null,
      2,
    ) + "\n",
  );

  execFileSync(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: STAGE, stdio: "inherit" },
  );

  // npm writes these; they describe the build machine, not the release.
  for (const junk of ["package-lock.json", ".package-lock.json"]) {
    await fsp.rm(path.join(STAGE, junk), { force: true });
  }

  // better-sqlite3 ships build tooling we never need at runtime (install-time
  // prebuild fetching, C++ sources, docs). Removing it roughly halves the file
  // count — which is exactly what matters on a panel that throttles file
  // creation. The compiled .node binary and lib/ stay.
  step("Pruning install-time-only files");
  const modulesDir = path.join(STAGE, "node_modules");
  // node_modules/.bin is a pile of symlinks used at install time. Nothing at
  // runtime needs them, and pruning leaves some dangling.
  await fsp.rm(path.join(modulesDir, ".bin"), { recursive: true, force: true });
  const removable = [
    "better-sqlite3/src",
    "better-sqlite3/deps",
    "better-sqlite3/build/Release/obj",
    "better-sqlite3/build/deps",
    "prebuild-install",
    "tar-fs",
    "github-from-package",
    "node-abi",
    "node-gyp-build",
  ];
  for (const relative of removable) {
    // rm on a missing path can still throw ENOENT for broken symlinks (e.g.
    // node_modules/.bin entries), so swallow those individually.
    try {
      await fsp.rm(path.join(modulesDir, relative), { recursive: true, force: true });
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  // Strip docs/maps/tests from every package.
  const queue = [modulesDir];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (["test", "tests", "__tests__", "docs", "example", "examples", ".github"].includes(entry.name)) {
          await fsp.rm(full, { recursive: true, force: true });
        } else {
          queue.push(full);
        }
      } else if (/\.(md|markdown|map|ts|flow)$/i.test(entry.name) && entry.name.toLowerCase() !== "license.md") {
        await fsp.rm(full, { force: true });
      }
    }
  }

  // 3. Manifest + a tiny health marker the loader can compare cheaply.
  const fileCount = await countFiles(STAGE);
  const bytes = await totalBytes(STAGE);
  const manifest = {
    name: "videocall",
    commit: sha,
    commitShort: sha.slice(0, 8),
    builtAt: new Date().toISOString(),
    node: process.version,
    files: fileCount,
    bytes,
    startFile: "artifacts/api-server/dist/index.mjs",
    runtimeDeps: Object.keys(RUNTIME_DEPS),
  };

  await fsp.writeFile(path.join(STAGE, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  await fsp.writeFile(META_FILE, JSON.stringify(manifest, null, 2) + "\n");

  step("Release assembled");
  say(`${fileCount} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  if (noZip) {
    say(`staged at ${path.relative(ROOT, STAGE)}`);
    return;
  }

  step("Zipping");
  await fsp.rm(ZIP_FILE, { force: true });

  // Prefer the system zip (streaming, keeps permissions); fall back to python.
  try {
    execFileSync("zip", ["-qr", "-9", ZIP_FILE, "."], { cwd: STAGE, stdio: "inherit" });
  } catch {
    say("zip not available, using python");
    execFileSync(
      "python3",
      ["-c", `import shutil; shutil.make_archive(r"${ZIP_FILE.replace(/\.zip$/, "")}", "zip", r"${STAGE}")`],
      { stdio: "inherit" },
    );
  }

  const zipBytes = (await fsp.stat(ZIP_FILE)).size;
  say(`release.zip — ${(zipBytes / 1024 / 1024).toFixed(1)} MB`);

  console.log(`\n✔ ${path.relative(ROOT, ZIP_FILE)}`);
  console.log(`  upload it as a release asset named "release.zip" and the loader`);
  console.log(`  will pick it up from /releases/latest/download/release.zip\n`);
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
});
