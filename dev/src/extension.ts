import { execFile } from "node:child_process";
import { initialize, type ActivationContext, type ExtensionContext } from "@ableton-extensions/sdk";
import { extensionFor, runBounce, type BounceJob, type BounceSummary } from "./bounce.js";
import { FfmpegMissingError, findFfmpeg, supportedFormats } from "./ffmpeg.js";
import { buildFileNames } from "./naming.js";
import { DialogServer } from "./server.js";
import { SettingsStore } from "./settings.js";
import { resolveScope, type ResolvedScope } from "./targets.js";
import type { BounceOptions } from "./types.js";

// esbuild inlines these HTML files as strings.
import bounceDialog from "../ui/interface.html";
import summaryDialog from "../ui/summary.html";

type Ctx = ExtensionContext<"1.0.0">;

/** What the dialog posts back when the user hits Bounce. */
interface DialogResult {
  options: BounceOptions;
  ffmpegPath: string;
}

/** Which clips a command bounces. The menu entry decides this, not the dialog. */
type Which = "selection" | "track";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const settings = new SettingsStore(context.environment.storageDirectory);

  // Each menu entry gets its own command id. Reusing one id across scopes is
  // ambiguous for the host, and the entry that goes missing or appears twice
  // is not worth the saved line.
  const entries = [
    // In the arrangement, the track entry comes from the selection scope alone.
    // That scope fires wherever the pointer is — over a clip or over empty
    // space — and it carries the lane, which is all the track entry needs. The
    // clip scope would supply it too, so registering both is what drew it twice
    // over a clip while leaving empty space with nothing.
    {
      scope: "AudioTrack.ArrangementSelection",
      title: "Bounce all clips in track…",
      command: "easybounce.bounceTrack.fromArrangement",
      which: "track",
    },
    {
      scope: "AudioTrack.ArrangementSelection",
      title: "Bounce clips in selection…",
      command: "easybounce.bounceSelection",
      which: "selection",
    },
    // The track header is a separate scope that the selection never covers.
    {
      scope: "AudioTrack",
      title: "Bounce all clips in track…",
      command: "easybounce.bounceTrack.fromTrack",
      which: "track",
    },
  ] as const;

  for (const entry of entries) {
    context.commands.registerCommand(entry.command, (...args: unknown[]) => {
      void bounceCommand(context, settings, args[0], entry.which).catch(
        (error: unknown) => {
          console.error(`easybounce: ${String(error)}`);
        },
      );
    });
  }

  // Registrations are awaited one at a time, and each result is logged: when a
  // menu entry does not appear, the host log is the only place that can say
  // whether it was ever registered.
  void (async () => {
    for (const entry of entries) {
      try {
        await context.ui.registerContextMenuAction(
          entry.scope,
          entry.title,
          entry.command,
        );
        console.log(`easybounce: registered "${entry.title}" on ${entry.scope}`);
      } catch (error) {
        console.error(
          `easybounce: FAILED to register "${entry.title}" on ${entry.scope}: ${String(error)}`,
        );
      }
    }
  })();
}

async function bounceCommand(
  context: Ctx,
  settings: SettingsStore,
  argument: unknown,
  which: Which,
): Promise<void> {
  const scope = resolveScope(context, argument);
  if (scope.tracks.length === 0) {
    await showMessage(context, "Easy Bounce needs an audio track — MIDI tracks have to be frozen or resampled first.");
    return;
  }

  const jobs = jobsFor(scope, which);
  if (jobs.length === 0) {
    await showMessage(
      context,
      which === "selection"
        ? "There are no clips in the selection."
        : "There are no clips on this track's main arrangement lane.",
    );
    return;
  }

  const stored = settings.load();
  let ffmpegStatus = "";
  let formats: Record<string, boolean> = { wav: true, aiff: true, mp3: true, ogg: true };
  try {
    formats = await supportedFormats(findFfmpeg(stored.ffmpegPath || undefined));
  } catch (error) {
    ffmpegStatus = error instanceof FfmpegMissingError ? error.message : String(error);
  }

  const server = new DialogServer(bounceDialog, {
    preview: (request) => {
      const { options } = request as DialogResult;
      return previewNames(scope, which, options);
    },
    context: () => ({
      settings: stored,
      ffmpegStatus,
      formats,
      which,
      clipCount: jobs.length,
      trackNames: scope.tracks.map((track) => track.trackName),
      skippedTakeLaneClips: scope.skippedTakeLaneClips,
    }),
  });

  const url = await server.start();
  let raw: string;
  try {
    raw = await context.ui.showModalDialog(url, 720, 700);
  } finally {
    await server.stop();
  }
  if (!raw) return;

  const result = JSON.parse(raw) as DialogResult;
  settings.save({ options: result.options, ffmpegPath: result.ffmpegPath });

  let summary: BounceSummary;
  try {
    summary = (await context.ui.withinProgressDialog(
      `Bouncing ${jobs.length} clip${jobs.length === 1 ? "" : "s"}…`,
      { progress: 0 },
      (update, signal) =>
        runBounce(context, jobs, result.options, result.ffmpegPath, update, signal),
    )) as BounceSummary;
  } catch (error) {
    // Anything that stops the whole run — no ffmpeg, an unwritable folder —
    // belongs in front of the user, not only in the log.
    await showMessage(context, error instanceof Error ? error.message : String(error));
    return;
  }

  await showSummary(context, summary);
}

function jobsFor(scope: ResolvedScope, which: Which): BounceJob[] {
  const jobs: BounceJob[] = [];
  for (const trackScope of scope.tracks) {
    const clips =
      which === "selection" ? trackScope.selectionClips : trackScope.allClips;
    for (const target of clips) jobs.push({ track: trackScope.track, target });
  }
  return jobs.sort((a, b) => a.target.startTime - b.target.startTime);
}

/** Names the bounce would produce, used by the dialog's preview. */
function previewNames(
  scope: ResolvedScope,
  which: Which,
  options: BounceOptions,
): string[] {
  return buildFileNames(
    jobsFor(scope, which).map((job) => job.target),
    options,
    extensionFor(options.output.format),
  );
}

async function showSummary(context: Ctx, summary: BounceSummary): Promise<void> {
  const payload = encodeURIComponent(JSON.stringify(summary));
  const html = summaryDialog.replace("__SUMMARY__", payload);
  const action = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(html)}`,
    460,
    320,
  );
  if (action === "reveal") revealInFileManager(summary.outputDir);
}

async function showMessage(context: Ctx, text: string): Promise<void> {
  const html = summaryDialog.replace(
    "__SUMMARY__",
    encodeURIComponent(JSON.stringify({ message: text })),
  );
  await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 460, 220);
}

function revealInFileManager(dir: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  execFile(command, [dir], () => {});
}
