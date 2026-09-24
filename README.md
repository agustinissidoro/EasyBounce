# Easy Bounce

An Ableton Live extension that bounces every clip on a track to its own audio
file. Right-click a clip, a track header, or an arrangement time selection to
find it.

## What it does

**Two menu entries**
- **Bounce all clips in track…** — right-click anywhere in an audio track's
  arrangement (over a clip or over empty space), or the track header
- **Bounce clips in selection…** — right-click an arrangement time selection,
  covering every clip that overlaps the selected range

Both arrangement entries come from the `AudioTrack.ArrangementSelection` scope,
which fires wherever the pointer is and carries the lane. The `AudioClip` scope
overlaps it over a clip, so registering there as well is what drew an entry
twice; the track header is the one scope the selection never covers.

**Naming**
- Clip name
- Track name + index
- Custom name + index

Index start and zero-padding are configurable. Names are sanitized for the
filesystem and never overwrite each other or files already in the folder —
collisions get ` 2`, ` 3`, … appended.

**Processing**
- Normalize to a peak target in dBFS
- Bounce to mono
- Bounce to mono only when the source is fake stereo (both channels identical)
- Trim silent start / silent end, with a threshold in dBFS
- Bake a fade in / fade out in milliseconds, carved out of the audio that is
  already there so the length does not change
- Add silence at the start / end, which does change the length

**Output**
- WAV, AIFF, MP3, Ogg Vorbis
- 16 / 24 / 32 bit for the PCM formats, bitrate for the compressed ones
- Sample rate, or whatever Live rendered at

## Requirements

- Ableton Live with Extensions support, and Node.js 24.14.1+ for development.
- **ffmpeg**, which does all the offline processing and encoding.
  `brew install ffmpeg` on macOS, `winget install ffmpeg` on Windows. It is
  found on `PATH` and in the usual install locations; if it is somewhere else,
  the dialog has a field for the path. Formats your ffmpeg build cannot encode
  (commonly Ogg Vorbis, sometimes MP3) are greyed out rather than failing
  halfway through a bounce.

## Limitations

These come from what Live's extension API exposes, not from choices here:

- **Arrangement audio tracks only.** The only render call in the API is
  `resources.renderPreFxAudio`, which takes an audio track and a beat range.
  Session clips and MIDI tracks cannot be rendered — freeze, flatten or
  resample a MIDI track first.
- **Pre-effects.** What lands on disk is the clip as the track plays it — clip
  gain, warping, clip fades and transposition included — but *not* the track's
  device chain, mixer volume, pan or sends.
- **Main lane only.** Clips on take lanes are counted and reported, but not
  bounced: rendering goes through the track's output, which plays the main lane.

## Development

The path to Live's Extension Host module lives in `.env` as
`EXTENSION_HOST_PATH`.

```sh
npm start         # build + run in Live's Extension Host
npm test          # pipeline, naming and dialog-server checks (needs ffmpeg)
npm run build     # production bundle of src/extension.ts
npm run package   # build + create a .ablx archive
```

## How it is put together

| File | Role |
| --- | --- |
| [src/extension.ts](src/extension.ts) | Activation, context-menu commands, dialog and progress flow |
| [src/targets.ts](src/targets.ts) | Turns a clip / track / selection handle into the clips to bounce |
| [src/bounce.ts](src/bounce.ts) | Renders each clip and post-processes it |
| [src/audio.ts](src/audio.ts) | Builds and runs the ffmpeg filter chain |
| [src/ffmpeg.ts](src/ffmpeg.ts) | Locating ffmpeg, running it, analysis passes |
| [src/naming.ts](src/naming.ts) | File naming and collision handling |
| [src/server.ts](src/server.ts) | Loopback server backing the dialog |
| [ui/interface.html](ui/interface.html) | The bounce dialog |

The extension host's JS runtime does not provide the web globals — no `URL`,
`Buffer` or `fetch` — so everything under `src/` imports them from `node:`
modules instead. `test/host-globals.test.mts` deletes those globals and
exercises the code without them to keep it that way.

Live's modal dialogs can only post a single message back, which is not enough
for a folder picker or a live name preview. The dialog is therefore served over
`http://localhost` — a scheme `showModalDialog` accepts — from a server that
exists only while the dialog is open, on a random port behind a random token.

Analysis runs in separate ffmpeg passes so each measurement sees exactly the
audio the next stage acts on: silence bounds first, then the peak of the
already-trimmed, already-folded, already-faded signal, then one encode pass.
