/** Options collected from the UI and handed to the bounce job. */

export type NamingMode = "clip" | "track-index" | "custom-index";
export type Format = "wav" | "aiff" | "mp3" | "ogg";
export type Depth = 16 | 24 | 32;

export interface BounceOptions {
  outputDir: string;

  naming: {
    mode: NamingMode;
    /** Used by "custom-index". */
    customName: string;
    startIndex: number;
    /** Zero-pad the index to the width of the largest index. */
    padIndex: boolean;
  };

  normalize: {
    enabled: boolean;
    /** Peak target in dBFS, e.g. -0.3. */
    targetDb: number;
  };

  channels: {
    /** Always fold down to a single channel. */
    mono: boolean;
    /** Fold down only when L and R are identical ("fake stereo"). */
    monoIfFakeStereo: boolean;
  };

  trim: {
    start: boolean;
    end: boolean;
    /** Silence threshold in dBFS, e.g. -60. */
    thresholdDb: number;
  };

  /** Fades are baked into existing audio — they never change the length. */
  fade: {
    inMs: number;
    outMs: number;
  };

  /** Padding does change the length. */
  pad: {
    startMs: number;
    endMs: number;
  };

  output: {
    format: Format;
    /** PCM formats only. */
    depth: Depth;
    /** 0 keeps the rendered rate. */
    sampleRate: number;
    /** mp3/ogg only, in kbps. */
    bitrate: number;
  };
}

/** One clip queued for bouncing. */
export interface BounceTarget {
  clipName: string;
  trackName: string;
  /** In beats. */
  startTime: number;
  endTime: number;
}

export const DEFAULT_OPTIONS: BounceOptions = {
  outputDir: "",
  naming: { mode: "clip", customName: "Bounce", startIndex: 1, padIndex: true },
  normalize: { enabled: false, targetDb: -0.3 },
  channels: { mono: false, monoIfFakeStereo: false },
  trim: { start: false, end: false, thresholdDb: -60 },
  fade: { inMs: 0, outMs: 0 },
  pad: { startMs: 0, endMs: 0 },
  output: { format: "wav", depth: 24, sampleRate: 0, bitrate: 320 },
};
