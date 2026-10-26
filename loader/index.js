#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  VideoCall — pull-to-deploy loader
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Put this folder on your VPS. Run `npm start` (or let systemd/pm2 do it).
 *
 *  What it does
 *    1. Reads .env (PORT, REPO_URL, TURN_*, CORS_ORIGINS, …)
 *    2. Asks GitHub which commit `main` is on
 *    3. If that is newer than what is installed — or nothing is installed —
 *       it downloads the repo zip, extracts it to a staging folder, runs
 *       `pnpm install && build`, and only then swaps it into ./app
 *    4. Starts the API server (which also serves the built frontend)
 *    5. Supervises it: restarts on crash, backs off on crash loops, and if a
 *       brand-new build refuses to boot it rolls back to the previous one
 *
 *  Your data is never touched
 *    - SQLite lives in  ./data/videocall.db  (outside ./app, so a deploy
 *      cannot delete it)
 *    - .env and ./data inside the app dir are also preserved across updates
 *
 *  Deploying an update = restarting the loader
 *      systemctl restart videocall
 *    or send it a SIGHUP to update without dropping the supervisor:
 *      kill -HUP $(cat .cache/loader.pid)
 *
 *  CLI
 *    node index.js              update if needed, then run
 *    node index.js --update     update if needed, then exit
 *    node index.js --check      report status only
 *    node index.js --rollback   switch back to the previous release, then run
 * ═══════════════════════════════════════════════════════════════════════════
 */

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const chalk = require("chalk");
const AdmZip = require("adm-zip");

// ─── paths ──────────────────────────────────────────────────────────────────
const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "app"); // the installed build (disposable)
const DATA_DIR = path.join(ROOT, "data"); // your database (sacred)
const CACHE_DIR = path.join(ROOT, ".cache");
const STAGING_DIR = path.join(CACHE_DIR, "staging");
const PREV_DIR = path.join(CACHE_DIR, "app.prev"); // last good release
const ZIP_FILE = path.join(CACHE_DIR, "repo.zip");
const STATE_FILE = path.join(CACHE_DIR, "state.json");
const LOG_DIR = path.join(CACHE_DIR, "logs");
const LOADER_LOG = path.join(LOG_DIR, "loader.log");
const APP_LOG = path.join(LOG_DIR, "app.log");
const PID_FILE = path.join(CACHE_DIR, "loader.pid");

/** Files/folders inside the app dir that must survive an update. */
const PRESERVE = ["data", ".env"];

const START_TIME = Date.now();

// ─── tiny logger ────────────────────────────────────────────────────────────
fs.mkdirSync(LOG_DIR, { recursive: true });

function writeFileSafe(file, line) {
  try {
    fs.appendFileSync(file, line + "\n");
  } catch {
    /* logging must never crash the loader */
  }
}

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(tag, message, colour = "cyanBright", isError = false) {
  const prefix = chalk[colour] ? chalk[colour].bold(`[ ${tag} ]`) : `[ ${tag} ]`;
  const line = `${prefix} ${message}`;
  (isError ? console.error : console.log)(line);
  writeFileSafe(LOADER_LOG, `${stamp()} [${tag}] ${message}`);
}

const say = {
  info: (m) => log("LOADER", m, "cyanBright"),
  step: (m) => log("STEP", m, "magentaBright"),
  ok: (m) => log("OK", m, "greenBright"),
  warn: (m) => log("WARN", m, "yellowBright"),
  err: (m) => log("ERROR", m, "redBright", true),
  app: (m) => log("APP", m, "blueBright"),
};

function rule(text) {
  const line = "─".repeat(Math.max(8, 62 - text.length));
  console.log(chalk.gray(`\n${text} ${line}`));
}

// ─── env file ───────────────────────────────────────────────────────────────
/** Minimal .env parser: KEY=value, # comments, optional quotes. */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

loadEnvFile(path.join(ROOT, ".env"));

