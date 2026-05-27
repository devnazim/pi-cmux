import assert from "node:assert/strict";
import test from "node:test";

import { formatDoneTitle, handlePiCmuxNotification } from "../src/index.js";

import type { PiCmuxConfig } from "../src/types.js";

test("formats done notification titles with optional session names", () => {
  assert.equal(formatDoneTitle(undefined), "Pi done");
  assert.equal(formatDoneTitle(""), "Pi done");
  assert.equal(formatDoneTitle("  Refactor auth  "), "Pi done: Refactor auth");
});

test("handles optional notifications before status and log work", async () => {
  const calls: string[] = [];
  const config: PiCmuxConfig = {
    notifications: { done: true, error: true, xplan: true },
    status: true,
    logs: true,
  };

  await handlePiCmuxNotification(
    { title: "Permission required", source: "cwd-guard", status: { text: "waiting", icon: "lock" } },
    config,
    {
      async notify() {
        calls.push("notify");
      },
      async setStatus() {
        calls.push("setStatus");
      },
      async clearStatus() {
        calls.push("clearStatus");
      },
      async log() {
        calls.push("log");
      },
    },
  );

  assert.deepEqual(calls, ["notify", "setStatus", "log"]);
});
