// The dialog and the extension talk through one plain object, and a mismatch
// between them fails at runtime inside a webview where nothing is watching.
// This checks the two sides still agree, in both directions: a key the page
// reads must be sent, and a key that is sent must be read.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const page = fs.readFileSync(path.join(root, "ui/interface.html"), "utf8");

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(36)} ${detail}`);
  if (!ok) failures += 1;
};

/** Top-level keys of the `context: () => ({ … })` payload literal. */
function payloadKeys(): string[] {
  const start = source.indexOf("context: () => ({");
  if (start === -1) throw new Error("context payload not found in src/extension.ts");
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("({", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(source.indexOf("({", start) + 2, end);

  // Keys at the literal's own nesting level, whether `key: value` or shorthand.
  const keys: string[] = [];
  let nesting = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (nesting === 0) {
      const match = /^([A-Za-z_$][\w$]*)\s*[:,]/.exec(trimmed);
      if (match) keys.push(match[1]);
    }
    nesting += (line.match(/[{[(]/g) ?? []).length - (line.match(/[}\])]/g) ?? []).length;
  }
  return keys;
}

const sent = new Set(payloadKeys());
const read = new Set(
  [...page.matchAll(/context\??\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]),
);

check("payload parsed", sent.size > 0, [...sent].join(", "));

const missing = [...read].filter((key) => !sent.has(key));
check("every key the dialog reads is sent", missing.length === 0, missing.join(", ") || "none missing");

const unused = [...sent].filter((key) => !read.has(key));
check("every key sent is read", unused.length === 0, unused.join(", ") || "none unused");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