// ─── config ─────────────────────────────────────────────────────────────────
const CONFIG = {
  repoUrl: process.env.REPO_URL || "https://github.com/favourite111/Let-s-chat-",
  branch: process.env.BRANCH || "main",
  githubToken: process.env.GITHUB_TOKEN || "",
  port: Number(process.env.PORT || 8080),
  checkUpdates: (process.env.CHECK_UPDATES ?? "1") !== "0",
  forceRebuild: process.env.FORCE_REBUILD === "1",
  autoRollback: (process.env.AUTO_ROLLBACK ?? "1") !== "0",
  keepLogBytes: Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024),
  restartDelayMs: Number(process.env.RESTART_DELAY_MS || 3000),
  maxRestarts: Number(process.env.MAX_RESTARTS || 5),
  restartWindowMs: Number(process.env.RESTART_WINDOW_MS || 60_000),
  // Keeping the previous release costs disk (node_modules) but enables
  // instant rollback. Set to 0 on a very small VPS.
  keepPrevious: (process.env.KEEP_PREVIOUS ?? "1") !== "0",
  buildTimeoutMs: Number(process.env.BUILD_TIMEOUT_MS || 10 * 60_000),
  // INSTALL_CMD / BUILD_CMD are raw shell overrides; leave them empty to use
  // the built-in pnpm steps below.
  installCmd: process.env.INSTALL_CMD || "",
  buildCmd: process.env.BUILD_CMD || "",
  startFile:
    process.env.START_FILE || "artifacts/api-server/dist/index.mjs",
};

// ─── small helpers ──────────────────────────────────────────────────────────
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 });
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function rotateIfBig(file, limit) {
  try {
    if (exists(file) && fs.statSync(file).size > limit) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* ignore */
  }
}

/** Run a command, streaming output to the console. */
function run(label, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    say.step(`${label}: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd: options.cwd || STAGING_DIR,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
      shell: false,
    });

    let timer = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        say.err(`${label} timed out after ${Math.round(options.timeoutMs / 1000)}s`);
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve();
      reject(
        new Error(
          `${label} failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
        ),
      );
    });
  });
}

