/**
 * Integration tests for the Rex surface layer, through tmux.ts's routing.
 *
 * Each run creates a throwaway Rex session, points REX_SESSION/REX_BLOCK at
 * it (so it never touches the caller's own session), and kills it after.
 * No LLM calls. Skipped when the rex CLI is missing.
 *
 *   node --test test/integration/rex-surface.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const rexBin = process.env.REX_BIN_DIR ? join(process.env.REX_BIN_DIR, "rex") : "rex";

function rex(args: string[]): string {
  return execFileSync(rexBin, args, { encoding: "utf8" });
}

let available = true;
try {
  rex(["--help"]);
} catch {
  available = false;
  console.log("⚠️  rex is not available — skipping rex-surface integration tests");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("rex-surface", { skip: !available, timeout: 60_000 }, () => {
  let session: string;
  let mux: typeof import("../../pi-extension/subagents/tmux.ts");

  function windows(): { window_id: string; label: string }[] {
    return JSON.parse(rex(["window", "ls", "-s", session, "--json"])).windows;
  }

  function activeWindow(): string {
    return JSON.parse(rex(["session", "inspect", session, "--json"])).active_window_id;
  }

  before(async () => {
    const created = JSON.parse(rex(["new", `pi-subagents-test-${process.pid}`, "--json"]));
    session = created.session_id;
    process.env.REX_SESSION = session;
    process.env.REX_BLOCK = created.initial_windows[0].block_ids[0];
    delete process.env.TMUX;
    mux = await import("../../pi-extension/subagents/tmux.ts");
  });

  after(() => {
    if (session) rex(["kill", session]);
  });

  it("is available inside Rex without tmux", () => {
    assert.equal(mux.isMuxAvailable(), true);
  });

  it("runs a subagent command in its own tab in pi's directory, reports its exit and closes the tab", async () => {
    const active = activeWindow();
    const surface = mux.createSurface("scout");
    assert.match(surface, /^block:/);
    assert.equal(activeWindow(), active, "the new tab must not take focus");
    assert.ok(windows().some((window) => window.label === "scout"));

    await sleep(1500);
    mux.sendLongCommand(surface, "echo working-$((40 + 2)) in $PWD; (exit 3); echo '__SUBAGENT_DONE_'$?'__'");
    const result = await mux.pollForExit(surface, new AbortController().signal, { interval: 200 });
    assert.deepEqual(result, { reason: "sentinel", exitCode: 3 });
    assert.ok(mux.readScreen(surface, 200).includes(`working-42 in ${process.cwd()}`));

    mux.closeSurface(surface);
    assert.ok(!windows().some((window) => window.label === "scout"), "closing the block closes its tab");
  });

  it("types text literally, including a leading dash and quotes", async () => {
    const surface = mux.createSurface("literal");
    await sleep(1500);
    mux.sendCommand(surface, "-n 'it''s' \"$HOME\"");
    await sleep(800);
    assert.match(mux.readScreen(surface, 20), /-n 'it''s' "\$HOME"/);
    mux.closeSurface(surface);
  });
});
