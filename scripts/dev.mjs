#!/usr/bin/env node
// ray develop's build output carries a whole inline sourcemap (@raycast/api hardcodes `sourcemap: "inline"`, with no toggle),
// so each single-command bundle gains a 25MB base64 tail; Raycast caps each command's heap at 100MB, so it OOMs the moment it runs.
// This script runs alongside ray develop: the build output first lands on the CLI side, then the inline map is stripped off, and only then is it moved into the directory the app actually reads.
//
// The "strip first, move second" order cannot be reversed. In practice, writing straight into the app's directory makes the app go parse
// the file the instant the build finishes while it still carries the 35MB inline map, reporting "Command terminated after reaching the extension memory limit".
// Moving (rather than copying) is to keep only one copy: the CLI-side .js is deleted once moved, and the next build rewrites it.
//
// Usage: npm run dev (arguments are passed through to ray develop, e.g. npm run dev -- --exit-on-error)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPublishableAsIs, stripInlineSourcemap } from "./strip-inline-sourcemap.mjs";
import { syncArtifacts } from "./sync-artifacts.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const NAME = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name;
const CONFIG_DIR = path.join(os.homedir(), ".config");
// Two devs running at once fight over the same set of build output (observed: EPERM + a half-stripped bundle), so a lock file is kept.
// It records two pids: this script's, and the ray develop it spawns — when the outer wrapper process is killed,
// the inner ray develop survives as an orphan process, and recording only one pid would miss that case.
const LOCK = path.join(os.tmpdir(), `${NAME}-dev.pid`);

// On win32 the CLI writes raycast-x by default (it appends the flavor to the directory name, and an empty flavor is what corresponds to
// raycast with no suffix), whereas the Raycast app reads raycast — its config.json has Target as an empty string.
const STAGING = process.env.PASEO_STAGING ?? path.join(CONFIG_DIR, "raycast-x", "extensions", NAME);
const STORE = process.env.PASEO_STORE ?? path.join(CONFIG_DIR, "raycast", "extensions", NAME);
const POLL_MS = 1000;
// Files the CLI itself is using; moving them would interrupt it
const KEEP = new Set(["cli.pid", "dev.log"]);
// Our own half-written scratch files (writeAtomic's `.tmp-<pid>`), which are never artifacts
const TRANSIENT = /\.tmp(-\d+)?$/;
// The build's own output: what gets stripped and moved rather than copied
const BUILD_OUTPUT = /\.js(\.map)?$/;

const log = (message) => console.log(`[dev] ${message}`);

function signature(file) {
  const stat = fs.statSync(file);
  return `${stat.size}:${stat.mtimeMs}`;
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file); // so the app never reads a half-written file
}

const observed = new Map(); // file -> { sig, done }

function stripStaging() {
  let entries;
  try {
    entries = fs.readdirSync(STAGING);
  } catch {
    return; // not built yet
  }

  for (const name of entries) {
    if (!name.endsWith(".js")) continue;
    const file = path.join(STAGING, name);

    let sig;
    try {
      sig = signature(file);
    } catch {
      continue;
    }

    // Only act after seeing the same size+mtime in two consecutive rounds: esbuild holds a handle while writing this file, and modifying it concurrently corrupts its write.
    const last = observed.get(file);
    if (!last || last.sig !== sig) {
      observed.set(file, { sig, done: false });
      continue;
    }
    if (last.done) continue;

    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const stripped = stripInlineSourcemap(source, `${name}.map`);
    if (!stripped) {
      // "Nothing to strip" is not the same as "safe to publish": a bundle caught mid-write has no map
      // we can find and would OOM Raycast the moment it is loaded. Leave it un-done and read it again
      // next round — the retry does not depend on the size or mtime changing, since neither does.
      if (!isPublishableAsIs(source)) {
        observed.set(file, { sig, done: false });
        log(`${name}: not fully written yet (${source.length} bytes), waiting`);
        continue;
      }
      observed.set(file, { sig, done: true });
      continue;
    }

    try {
      writeAtomic(`${file}.map`, stripped.map);
      writeAtomic(file, stripped.code);
      observed.set(file, { sig, done: true });
      log(`${name}: stripped inline sourcemap, saved ${((source.length - stripped.code.length) / 1048576).toFixed(1)} MB`);
    } catch (error) {
      log(`${name}: failed to strip sourcemap, retrying next round — ${error.message}`);
    }
  }
}

