/**
 * Rex surface layer. tmux.ts routes to it whenever pi runs inside Rex.
 *
 * Each subagent gets its own Rex tab (a window in the parent's session),
 * opened without taking focus. Surfaces are Rex block ids (`block:…`).
 * Every command is scoped to the parent's session (`$REX_SESSION`): Rex only
 * resolves a block id inside its session.
 */
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export function readScreen(surface: string, lines = 50): string {
  return lastLines(rex(["capture", "-b", surface, "--trim"]), lines);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync(
    rexBin() ?? "rex",
    ["-s", process.env.REX_SESSION!, "capture", "-b", surface, "--trim"],
    { encoding: "utf8" },
  );
  return lastLines(stdout, lines);
}

/** Close the block; its tab closes with it. */
export function closeSurface(surface: string): void {
  rex(["block", "close", surface]);
}
