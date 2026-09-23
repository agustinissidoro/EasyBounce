import {
  type ArrangementSelection,
  AudioTrack,
  Clip,
  ClipSlot,
  DataModelObject,
  TakeLane,
  Track,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";
import type { BounceTarget } from "./types.js";

type Ctx = ExtensionContext<"1.0.0">;

export interface TrackScope {
  track: AudioTrack<"1.0.0">;
  trackName: string;
  /** Every clip on the track's main arrangement lane. */
  allClips: BounceTarget[];
  /** The subset inside the arrangement time selection, if there was one. */
  selectionClips: BounceTarget[];
}

export interface ResolvedScope {
  tracks: TrackScope[];
  /** True when the command came from an arrangement time selection. */
  hasSelection: boolean;
  /** Clips skipped because they live on a take lane. */
  skippedTakeLaneClips: number;
}

/**
 * Turns the argument Live hands a context-menu command into the set of clips we
 * can bounce. Accepts a clip handle, a track handle, or an arrangement selection.
 */
export function resolveScope(context: Ctx, argument: unknown): ResolvedScope {
  if (isArrangementSelection(argument)) {
    const start = argument.time_selection_start;
    const end = argument.time_selection_end;
    const hasSelection = end > start;
    const tracks: TrackScope[] = [];
    let skipped = 0;

    for (const handle of argument.selected_lanes) {
      const lane = context.getObjectFromHandle(handle, DataModelObject);
      const track = trackOf(lane);
      if (!(track instanceof AudioTrack)) continue;
      if (tracks.some((t) => t.track.handle.id === track.handle.id)) continue;
      const scope = scopeForTrack(track, hasSelection ? [start, end] : undefined);
      skipped += countTakeLaneClips(track);
      tracks.push(scope);
    }
    return { tracks, hasSelection, skippedTakeLaneClips: skipped };
  }

  const object = context.getObjectFromHandle(argument as Handle, DataModelObject);
  const track = trackOf(object);
  if (!(track instanceof AudioTrack)) {
    return { tracks: [], hasSelection: false, skippedTakeLaneClips: 0 };
  }
  return {
    tracks: [scopeForTrack(track, undefined)],
    hasSelection: false,
    skippedTakeLaneClips: countTakeLaneClips(track),
  };
}

function scopeForTrack(
  track: AudioTrack<"1.0.0">,
  selection: [number, number] | undefined,
): TrackScope {
  const trackName = track.name;
  const all = track.arrangementClips.map((clip) => toTarget(clip, trackName));
  const selected = selection
    ? all.filter((c) => c.endTime > selection[0] && c.startTime < selection[1])
    : [];
  return { track, trackName, allClips: all, selectionClips: selected };
}

function toTarget(clip: Clip<"1.0.0">, trackName: string): BounceTarget {
  return {
    clipName: clip.name,
    trackName,
    startTime: clip.startTime,
    endTime: clip.endTime,
  };
}

/** Walks up the object hierarchy from a clip, take lane or slot to its track. */
function trackOf(object: DataModelObject<"1.0.0"> | null): Track<"1.0.0"> | null {
  let current: DataModelObject<"1.0.0"> | null = object;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof Track) return current;
    if (
      current instanceof Clip ||
      current instanceof TakeLane ||
      current instanceof ClipSlot
    ) {
      current = current.parent;
      continue;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Take-lane clips are counted only so the summary can mention them: rendering
 * goes through the track's output, which plays the main lane, so a take lane's
 * clips are not what would come out.
 */
function countTakeLaneClips(track: Track<"1.0.0">): number {
  let count = 0;
  for (const lane of track.takeLanes) count += lane.clips.length;
  return count;
}

function isArrangementSelection(value: unknown): value is ArrangementSelection {
  return (
    typeof value === "object" &&
    value !== null &&
    "selected_lanes" in value &&
    Array.isArray((value as { selected_lanes: unknown }).selected_lanes)
  );
}
