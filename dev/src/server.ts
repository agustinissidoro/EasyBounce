import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import { isDirectory as isExistingDirectory, isWritableDirectory } from "./sandbox.js";
import { Buffer } from "node:buffer";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
// The extension host's JS runtime does not provide the web globals, so URL and
// Buffer are imported rather than assumed.
import { URL } from "node:url";

/**
 * A short-lived loopback server that backs the bounce dialog.
 *
 * Live's modal dialog can only post one message back ("close and send"), which
 * is not enough for a folder picker or a live file-name preview. Serving the UI
 * from localhost — one of the schemes `showModalDialog` accepts — gives the page
 * a normal HTTP API to talk to while it is open. The URL carries a random token
 * so nothing else on the machine can drive it.
 */
export class DialogServer {
  private server: http.Server | undefined;
  private token = "";

  constructor(
    private readonly html: string,
    private readonly handlers: {
      /** Everything the dialog needs to draw itself. */
      context: () => unknown;
      /** Collision-aware file names for the current options. */
      preview: (request: unknown) => string[];
    },
  ) {}

  async start(): Promise<string> {
    this.token = crypto.randomBytes(16).toString("hex");
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        json(response, 500, { error: String(error) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });

    const { port } = this.server!.address() as AddressInfo;
    return `http://localhost:${port}/${this.token}/`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments[0] !== this.token) {
      json(response, 404, { error: "not found" });
      return;
    }
    const route = segments.slice(1).join("/");

    if (route === "" || route === "index.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(this.html);
      return;
    }

    if (route === "api/context") {
      json(response, 200, this.handlers.context());
      return;
    }

    if (route === "api/preview") {
      const body = await readJson(request);
      json(response, 200, { names: this.handlers.preview(body) });
      return;
    }

    if (route === "api/browse") {
      json(response, 200, { path: await chooseFolder() });
      return;
    }

    if (route === "api/check-dir") {
      const dir = url.searchParams.get("dir") ?? "";
      json(response, 200, { exists: isDirectory(dir), writable: canCreate(dir) });
      return;
    }

    json(response, 404, { error: "not found" });
  }
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

function isDirectory(dir: string): boolean {
  return dir.length > 0 && isExistingDirectory(dir);
}

/** Whether the directory exists or could be created on the spot. */
function canCreate(dir: string): boolean {
  if (isDirectory(dir)) return isWritableDirectory(dir);
  return dir.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(dir);
}

/** Opens the OS folder picker. Resolves to null if the user cancels. */
function chooseFolder(): Promise<string | null> {
  if (process.platform === "darwin") {
    return runPicker("osascript", [
      "-e",
      'tell application "System Events" to activate',
      "-e",
      'POSIX path of (choose folder with prompt "Choose a folder for the bounced files")',
    ]);
  }
  if (process.platform === "win32") {
    return runPicker("powershell", [
      "-NoProfile",
      "-STA",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; " +
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
        "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
    ]);
  }
  return Promise.resolve(null);
}

function runPicker(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5 * 60_000 }, (error, stdout) => {
      const value = stdout.trim();
      resolve(error || !value ? null : value);
    });
  });
}
