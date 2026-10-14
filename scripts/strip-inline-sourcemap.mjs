// Only handles the kind of inline sourcemap esbuild appends to the end of a file — the last line is a
// sourceMappingURL comment followed by a whole base64 JSON blob.
// On a match it returns the extracted { code, map }; on no match it returns null (files referencing an external .map, or with none to begin with, are left untouched).
const INLINE_MAP_RE = /\r?\n\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/;

/**
 * Whether a bundle we could not strip may be handed to Raycast anyway.
 *
 * Only a file that plainly has no map to read is fine as-is. A file still being written is not, and it
 * does not look like one: NTFS gives it its final size the moment the first chunk lands, so a file mid-
 * write passes every size-and-mtime check while its unflushed tail reads back as NUL bytes. The last
 * read of this kind was 35 MB — 9.6 MB of code and inline map, then 3.9 MB of zeros where the base64
 * map had been cut off. Raycast parses that as a 21 MB string literal and reports "Command terminated
 * after reaching the extension memory limit". An inline map we failed to strip is refused for the same
 * reason: it is the 35 MB shape that blows the 100 MB heap.
 */
export function isPublishableAsIs(source) {
  return !source.includes("\0") && !source.includes("sourceMappingURL=data:");
}

export function stripInlineSourcemap(source, mapName) {
  const match = INLINE_MAP_RE.exec(source);
  if (!match) {
    return null;
  }

  return {
    code: `${source.slice(0, match.index)}\n//# sourceMappingURL=${mapName}\n`,
    map: Buffer.from(match[1], "base64").toString("utf8"),
  };
}
