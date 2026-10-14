// The manifest and the assets are rewritten on every build, so the copy sitting in the directory Raycast reads goes
// stale the moment either one changes — while only the .js bundles get refreshed by the move in dev.mjs. This keeps
// the non-build artifacts in step too.
//
// Copies only, never deletes: the CLI recreates its own output every build, and hollowing that directory out makes it
// complain. Copies only what differs: the loop runs once a second, so an unchanged tree must stay untouched.
import fs from "node:fs";
import path from "node:path";

/** True when `destPath` is missing or holds anything other than what `sourcePath` holds. */
export function shouldCopy(sourcePath, destPath) {
  const dest = statOrNull(destPath);
  if (!dest) return true;

  const source = fs.statSync(sourcePath);
  // Comparing the bytes rather than the timestamps: a rebuild can produce the same size, and going by mtime alone is
  // how a changed icon sits there looking correct while Raycast keeps showing the old one.
  if (source.size !== dest.size) return true;
  return !fs.readFileSync(sourcePath).equals(fs.readFileSync(destPath));
}

/**
 * Copy `from` (a file or a directory) over `to`, refreshing whatever differs.
 * Returns how many files were copied.
 */
export function syncArtifacts(from, to) {
  const source = fs.statSync(from);

  if (!source.isDirectory()) {
    if (!shouldCopy(from, to)) return 0;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return 1;
  }

  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(from)) {
    copied += syncArtifacts(path.join(from, entry), path.join(to, entry));
  }
  return copied;
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