/** First of the candidates that actually works on this machine. */
function probe(commandCandidates, args = ["--version"]) {
  for (const candidate of commandCandidates) {
    const [cmd, ...prefix] = candidate.split(" ");
    try {
      const res = spawnSync(cmd, [...prefix, ...args], {
        encoding: "utf8",
        timeout: 20_000,
      });
      if (res.status === 0) {
        return { cmd, prefix, version: (res.stdout || "").trim().split("\n")[0] };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

// ─── repo URL parsing ───────────────────────────────────────────────────────
function parseRepo(url) {
  const cleaned = url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .replace(/\/archive\/refs\/heads\/.*$/, "");

  const patterns = [
    /github\.com[/:]([^/]+)\/([^/]+)$/i,
    /^([^/\s]+)\/([^/\s]+)$/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) return { owner: match[1], repo: match[2] };
  }
  throw new Error(
    `Cannot understand REPO_URL "${url}". Use https://github.com/owner/repo or owner/repo.`,
  );
}

const REPO = parseRepo(CONFIG.repoUrl);

function authHeaders() {
  const headers = {
    "user-agent": "videocall-loader",
    accept: "application/vnd.github+json",
  };
  if (CONFIG.githubToken) headers.authorization = `Bearer ${CONFIG.githubToken}`;
  return headers;
}

/** The commit SHA currently on the branch, or null if GitHub cannot be asked. */
async function resolveRemoteSha() {
  const api = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/commits/${CONFIG.branch}`;
  try {
    const res = await fetch(api, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      say.warn(
        `GitHub API returned ${res.status} (${res.statusText}); will re-download to check.`,
      );
      return null;
    }
    const body = await res.json();
    return typeof body.sha === "string" ? body.sha : null;
  } catch (err) {
    say.warn(`Could not reach GitHub (${err.message}); will re-download to check.`);
    return null;
  }
}

function zipUrl() {
  if (CONFIG.githubToken) {
    // Private repos: the API zipball honours the token; /archive/ does not.
    return `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/zipball/${CONFIG.branch}`;
  }
  return `https://github.com/${REPO.owner}/${REPO.repo}/archive/refs/heads/${CONFIG.branch}.zip`;
}

async function downloadZip(destination) {
  const url = zipUrl();
  say.step(`Downloading ${chalk.underline(url)}`);

  const res = await fetch(url, {
    headers: CONFIG.githubToken ? authHeaders() : { "user-agent": "videocall-loader" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(
      `Download failed: HTTP ${res.status} ${res.statusText}. ` +
        (res.status === 404
          ? `Check REPO_URL and BRANCH ("${CONFIG.branch}") — or set GITHUB_TOKEN for a private repo.`
          : ""),
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 512) throw new Error("Downloaded file is suspiciously small.");
  await fsp.writeFile(destination, buffer);
  say.ok(`Downloaded ${humanBytes(buffer.length)}`);
  return buffer.length;
}

/** Extract a GitHub zipball and flatten its single top-level folder. */
async function extractInto(targetDir) {
  say.step(`Extracting into ${path.relative(ROOT, targetDir)}`);
  const zip = new AdmZip(ZIP_FILE);
  zip.extractAllTo(targetDir, /* overwrite */ true);

  const entries = await fsp.readdir(targetDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());

  if (dirs.length === 1 && entries.length === 1) {
    // GitHub wraps everything in "repo-branch/" — lift it up one level.
    // The temporary home must live OUTSIDE targetDir, otherwise removing
    // targetDir would take the files with it.
    const inner = path.join(targetDir, dirs[0].name);
    const temp = `${targetDir}.lift-${Date.now()}`;
    await fsp.rename(inner, temp);
    await rmrf(targetDir);
    await fsp.mkdir(targetDir, { recursive: true });
    for (const entry of await fsp.readdir(temp)) {
      await fsp.rename(path.join(temp, entry), path.join(targetDir, entry));
    }
    await rmrf(temp);
  }

  const marker = path.join(targetDir, "package.json");
  if (!exists(marker)) {
    throw new Error("Extracted archive does not look like the project (no package.json).");
  }
}

// ─── preserve / restore user data ───────────────────────────────────────────
async function preserveFromApp() {
  const saved = [];
  for (const name of PRESERVE) {
    const src = path.join(APP_DIR, name);
    if (!exists(src)) continue;
    const dest = path.join(CACHE_DIR, "preserve", name);
    await rmrf(dest);
    await ensureDir(path.dirname(dest));
    await fsp.cp(src, dest, { recursive: true });
    saved.push(name);
  }
  if (saved.length) say.ok(`Preserved from the old release: ${saved.join(", ")}`);
  return saved;
}

async function restoreInto(staging) {
  const preserveRoot = path.join(CACHE_DIR, "preserve");
  if (!exists(preserveRoot)) return;
  for (const name of await fsp.readdir(preserveRoot)) {
    const src = path.join(preserveRoot, name);
    const dest = path.join(staging, name);
    // Never overwrite something the new release ships deliberately.
    if (exists(dest)) {
      say.info(`Keeping the new release's own "${name}" (preserved copy skipped).`);
      continue;
    }
    await fsp.cp(src, dest, { recursive: true });
    say.ok(`Restored "${name}" into the new release`);
  }
  await rmrf(preserveRoot);
}

// ─── toolchain ──────────────────────────────────────────────────────────────
let PNPM = null;

function resolvePnpm() {
  // Each entry is the full command; the first one that runs wins.
  //   pnpm on PATH  →  npx (pinned, ships with npm)  →  corepack
  PNPM = probe(["pnpm"]) || probe(["npx --yes pnpm@10"]) || probe(["corepack pnpm"]);

  if (!PNPM) {
    throw new Error(
      "pnpm is required to build this project and none of these worked:\n" +
        "  pnpm           → npm i -g pnpm\n" +
        "  npx pnpm@10    → comes with Node/npm\n" +
        "  corepack pnpm  → corepack enable",
    );
  }

  const label = [PNPM.cmd, ...PNPM.prefix].join(" ");
  say.ok(`Using ${label} (${PNPM.version || "version unknown"})`);

  const major = Number(String(PNPM.version).match(/(\d+)\./)?.[1]);
  if (Number.isFinite(major) && major && major !== 10) {
    say.warn(
      `This project's lockfile was generated with pnpm 10 (found ${PNPM.version}). ` +
        "If install fails, run: npm i -g pnpm@10",
    );
  }
}

function pnpm(args) {
  return run("pnpm", PNPM.cmd, [...PNPM.prefix, ...args], {
    cwd: STAGING_DIR,
    timeoutMs: CONFIG.buildTimeoutMs,
    env: {
      // devDependencies are needed to build; never inherit a production-only env
      NODE_ENV: "development",
      npm_config_production: "false",
      CI: "true",
      BASE_PATH: "/",
      PORT: String(CONFIG.port),
    },
  });
}

function preflight() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    say.warn(
      `Node ${process.versions.node} detected. This project needs Node 20+ (22 recommended).`,
    );
  }

  const hasCompiler =
    probe(["node-gyp", "--version"]) !== null || exists("/usr/bin/make");
  if (!hasCompiler) {
    say.warn(
      "No C toolchain detected. better-sqlite3 usually ships a prebuilt binary, but if the build fails install: apt-get install -y python3 make g++",
    );
  }

  try {
    const stats = fs.statfsSync(ROOT);
    const free = stats.bavail * stats.bsize;
    if (free < 800 * 1024 * 1024) {
      say.warn(`Only ${humanBytes(free)} free disk space — a build needs ~1 GB.`);
    }
  } catch {
    /* statfs is not available everywhere */
  }
}

// ─── update pipeline ────────────────────────────────────────────────────────
async function stagedInstall() {
  say.step("Preparing staging directory");
  await rmrf(STAGING_DIR);
  await ensureDir(STAGING_DIR);
  await rmrf(path.join(CACHE_DIR, "preserve"));

  await preserveFromApp();
  await extractInto(STAGING_DIR);
  await restoreInto(STAGING_DIR);

  // 1. Dependencies (dev dependencies included — they are needed to build).
  if (CONFIG.installCmd) {
    await run("install", "bash", ["-lc", CONFIG.installCmd], {
      cwd: STAGING_DIR,
      timeoutMs: CONFIG.buildTimeoutMs,
      env: { NODE_ENV: "development", npm_config_production: "false", CI: "true" },
    });
  } else {
    await pnpm(["install", "--frozen-lockfile"]);
  }

  // 2. Build only the two packages the server actually needs.
  if (CONFIG.buildCmd) {
    await run("build", "bash", ["-lc", CONFIG.buildCmd], {
      cwd: STAGING_DIR,
      timeoutMs: CONFIG.buildTimeoutMs,
      env: { NODE_ENV: "development", BASE_PATH: "/", PORT: String(CONFIG.port) },
    });
  } else {
    await pnpm(["--filter", "@workspace/video-call", "run", "build"]);
    await pnpm(["--filter", "@workspace/api-server", "run", "build"]);
  }

  if (!exists(path.join(STAGING_DIR, CONFIG.startFile))) {
    throw new Error(`Build finished but ${CONFIG.startFile} is missing.`);
  }
  say.ok("Build complete");
}

async function activate() {
  await rmrf(PREV_DIR);
  if (exists(APP_DIR)) {
    if (CONFIG.keepPrevious) {
      await fsp.rename(APP_DIR, PREV_DIR);
      say.info("Previous release moved aside (kept for rollback)");
    } else {
      await rmrf(APP_DIR);
      say.info("Previous release deleted (KEEP_PREVIOUS=0)");
    }
  }
  await fsp.rename(STAGING_DIR, APP_DIR);
  say.ok("New release is live");
}

async function rollback() {
  if (!exists(PREV_DIR)) {
    say.err("Nothing to roll back to — no previous release is stored.");
    return false;
  }
  await rmrf(path.join(CACHE_DIR, "app.failed"));
  if (exists(APP_DIR)) await fsp.rename(APP_DIR, path.join(CACHE_DIR, "app.failed"));
  await fsp.rename(PREV_DIR, APP_DIR);
  say.warn("Rolled back to the previous release");
  return true;
}

async function updateIfNeeded({ force = false } = {}) {
  const state = readJson(STATE_FILE, {}) || {};
  const installed = exists(path.join(APP_DIR, CONFIG.startFile));

  if (CONFIG.forceRebuild || force) say.warn("Forced rebuild requested");

  const remoteSha = await resolveRemoteSha();
  const sameCommit = Boolean(remoteSha && state.sha && remoteSha === state.sha);

  if (CONFIG.forceRebuild || force || !installed || !sameCommit) {
    if (!installed) {
      say.info("No installed release found — performing a first-time install.");
    } else if (!CONFIG.forceRebuild && !force && sameCommit && !installed) {
      say.info("Install incomplete — rebuilding.");
    } else if (remoteSha && state.sha && remoteSha !== state.sha) {
      say.info(
        `New commit on ${CONFIG.branch}: ${chalk.gray(state.sha.slice(0, 8))} → ${chalk.greenBright(remoteSha.slice(0, 8))}`,
      );
    }

    rule("Updating");
    preflight();
    resolvePnpm();
    await downloadZip(ZIP_FILE);

    try {
      await stagedInstall();
      await activate();
      writeJson(STATE_FILE, {
        sha: remoteSha || "unknown",
        branch: CONFIG.branch,
        repo: `${REPO.owner}/${REPO.repo}`,
        deployedAt: new Date().toISOString(),
      });
      say.ok(
        `Deployed ${remoteSha ? remoteSha.slice(0, 8) : "latest"} from ${REPO.owner}/${REPO.repo}@${CONFIG.branch}`,
      );
      return { updated: true, sha: remoteSha };
    } catch (err) {
      say.err(`Update failed: ${err.message}`);
      say.warn("Keeping the currently installed release untouched.");
      await rmrf(STAGING_DIR);
      if (!installed) throw err;
      return { updated: false, sha: state.sha, failed: true };
    }
  }

  say.ok(
    `Already on the latest commit (${state.sha.slice(0, 8)}), skipping download and build.`,
  );
  if (state.deployedAt) say.info(`Deployed ${state.deployedAt}`);
  return { updated: false, sha: state.sha };
}

// ─── single-instance lock ───────────────────────────────────────────────────
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Two loaders fighting over the same folder (systemd + a manual `npm start`, or
 * a cron `--update` overlapping a running instance) would fight over the port
 * and the release folders. Refuse politely instead.
 */
function acquireLock() {
  const existing = Number(
    (() => {
      try {
        return fs.readFileSync(PID_FILE, "utf8").trim();
      } catch {
        return 0;
      }
    })(),
  );

  if (existing && existing !== process.pid && pidIsAlive(existing)) {
    say.err(
      `Another loader is already running (pid ${existing}).\n` +
        `  Stop it first:  kill ${existing}\n` +
        `  Or use a different folder / set LOADER_ALLOW_DOUBLE=1.`,
    );
    if (process.env.LOADER_ALLOW_DOUBLE === "1") {
      say.warn("LOADER_ALLOW_DOUBLE=1 — continuing anyway.");
    } else {
      process.exit(1);
    }
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));

  const release = () => {
    try {
      if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(PID_FILE);
      }
    } catch {
      /* ignore */
    }
  };
  process.on("exit", release);
  return release;
}

// ─── run the app ────────────────────────────────────────────────────────────
let child = null;
let shuttingDown = false;
let restarts = [];
let rollbackUsed = false;

function appEnv() {
  const env = { ...process.env, NODE_ENV: "production", PORT: String(CONFIG.port) };

  // The database lives outside ./app so a deploy can never delete it.
  ensureDataDir();
  if (!env.SQLITE_PATH) env.SQLITE_PATH = path.join(DATA_DIR, "videocall.db");
  if (!env.TRUST_PROXY) env.TRUST_PROXY = "1";

  return env;
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    say.err(`Cannot create data directory ${DATA_DIR}: ${err.message}`);
  }
}

function startApp() {
  ensureDataDir();
  rotateIfBig(APP_LOG, CONFIG.keepLogBytes);

  say.app(`Starting ${CONFIG.startFile} on port ${CONFIG.port}`);
  const logStream = fs.createWriteStream(APP_LOG, { flags: "a" });

  child = spawn(process.execPath, ["--enable-source-maps", CONFIG.startFile], {
    cwd: APP_DIR,
    env: appEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const relay = (stream, isStdErr) => {
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      (isStdErr ? process.stderr : process.stdout).write(text);
      logStream.write(text);
    });
  };
  relay(child.stdout, false);
  relay(child.stderr, true);

  child.on("exit", (code, signal) => {
    logStream.end();
    child = null;
    if (shuttingDown) return;
    handleChildExit(code, signal);
  });

  fs.writeFileSync(PID_FILE, String(process.pid));
}

async function handleChildExit(code, signal) {
  say.err(`App exited (${signal ? `signal ${signal}` : `code ${code}`})`);

  const now = Date.now();
  restarts = restarts.filter((t) => now - t < CONFIG.restartWindowMs);
  restarts.push(now);

  const crashLooping = restarts.length >= CONFIG.maxRestarts;

  if (crashLooping && CONFIG.autoRollback && !rollbackUsed && exists(PREV_DIR)) {
    rollbackUsed = true;
    say.warn(
      `${CONFIG.maxRestarts} crashes within ${CONFIG.restartWindowMs / 1000}s — rolling back to the previous release.`,
    );
    const didRollback = await rollback();
    if (didRollback) {
      restarts = [];
      writeJson(STATE_FILE, {
        ...(readJson(STATE_FILE, {}) || {}),
        rolledBackAt: new Date().toISOString(),
      });
      startApp();
      return;
    }
  }

  if (crashLooping) {
    say.err(
      `${CONFIG.maxRestarts} crashes within ${CONFIG.restartWindowMs / 1000}s — stopping. Fix the error and restart.`,
    );
    process.exit(1);
  }

  say.info(`Restarting in ${CONFIG.restartDelayMs / 1000}s…`);
  setTimeout(() => startApp(), CONFIG.restartDelayMs);
}

function stopApp(signal = "SIGTERM") {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const timer = setTimeout(() => {
      if (child) child.kill("SIGKILL");
    }, 12_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill(signal);
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  say.warn(`${signal} received — stopping the app gracefully`);
  await stopApp("SIGTERM");
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
  say.ok("Stopped.");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  say.err(`Loader uncaught exception: ${err.stack || err.message}`);
});
process.on("unhandledRejection", (reason) => {
  say.err(`Loader unhandled rejection: ${reason}`);
});

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);

  if (!flag("check")) acquireLock();

  console.log(
    chalk.hex("#7c5cfc").bold("\n  VideoCall") +
      chalk.gray(" · pull-to-deploy loader\n"),
  );
  say.info(`Repo      ${REPO.owner}/${REPO.repo}@${CONFIG.branch}`);
  say.info(`Root      ${ROOT}`);
  say.info(`Code      ${APP_DIR}`);
  say.info(`Database  ${path.join(DATA_DIR, "videocall.db")}`);
  say.info(`Port      ${CONFIG.port}`);

  if (flag("check")) {
    const state = readJson(STATE_FILE, {}) || {};
    const remoteSha = await resolveRemoteSha();
    const installed = exists(path.join(APP_DIR, CONFIG.startFile));
    console.log("");
    say.info(`Installed : ${state.sha ? state.sha.slice(0, 8) : "none"}${state.deployedAt ? ` (${state.deployedAt})` : ""}`);
    say.info(`Remote    : ${remoteSha ? remoteSha.slice(0, 8) : "unknown"}`);
    say.info(`Ready     : ${installed ? "yes" : "no"}`);
    say.info(
      `Status    : ${
        !installed
          ? "needs install"
          : remoteSha && state.sha === remoteSha
            ? "up to date"
            : "update available"
      }`,
    );
    return;
  }

  if (flag("rollback")) {
    await rollback();
    if (!exists(path.join(APP_DIR, CONFIG.startFile))) {
      say.err("No usable release after rollback.");
      process.exit(1);
    }
    startApp();
    return;
  }

  await updateIfNeeded({ force: CONFIG.forceRebuild });

  if (flag("update")) {
    say.ok("Update step finished (no app started because of --update).");
    return;
  }

  if (!exists(path.join(APP_DIR, CONFIG.startFile))) {
    say.err(
      `Nothing to run: ${CONFIG.startFile} not found in ${APP_DIR}. ` +
        "Run with FORCE_REBUILD=1 to retry the build.",
    );
    process.exit(1);
  }

  rule("Running");
  startApp();

  // SIGHUP = "pull and restart" without dropping the supervisor.
  process.on("SIGHUP", async () => {
    say.warn("SIGHUP received — checking for a new version");
    await stopApp("SIGTERM");
    const result = await updateIfNeeded({ force: false });
    if (result.updated) say.ok("Updated. Starting the new release.");
    restarts = [];
    startApp();
  });

  const seconds = Math.round((Date.now() - START_TIME) / 1000);
  say.ok(`Loader ready in ${seconds}s — Ctrl+C to stop`);
}

main().catch((err) => {
  say.err(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