/**
 * Move the already-stripped .js / .js.map from staging into the directory the app reads, and delete the originals once moved — so there is
 * only one copy of the build output on disk, rather than two of 10MB each.
 *
 * Only those two suffixes are moved: they are the large artifacts, and are rewritten on every build. Everything else —
 * package.json, assets/ — is copied instead, and only when it differs from what is already there. It used to be copied only when
 * missing, which meant a changed icon or manifest never reached the app at all: the build kept writing the new one into staging
 * while Raycast went on reading the first copy ever made. Package.json goes stale quietly, but it holds the commands and preferences,
 * so a day of manifest edits can pass without ever taking effect.
 */
function publish() {
  let entries;
  try {
    entries = fs.readdirSync(STAGING, { withFileTypes: true });
  } catch {
    return;
  }

  fs.mkdirSync(STORE, { recursive: true });
  let moved = 0;
  let refreshed = 0;

  for (const entry of entries) {
    if (KEEP.has(entry.name) || TRANSIENT.test(entry.name)) continue;
    const from = path.join(STAGING, entry.name);
    const to = path.join(STORE, entry.name);

    try {
      if (entry.isDirectory() || !BUILD_OUTPUT.test(entry.name)) {
        // Copied, never moved: the CLI rebuilds these every time, and emptying its own output directory out from under it makes it complain.
        refreshed += syncArtifacts(from, to);
        continue;
      }
      // Don't move one that was just built and not yet stripped: the moment the app sees it, it parses that 35MB inline map and OOMs immediately
      if (entry.name.endsWith(".js") && observed.get(from)?.done !== true) continue;

      const tmp = `${to}.tmp-${process.pid}`;
      fs.copyFileSync(from, tmp);
      fs.renameSync(tmp, to);
      fs.rmSync(from, { force: true });
      moved += 1;
    } catch (error) {
      log(`failed to move ${entry.name}, retrying next round — ${error.message}`);
    }
  }

  if (moved > 0 || refreshed > 0) {
    log(`published ${moved} files, refreshed ${refreshed} artifacts to ${STORE}`);
  }
}

function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock() {
  try {
    const [parent, kid] = fs.readFileSync(LOCK, "utf8").split(/\s+/).map(Number);
    return { parent, child: kid };
  } catch {
    return null;
  }
}

/** child.kill() cannot kill this grandchild process on Windows (in practice ray develop keeps running fine); taskkill /T is required. */
function killTree(pid) {
  if (!alive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

let child;

if (process.env.PASEO_NO_SPAWN === "1") {
  log(`PASEO_NO_SPAWN=1: only strip map + publish, do not spawn ray develop itself (watching ${STAGING})`);
} else {
  const lock = readLock();
  // The outer script is still alive = the user opened another dev themselves: two writing the same set of build output at once corrupts the bundle, so let them decide
  if (lock && alive(lock.parent)) {
    log(`a dev is already running (pid ${lock.parent}). Running two at once fights over build output and corrupts the bundle.`);
    log(`stop it first: taskkill /PID ${lock.parent} /T /F`);
    process.exit(1);
  }
  // Only a lone ray develop still alive = left behind by a previous hard kill; clean it up directly
  if (lock && alive(lock.child)) {
    log(`cleaning up the ray develop left behind last time (pid ${lock.child})`);
    killTree(lock.child);
  }

  // Run @raycast/api's bin/run.js directly, sidestepping the old problem that npx/.cmd must open a shell on Windows
  const rayBin = path.join(ROOT, "node_modules", "@raycast", "api", "bin", "run.js");
  child = spawn(process.execPath, [rayBin, "develop", ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: "inherit",
  });
  fs.writeFileSync(LOCK, `${process.pid}\n${child.pid}\n`);

  const cleanup = () => {
    try {
      fs.rmSync(LOCK, { force: true });
    } catch {
      // if it cannot be deleted, so be it; liveness is probed by pid next time
    }
    killTree(child.pid);
  };

  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }

  child.on("exit", (code) => {
    log(`ray develop exited (${code})`);
    process.exit(code ?? 0);
  });
}

function tick() {
  stripStaging();
  publish();
}

tick();
setInterval(tick, POLL_MS);
