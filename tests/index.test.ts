import assert from "node:assert/strict";
import test from "node:test";

import { formatDoneTitle, handlePiCmuxNotification, registerPiCmuxExtension } from "../src/index.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

test("waits for Pi to fully settle across retries and queued continuations", async () => {
  type LifecycleContext = {
    hasPendingMessages(): boolean;
    isIdle(): boolean;
  };
  type LifecycleHandler = (event: unknown, ctx: LifecycleContext) => void | Promise<void>;

  const handlers = new Map<string, LifecycleHandler>();
  const calls: string[] = [];
  const config: PiCmuxConfig = {
    notifications: { done: true, error: true, xplan: true },
    status: true,
    logs: true,
  };
  const pi = {
    getSessionName: () => "Dependency update",
    on(event: string, handler: LifecycleHandler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  registerPiCmuxExtension(pi, config, {
    async reportShellState(state) {
      calls.push(`shell:${state}`);
    },
    async notify(input) {
      calls.push(`notify:${input.title}`);
    },
    async setStatus(_key, text) {
      calls.push(`status:${text}`);
    },
    async clearStatus(key) {
      calls.push(`clear:${key}`);
    },
    async log(message) {
      calls.push(`log:${message}`);
    },
  });

  assert.deepEqual([...handlers.keys()].sort(), ["agent_end", "agent_settled", "agent_start", "session_shutdown"]);

  const context = (pending: boolean, idle: boolean): LifecycleContext => ({
    hasPendingMessages: () => pending,
    isIdle: () => idle,
  });
  const agentStart = handlers.get("agent_start");
  const agentEnd = handlers.get("agent_end");
  const agentSettled = handlers.get("agent_settled");
  const sessionShutdown = handlers.get("session_shutdown");
  assert.ok(agentStart && agentEnd && agentSettled && sessionShutdown);

  await agentStart({}, context(false, false));
  assert.deepEqual(calls, ["shell:running", "status:working"]);

  calls.length = 0;
  await agentEnd({}, context(false, false));
  assert.deepEqual(calls, []);

  await agentStart({}, context(false, false));
  assert.deepEqual(calls, ["shell:running", "status:working"]);

  calls.length = 0;
  await agentEnd({}, context(true, false));
  assert.deepEqual(calls, ["shell:running", "status:queued"]);

  await agentStart({}, context(false, false));
  await agentEnd({}, context(false, false));
  assert.deepEqual(calls, ["shell:running", "status:queued", "shell:running", "status:working"]);

  calls.length = 0;
  await agentSettled({}, context(false, false));
  assert.deepEqual(calls, []);

  await agentSettled({}, context(false, true));
  assert.deepEqual(calls, [
    "notify:Pi done: Dependency update",
    "log:Pi done: Dependency update: ready for input",
    "shell:prompt",
    "clear:pi",
  ]);

  calls.length = 0;
  await sessionShutdown({}, context(false, true));
  assert.deepEqual(calls, ["shell:prompt", "clear:pi"]);
});
