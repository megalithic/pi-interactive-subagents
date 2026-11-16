/**
 * Rex surface layer. tmux.ts routes to it whenever pi runs inside Rex.
 *
 * Each subagent gets its own Rex tab (a window in the parent's session),
 * opened without taking focus. Surfaces are Rex block ids (`block:…`).
 * Every command is scoped to the parent's session (`$REX_SESSION`): Rex only
 * resolves a block id inside its session.
 */
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";

let rexBinary: string | null | undefined;

/** The rex binary: `$REX_BIN_DIR/rex` (set by Rex in each terminal), else `rex` on PATH. */
function rexBin(): string | null {
  if (rexBinary !== undefined) return rexBinary;
  const candidates = process.env.REX_BIN_DIR ? [join(process.env.REX_BIN_DIR, "rex"), "rex"] : ["rex"];
  rexBinary = null;
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--help"], { stdio: "ignore", timeout: 5000 });
      rexBinary = candidate;
      break;
    } catch {}
  }
  return rexBinary;
}

/** True when pi runs in a Rex terminal and the rex CLI works. */
export function isRexAvailable(): boolean {
  return !!process.env.REX_SESSION && !!process.env.REX_BLOCK && !!rexBin();
}

function rex(args: string[]): string {
  return execFileSync(rexBin() ?? "rex", ["-s", process.env.REX_SESSION!, ...args], {
    encoding: "utf8",
  });
}

function newBlockId(output: string, command: string): string {
  const block = JSON.parse(output)?.block_ids?.[0];
  if (typeof block !== "string" || !block.startsWith("block:")) {
    throw new Error(`Unexpected rex ${command} output: ${output.trim()}`);
  }
  return block;
}

/**
 * Open a new tab named after the subagent, leaving focus where it is. It starts
 * in pi's directory: a Rex terminal otherwise starts in the home directory.
 */
export function createSurface(name: string): string {
  return newBlockId(
    rex(["window", "new", name, "-c", process.cwd(), "--focus=false", "--json"]),
    "window new",
  );
}

/** Split a block (default: the parent pi's) without taking focus. */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const split = { left: "left", right: "right", up: "above", down: "below" }[direction];
  const anchor = fromSurface ?? process.env.REX_BLOCK!;
  const args = ["split", "-b", anchor, `--split=${split}`, "-c", process.cwd()];
  return newBlockId(rex([...args, "--focus=false", "--label", name, "--json"]), "split");
}

/** Type a command literally, then press Enter. */
export function sendCommand(surface: string, command: string): void {
  rex(["send", "-b", surface, "--", command]);
  rex(["send-key", "-b", surface, "enter"]);
}

/**
 * The last lines of a block's screen and scrollback. tmux returns the visible
 * screen plus `lines` of history; Rex captures it all, so keep a screenful
 * (50 rows) on top of `lines`.
 */
function lastLines(text: string, lines: number): string {
  return text.split("\n").slice(-(Math.max(1, lines) + 50)).join("\n");
}

/** Rex keeps up to ~64 MiB of scrollback and `capture` has no line limit. */
const CAPTURE_MAX_BUFFER = 256 * 1024 * 1024;

/** Bytes of capture output the polling read keeps: far more than 250 lines. */
const CAPTURE_TAIL_BYTES = 512 * 1024;

/** One-off read (the summary fallback at exit): buffer it all, keep the tail. */
export function readScreen(surface: string, lines = 50): string {
  const output = execFileSync(
    rexBin() ?? "rex",
    ["-s", process.env.REX_SESSION!, "capture", "-b", surface, "--trim"],
    { encoding: "utf8", maxBuffer: CAPTURE_MAX_BUFFER },
  );
  return lastLines(output, lines);
}

/**
 * The exit poll reads every second, so it streams the capture and keeps only
 * its tail: a verbose subagent's scrollback must neither overflow a buffer
 * nor be held whole in memory.
 */
export function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      rexBin() ?? "rex",
      ["-s", process.env.REX_SESSION!, "capture", "-b", surface, "--trim"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let tail = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > CAPTURE_TAIL_BYTES) tail = tail.subarray(tail.length - CAPTURE_TAIL_BYTES);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(lastLines(tail.toString("utf8"), lines));
      else reject(new Error(`rex capture failed (${code}): ${stderr.trim()}`));
    });
  });
}

/** Close the block; its tab closes with it. */
export function closeSurface(surface: string): void {
  rex(["block", "close", surface]);
}
