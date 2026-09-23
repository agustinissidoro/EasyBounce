// Regression test for the extension host's JS runtime, which does not provide
// the web globals (`URL`, `Buffer`, `fetch`). Nothing under src/ may rely on
// them.
//
// `npm test` bundles this file with esbuild and runs it on plain node: with a
// loader such as tsx in the process, the deletions below would break the
// loader rather than test our code. Requests use node:http for the same
// reason — fetch is one of the globals being removed.
import * as http from "node:http";
import { buildFileNames } from "../src/naming.js";
import { DialogServer } from "../src/server.js";
import { DEFAULT_OPTIONS } from "../src/types.js";

// Imports are hoisted, so the modules load while the globals still exist and
// are then exercised without them — which is what the host actually does.
const removed = ["URL", "URLSearchParams", "Buffer", "fetch", "structuredClone"];
const saved = new Map(removed.map((name) => [name, (globalThis as never)[name]]));
for (const name of removed) delete (globalThis as Record<string, unknown>)[name];

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(36)} ${detail}`);
  if (!ok) failures += 1;
};

function request(url: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = saved.get("URL") as typeof URL;
    const { hostname, port, pathname } = new target(url);
    const call = http.request(
      { hostname, port, path: pathname, method: body ? "POST" : "GET" },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, text }),
        );
      },
    );
    call.on("error", reject);
    call.end(body);
  });
}

const server = new DialogServer("<html>ui</html>", {
  context: () => ({ ok: true }),
  preview: (input) =>
    buildFileNames(
      [{ clipName: "Kick", trackName: "Drums", startTime: 0, endTime: 4 }],
      { ...DEFAULT_OPTIONS, outputDir: "/nonexistent", ...(input as object) },
      "wav",
    ),
});

const url = await server.start();
check("server starts without web globals", url.startsWith("http://localhost:"), url);

const page = await request(url);
check("serves the dialog page", page.status === 200 && page.text === "<html>ui</html>", `${page.status}`);

const context = await request(`${url}api/context`);
check("context endpoint", context.text === '{"ok":true}', context.text);

const preview = await request(`${url}api/preview`, JSON.stringify({}));
check("preview endpoint parses a body", preview.text === '{"names":["Kick.wav"]}', preview.text);

const rejected = await request(url.replace(/\/[0-9a-f]{32}\/$/, "/deadbeef/api/context"));
check("wrong token still rejected", rejected.status === 404, String(rejected.status));

await server.stop();
for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
