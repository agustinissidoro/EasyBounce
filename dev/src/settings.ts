import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_OPTIONS, type BounceOptions } from "./types.js";

export interface Settings {
  options: BounceOptions;
  /** Empty means "look for ffmpeg on PATH and in the usual places". */
  ffmpegPath: string;
}

/** Remembers the last used options between Live sessions. */
export class SettingsStore {
  private readonly file: string | undefined;

  constructor(storageDirectory: string | undefined) {
    this.file = storageDirectory
      ? path.join(storageDirectory, "settings.json")
      : undefined;
  }

  load(): Settings {
    const fallback: Settings = {
      options: { ...DEFAULT_OPTIONS, outputDir: defaultOutputDir() },
      ffmpegPath: "",
    };
    if (!this.file) return fallback;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Settings>;
      return {
        options: mergeOptions(fallback.options, saved.options),
        ffmpegPath: typeof saved.ffmpegPath === "string" ? saved.ffmpegPath : "",
      };
    } catch {
      return fallback;
    }
  }

  save(settings: Settings): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(settings, null, 2));
    } catch (error) {
      console.warn(`easybounce: could not save settings: ${String(error)}`);
    }
  }
}

export function defaultOutputDir(): string {
  return path.join(os.homedir(), "Music", "EasyBounce");
}

/** Section-wise merge so options added in a later version keep their defaults. */
function mergeOptions(
  base: BounceOptions,
  saved: Partial<BounceOptions> | undefined,
): BounceOptions {
  if (!saved) return base;
  return {
    outputDir: saved.outputDir ?? base.outputDir,
    naming: { ...base.naming, ...saved.naming },
    normalize: { ...base.normalize, ...saved.normalize },
    channels: { ...base.channels, ...saved.channels },
    trim: { ...base.trim, ...saved.trim },
    fade: { ...base.fade, ...saved.fade },
    pad: { ...base.pad, ...saved.pad },
    output: { ...base.output, ...saved.output },
  };
}
