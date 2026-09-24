import * as path from "node:path";
import { pathExists } from "./sandbox.js";
import type { BounceOptions, BounceTarget } from "./types.js";

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Strips characters no filesystem will take, without mangling the rest. */
export function sanitize(name: string, fallback = "Clip"): string {
  const cleaned = name
    .replace(ILLEGAL, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .slice(0, 120)
    .trim();
  if (!cleaned || RESERVED_WINDOWS.test(cleaned)) return fallback;
  return cleaned;
}

/**
 * Builds the file name for every target. Names are made unique against each
 * other and against files already in `outputDir` by appending ` 2`, ` 3`, …
 */
export function buildFileNames(
  targets: BounceTarget[],
  options: BounceOptions,
  extension: string,
): string[] {
  const { mode, customName, startIndex, padIndex } = options.naming;
  const width = padIndex
    ? String(startIndex + targets.length - 1).length
    : 1;

  const taken = new Set<string>();
  return targets.map((target, i) => {
    const index = String(startIndex + i).padStart(width, "0");
    let base: string;
    switch (mode) {
      case "clip":
        base = sanitize(target.clipName, sanitize(target.trackName));
        break;
      case "track-index":
        base = `${sanitize(target.trackName, "Track")} ${index}`;
        break;
      case "custom-index":
        base = `${sanitize(customName, "Bounce")} ${index}`;
        break;
    }
    return path.basename(uniquePath(options.outputDir, base, extension, taken));
  });
}

function uniquePath(
  dir: string,
  base: string,
  extension: string,
  taken: Set<string>,
): string {
  let candidate = `${base}.${extension}`;
  let counter = 2;
  while (taken.has(candidate.toLowerCase()) || pathExists(path.join(dir, candidate))) {
    candidate = `${base} ${counter}.${extension}`;
    counter += 1;
  }
  taken.add(candidate.toLowerCase());
  return path.join(dir, candidate);
}
