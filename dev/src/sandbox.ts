import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/*
 * Live runs installed extensions under Node's permission model: this process
 * may only read and write the extension's own storage and temp directories.
 * The output folder (~/Music/EasyBounce by default, or one the user picks) and
 * the ffmpeg binary are outside it, and touching them with `fs` throws
 * ERR_ACCESS_DENIED — which the checks below would otherwise read as "missing".
 *
 * Child processes are allowed and are not sandboxed, so paths outside the
 * sandbox are checked and created with small system tools instead. Inside it,
 * and when running unsandboxed via `extensions-cli run`, plain `fs` is used.
 * ffmpeg writes the output files itself, so it needs no help here.
 */

export function canRead(target: string): boolean {
  return process.permission?.has("fs.read", target) ?? true;
}

export function canWrite(target: string): boolean {
  return process.permission?.has("fs.write", target) ?? true;
}

export function pathExists(target: string): boolean {
  if (canRead(target)) return fs.existsSync(target);
  return succeeds(
    isWindows()
      ? powershell(`if (Test-Path -LiteralPath ${quote(target)}) { exit 0 } else { exit 1 }`)
      : ["/bin/test", ["-e", target]],
  );
}

export function isDirectory(target: string): boolean {
  if (canRead(target)) {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  }
  return succeeds(
    isWindows()
      ? powershell(`if (Test-Path -LiteralPath ${quote(target)} -PathType Container) { exit 0 } else { exit 1 }`)
      : ["/bin/test", ["-d", target]],
  );
}

export function isWritableDirectory(target: string): boolean {
  if (canRead(target) && canWrite(target)) {
    try {
      fs.accessSync(target, fs.constants.W_OK);
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  }
  if (isWindows()) {
    // Windows has no cheap writability test, so try creating a file.
    return succeeds(
      powershell(
        `$probe = Join-Path ${quote(target)} ('.eb-' + [guid]::NewGuid()); ` +
          `New-Item -ItemType File -Path $probe -ErrorAction Stop | Out-Null; Remove-Item -LiteralPath $probe`,
      ),
    );
  }
  return succeeds(["/bin/test", ["-d", target, "-a", "-w", target]]);
}

export function isExecutableFile(target: string): boolean {
  if (canRead(target)) {
    try {
      fs.accessSync(target, fs.constants.X_OK);
      return fs.statSync(target).isFile();
    } catch {
      return false;
    }
  }
  return succeeds(
    isWindows()
      ? powershell(`if (Test-Path -LiteralPath ${quote(target)} -PathType Leaf) { exit 0 } else { exit 1 }`)
      : ["/bin/test", ["-f", target, "-a", "-x", target]],
  );
}

/** Creates `directory` and its parents if needed. Throws if that fails. */
export function makeDirectory(directory: string): void {
  if (canWrite(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    return;
  }
  try {
    run(
      isWindows()
        ? powershell(`New-Item -ItemType Directory -Force -Path ${quote(directory)} | Out-Null`)
        : ["/bin/mkdir", ["-p", directory]],
    );
  } catch (error) {
    throw new Error(`Could not create the output folder ${directory}: ${describe(error)}`);
  }
}

type Command = [file: string, args: string[]];

function isWindows(): boolean {
  return process.platform === "win32";
}

function powershell(script: string): Command {
  return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]];
}

/** Single-quoted PowerShell literal. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function run([file, args]: Command): void {
  execFileSync(file, args, { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
}

function succeeds(command: Command): boolean {
  try {
    run(command);
    return true;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}
