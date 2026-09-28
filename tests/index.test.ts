import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CmuxClient } from "../src/cmux.js";
import { normalizeConfig } from "../src/config.js";
import { completionOutcome, formatDoneTitle, handlePiCmuxNotification, registerPiCmuxExtension } from "../src/index.js";
import { PI_CMUX_NOTIFY_SYMBOL, type PiCmuxConfig, type PiCmuxNotifier } from "../src/types.js";

type Client = Parameters<typeof registerPiCmuxExtension>[2];
type Context = {
  hasPendingMessages(): boolean;
  isIdle(): boolean;
  mode: "tui" | "json" | "rpc" | "print" | "sdk";
  ui: { notify(message: string, level: string): void };
};
type Handler = (event: { messages: unknown[]; kind?: string; title?: string }, ctx: Context) => void | Promise<void>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(config: PiCmuxConfig = normalizeConfig(undefined), overrides: Partial<Client> = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler(args: string, ctx: Context): Promise<void> }>();
  const calls: string[] = [];
  const targets: unknown[] = [];
  const statusKeys: string[] = [];
  const uiMessages: string[] = [];
  const target = { workspaceId: "workspace:1", surfaceId: "surface:1" };
  let name = "Dependency update";
  const client: Client = {
    async captureTarget() { calls.push("capture"); return target; },
    async reportShellState(state, scope) { calls.push(`shell:${state}`); targets.push(scope); return true; },
    async notify(input, scope, signal) { if (!signal?.aborted) { calls.push(`notify:${input.title}`); targets.push(scope); } },
    async setStatus(key, text, _options, scope) { calls.push(`status:${text}`); statusKeys.push(key); targets.push(scope); return "attempted"; },
    async clearStatus(key, scope) { calls.push("clear"); statusKeys.push(key); targets.push(scope); return true; },
    async log(message, options, scope) { calls.push(`log:${options?.level}:${message}`); targets.push(scope); },
    async getDiagnostics() {
      return { available: true, cli: "cmux", transport: "local", ...target, supportedCommands: ["log"], recentFailures: [] };
    },
    ...overrides,
  };
  const registration = registerPiCmuxExtension({
    getSessionName: () => name,
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    registerCommand(command: string, definition: { handler(args: string, ctx: Context): Promise<void> }) { commands.set(command, definition); },
  } as unknown as ExtensionAPI, config, client);
  const context: Context = {
    hasPendingMessages: () => false,
    isIdle: () => true,
    mode: "tui",
    ui: { notify: (message) => { uiMessages.push(message); } },
  };
  return {
    ...registration, calls, targets, statusKeys, commands, context, target, uiMessages, handlers,
    setName(value: string) { name = value; },
    emitPrompt(event: "ui_prompt_start" | "ui_prompt_end", ctx = context, title = "Private dialog title") {
      const handler = handlers.get(event);
      assert.ok(handler);
      return handler({ messages: [], kind: "confirm", title }, ctx);
    },
    emit(event: string, messages: unknown[] = [{ role: "assistant", stopReason: "stop" }], ctx = context) {
      const handler = handlers.get(event);
      assert.ok(handler, `Missing ${event} handler`);
      return handler({ messages }, ctx);
    },
  };
}

test("formats done notification titles with optional session names", () => {
  assert.equal(formatDoneTitle(undefined), "Pi done");
  assert.equal(formatDoneTitle(""), "Pi done");
  assert.equal(formatDoneTitle("  Refactor auth  "), "Pi done: Refactor auth");
});

test("classifies the latest assistant outcome without exposing its content", () => {
  assert.equal(completionOutcome([]), "unknown");
  assert.equal(completionOutcome([null, { role: "user" }]), "unknown");
  for (const stopReason of ["stop", "length", "toolUse"]) {
    assert.equal(completionOutcome([{ role: "assistant", stopReason }]), "success");
  }
  assert.equal(completionOutcome([{ role: "assistant", stopReason: "error" }]), "error");
  assert.equal(completionOutcome([{ role: "assistant", stopReason: "aborted" }]), "aborted");
  assert.equal(completionOutcome([{ role: "assistant", stopReason: "stop", cmuxSuppressNotification: true }]), "aborted");
  assert.equal(completionOutcome([
    { role: "assistant", stopReason: "error" }, { role: "assistant", stopReason: "stop" }, { role: "toolResult" },
  ]), "success");
});

test("handles optional notifications before status and log work", async () => {
  const calls: string[] = [];
  await handlePiCmuxNotification(
    { title: "Permission required", source: "cwd-guard", status: { text: "waiting", icon: "lock" } },
    normalizeConfig(undefined),
    {
      async notify() { calls.push("notify"); },
      async setStatus() { calls.push("setStatus"); return "attempted"; },
      async clearStatus() { calls.push("clearStatus"); return true; },
      async log() { calls.push("log"); },
    },
  );
  assert.deepEqual(calls, ["notify", "setStatus", "log"]);
});

test("waits for settlement across retries and queued continuations, then cleans up before notifying", async () => {
  const h = harness();
  assert.deepEqual(h.calls, [], "registration must not start I/O");
  h.emit("agent_start");
  await h.flush();
  assert.deepEqual(h.calls, ["capture", "shell:running", "status:working"]);
  h.calls.length = 0;
  h.emit("agent_end", [{ role: "assistant", stopReason: "error" }]);
  h.emit("agent_settled", [], { ...h.context, isIdle: () => false });
  await h.flush();
  assert.deepEqual(h.calls, []);
  h.emit("agent_start");
  h.emit("agent_end", undefined, { ...h.context, hasPendingMessages: () => true });
  h.emit("agent_start");
  h.emit("agent_end");
  await h.flush();
  assert.deepEqual(h.calls, ["shell:running", "status:working", "shell:running", "status:queued", "shell:running", "status:working"]);
  h.calls.length = 0;
  h.emit("agent_settled");
  h.emit("agent_settled");
  await h.flush();
  assert.deepEqual(h.calls, [
    "shell:prompt", "clear", "notify:Pi done: Dependency update", "log:success:Pi done: Dependency update: ready for input",
  ]);
  assert.ok(h.targets.every((target) => target === h.target));
  assert.equal(new Set(h.statusKeys).size, 1);
  h.calls.length = 0;
  await h.emit("session_shutdown");
  assert.deepEqual(h.calls, [], "already-cleared status needs no duplicate cleanup");
});

test("slow delivery does not block lifecycle handlers and preserves operation order", async () => {
  const started = deferred();
  const release = deferred();
  const order: string[] = [];
  const h = harness(undefined, {
    async reportShellState(state) {
      order.push(state);
      if (state === "running") { started.resolve(); await release.promise; }
      return true;
    },
    async notify() { order.push("notify"); },
  });
  assert.equal(h.emit("agent_start"), undefined);
  await started.promise;
  assert.equal(h.emit("agent_end"), undefined);
  assert.equal(h.emit("agent_settled"), undefined);
  assert.deepEqual(order, ["running"]);
  release.resolve();
  await h.flush();
  assert.deepEqual(order, ["running", "prompt", "notify"]);
  await h.emit("session_shutdown");
});

test("concurrent sessions clear only their own sidebar status", async () => {
  const statuses = new Map<string, string>();
  const client: Partial<Client> = {
    async setStatus(key, text) { statuses.set(key, text); return "attempted"; },
    async clearStatus(key) { statuses.delete(key); return true; },
  };
  const a = harness(undefined, client);
  const b = harness(undefined, client);
  a.emit("agent_start"); b.emit("agent_start");
  await Promise.all([a.flush(), b.flush()]);
  assert.equal(statuses.size, 2);
  await a.emit("session_shutdown");
  assert.equal(statuses.size, 1);
  assert.equal([...statuses.values()][0], "working");
  assert.equal(typeof (globalThis as Record<symbol, unknown>)[PI_CMUX_NOTIFY_SYMBOL], "function");
  await b.emit("session_shutdown");
  assert.equal(statuses.size, 0);
  assert.equal((globalThis as Record<symbol, unknown>)[PI_CMUX_NOTIFY_SYMBOL], undefined);
});

test("aborted runs clean up without success popups", async () => {
  const h = harness();
  h.emit("agent_start");
  h.emit("agent_end", [{ role: "assistant", stopReason: "aborted" }]);
  h.emit("agent_settled");
  await h.flush();
  assert.ok(h.calls.includes("shell:prompt"));
  assert.ok(h.calls.includes("clear"));
  assert.ok(h.calls.includes("log:info:Pi cancelled: Dependency update: run cancelled"));
  assert.ok(!h.calls.some((call) => call.startsWith("notify:") || call.startsWith("log:success:")));
  await h.emit("session_shutdown");
});

test("failed runs respect error popup configuration and do not log success", async () => {
  for (const error of [true, false]) {
    const h = harness(normalizeConfig({ notifications: { done: false, error } }));
    h.emit("agent_start");
    h.emit("agent_end", [{ role: "assistant", stopReason: "error", errorMessage: "private provider details" }]);
    h.emit("agent_settled");
    await h.flush();
    assert.equal(h.calls.includes("notify:Pi error: Dependency update"), error);
    assert.ok(h.calls.includes("log:error:Pi error: Dependency update: run failed"));
    assert.ok(!h.calls.join("\n").includes("private provider details"));
    await h.emit("session_shutdown");
  }
});

test("status-disabled sessions still use one captured target for completion", async () => {
  const h = harness(normalizeConfig({ status: false }));
  h.emit("agent_start"); h.emit("agent_end"); h.emit("agent_settled");
  await h.flush();
  assert.deepEqual(h.calls, ["capture", "notify:Pi done: Dependency update", "log:success:Pi done: Dependency update: ready for input"]);
  assert.ok(h.targets.every((target) => target === h.target));
  await h.emit("session_shutdown");
});

test("shutdown drops pending deliveries and clears an in-flight running report", async () => {
  const started = deferred();
  const release = deferred();
  const states: string[] = [];
  const h = harness(undefined, {
    async reportShellState(state) {
      states.push(state);
      if (state === "running") { started.resolve(); await release.promise; }
      return true;
    },
  });
  h.emit("agent_start");
  await started.promise;
  h.emit("agent_end"); h.emit("agent_settled");
  const closing = h.emit("session_shutdown");
  release.resolve();
  await closing;
  assert.deepEqual(states, ["running", "prompt"]);
  assert.deepEqual(h.calls, ["capture"]);
  await h.emit("session_shutdown");
  assert.deepEqual(states, ["running", "prompt"]);
});

test("session replacement gets a new target and status owner without old queued notifications", async () => {
  let captures = 0;
  const h = harness(undefined, { async captureTarget() { return { workspaceId: "workspace:1", surfaceId: `surface:${++captures}` }; } });
  h.emit("agent_start");
  await h.flush();
  h.emit("agent_end"); h.emit("agent_settled");
  await h.emit("session_shutdown");
  h.emit("session_start");
  h.emit("agent_start");
  await h.flush();
  assert.equal(captures, 2);
  assert.equal(new Set(h.statusKeys).size, 2);
  assert.ok(!h.calls.some((call) => call.startsWith("notify:")));
  assert.equal(typeof (globalThis as Record<symbol, unknown>)[PI_CMUX_NOTIFY_SYMBOL], "function");
  await h.emit("session_shutdown");
});

test("a rejected delivery does not break later work", async () => {
  let attempts = 0;
  const h = harness(undefined, {
    async reportShellState() { if (++attempts === 1) throw new Error("transport failed"); return true; },
  });
  h.emit("agent_start"); h.emit("agent_end"); h.emit("agent_settled");
  await h.flush();
  assert.ok(h.calls.includes("notify:Pi done: Dependency update"));
  await h.emit("session_shutdown");
});

test("completion delayed by cleanup cannot notify during a newer run", async () => {
  const started = deferred();
  const release = deferred();
  const h = harness(undefined, {
    async reportShellState(state) {
      if (state === "prompt") { started.resolve(); await release.promise; }
      return true;
    },
  });
  h.emit("agent_start"); h.emit("agent_end"); h.emit("agent_settled");
  await started.promise;
  h.emit("agent_start");
  release.resolve();
  await h.flush();
  assert.ok(!h.calls.some((call) => call.startsWith("notify:") || call.startsWith("log:")));
  h.emit("agent_end"); h.emit("agent_settled");
  await h.flush();
  assert.equal(h.calls.filter((call) => call.startsWith("notify:")).length, 1);
  await h.emit("session_shutdown");
});

test("a new run cancels an in-flight completion notification", async () => {
  const started = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  const h = harness(undefined, {
    async notify(_input, _target, pendingSignal) {
      signal = pendingSignal;
      started.resolve();
      await release.promise;
    },
  });
  h.emit("agent_start"); h.emit("agent_end"); h.emit("agent_settled");
  await started.promise;
  assert.equal(signal?.aborted, false);
  h.emit("agent_start");
  assert.equal(signal?.aborted, true);
  release.resolve();
  await h.flush();
  assert.ok(!h.calls.some((call) => call.startsWith("log:")));
  await h.emit("session_shutdown");
});

test("a queued old completion cannot clear the status of a newer run", async () => {
  const h = harness();
  h.emit("agent_start");
  await h.flush();
  h.calls.length = 0;
  h.emit("agent_end"); h.emit("agent_settled"); h.emit("agent_start");
  await h.flush();
  assert.deepEqual(h.calls, ["shell:running", "status:working"]);
  await h.emit("session_shutdown");
});

test("failed cleanup remains owned and retries at shutdown", async () => {
  let clears = 0;
  let prompts = 0;
  const h = harness(undefined, {
    async reportShellState(state) { return state !== "prompt" || ++prompts > 1; },
    async clearStatus() { return ++clears > 1; },
  });
  h.emit("agent_start"); h.emit("agent_end"); h.emit("agent_settled");
  await h.flush();
  assert.equal(clears, 1);
  assert.equal(prompts, 1);
  await h.emit("session_shutdown");
  assert.equal(clears, 2);
  assert.equal(prompts, 2);
});

test("failed retired status cleanup survives replacement of the extension runtime", async () => {
  let succeeds = false;
  const old = harness(undefined, { async clearStatus() { return succeeds; } });
  old.emit("agent_start"); old.emit("agent_end"); old.emit("agent_settled");
  await old.flush();
  await old.emit("session_shutdown");
  const oldKey = old.statusKeys[0];
  const retried: Array<{ key: string; target: unknown }> = [];
  succeeds = true;
  const replacement = harness(normalizeConfig({ lifecycle: false }), {
    async clearStatus(key, target) { retried.push({ key, target }); return succeeds; },
  });
  replacement.emit("session_start");
  await replacement.flush();
  assert.deepEqual(retried, [{ key: oldKey, target: old.target }]);
  assert.deepEqual(replacement.calls, [], "retired retries must not report idle over a new active surface");
  replacement.emit("session_start");
  await replacement.flush();
  assert.equal(retried.length, 1, "successful retired cleanup leaves no retry entry");
  await replacement.emit("session_shutdown");
});

test("another runtime cannot retry an active session's failed clear", async () => {
  let succeeds = false;
  const active = harness(undefined, { async clearStatus() { return succeeds; } });
  active.emit("agent_start"); active.emit("agent_end"); active.emit("agent_settled");
  await active.flush();
  active.emit("agent_start");
  await active.flush();
  const other = harness();
  other.emit("session_start");
  await other.flush();
  assert.deepEqual(other.calls, []);
  succeeds = true;
  await active.emit("session_shutdown");
  await other.emit("session_shutdown");
});

test("headless completion popups are opt-in for successful and failed runs", async () => {
  for (const mode of ["json", "rpc", "print", "sdk"] as const) {
    for (const headless of [false, true]) {
      for (const stopReason of ["stop", "error"]) {
        const h = harness(normalizeConfig({ notifications: { headless } }));
        const ctx = { ...h.context, mode };
        h.emit("agent_start", [], ctx);
        h.emit("agent_end", [{ role: "assistant", stopReason }], ctx);
        h.emit("agent_settled", [], ctx);
        await h.flush();
        assert.equal(h.calls.some((call) => call.startsWith("notify:")), headless, `${mode}/${stopReason}/${headless}`);
        assert.ok(h.calls.includes("shell:prompt"), "headless mode still cleans up activity");
        await h.emit("session_shutdown");
      }
    }
  }
});

test("notifier-only mode disables automatic activity and popups but retains the caller API", async () => {
  const h = harness(normalizeConfig({ lifecycle: false }));
  h.emit("session_start"); h.emit("agent_start"); h.emit("agent_end"); h.emit("agent_settled");
  h.emitPrompt("ui_prompt_start");
  await h.flush();
  assert.deepEqual(h.calls, []);
  const notify = (globalThis as Record<symbol, unknown>)[PI_CMUX_NOTIFY_SYMBOL] as PiCmuxNotifier;
  await notify({ title: "Caller request", log: false });
  assert.deepEqual(h.calls, ["notify:Caller request"]);
  await h.emit("session_shutdown");
  assert.equal((globalThis as Record<symbol, unknown>)[PI_CMUX_NOTIFY_SYMBOL], undefined);
});

test("input-wait alerts send once per waiting episode without exposing dialog contents", async () => {
  const h = harness();
  assert.equal(h.emitPrompt("ui_prompt_start"), undefined);
  await h.flush();
  assert.deepEqual(h.calls, ["capture", "notify:Pi needs input: Dependency update"]);
  h.emitPrompt("ui_prompt_start");
  await h.flush();
  assert.equal(h.calls.length, 2);
  h.emitPrompt("ui_prompt_end");
  h.emitPrompt("ui_prompt_end");
  h.emitPrompt("ui_prompt_start");
  await h.flush();
  assert.equal(h.calls.filter((call) => call.startsWith("notify:")).length, 2);
  assert.ok(!h.calls.join(" ").includes("Private dialog"));
  assert.ok(h.targets.every((target) => target === h.target));
  await h.emit("session_shutdown");
});

test("input-wait alerts respect input and headless preferences", async () => {
  for (const input of [true, false]) {
    for (const headless of [true, false]) {
      const h = harness(normalizeConfig({ notifications: { input, headless } }));
      h.emitPrompt("ui_prompt_start", { ...h.context, mode: "rpc" });
      await h.flush();
      assert.equal(h.calls.some((call) => call.startsWith("notify:")), input && headless);
      await h.emit("session_shutdown");
    }
  }
});

test("quickly answered input prompts do not produce stale queued alerts", async () => {
  const h = harness();
  h.emitPrompt("ui_prompt_start"); h.emitPrompt("ui_prompt_end");
  await h.flush();
  assert.deepEqual(h.calls, []);
  await h.emit("session_shutdown");
});

test("ending a prompt or shutting down cancels its in-flight alert", async () => {
  for (const shutdown of [false, true]) {
    const started = deferred();
    const release = deferred();
    let signal: AbortSignal | undefined;
    const h = harness(undefined, {
      async notify(_input, _target, inputSignal) { signal = inputSignal; started.resolve(); await release.promise; },
    });
    h.emitPrompt("ui_prompt_start");
    await started.promise;
    assert.equal(signal?.aborted, false);
    const closing = shutdown ? h.emit("session_shutdown") : h.emitPrompt("ui_prompt_end");
    assert.equal(signal?.aborted, true);
    release.resolve();
    await closing;
    await h.flush();
    await h.emit("session_shutdown");
  }
});

test("skipped relay and unsupported status writes never enter the retired retry list", async () => {
  for (const socketPath of ["localhost:60000", "/tmp/cmux.sock"]) {
    const client = new CmuxClient({
      env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1", CMUX_SOCKET_PATH: socketPath },
      exists: () => false,
      runner: async (_command, args) => {
        assert.notEqual(args[0], "set-status");
        assert.notEqual(args[0], "clear-status");
        return { exitCode: 0, stdout: "Commands:\n  ping Ping\n", stderr: "" };
      },
    });
    const h = harness(undefined, {
      setStatus: client.setStatus.bind(client), clearStatus: client.clearStatus.bind(client),
    });
    for (let i = 0; i < 5; i++) {
      h.emit("session_start"); h.emit("agent_start"); h.emit("agent_end"); h.emit("agent_settled");
      await h.flush();
      await h.emit("session_shutdown");
    }
    await h.commands.get("cmux-status")!.handler("", h.context);
    assert.equal(JSON.parse(h.uiMessages[0]).pendingStatusCleanup, 0);
  }
});

test("a skipped later write does not discard cleanup owed by an earlier attempt", async () => {
  let skip = false;
  let clears = 0;
  const h = harness(undefined, {
    async setStatus() { return skip ? "skipped" : "attempted"; },
    async clearStatus() { return ++clears > 1; },
  });
  h.emit("agent_start"); h.emit("agent_end"); h.emit("agent_settled");
  await h.flush();
  assert.equal(clears, 1);
  skip = true;
  h.emit("agent_start");
  await h.flush();
  await h.emit("session_shutdown");
  assert.equal(clears, 2);
});

test("Pi runner can deliver prompt end before a delayed start without causing a stale alert", async () => {
  // Exercise the installed runner's event scheduling, with unrelated theme and
  // model imports stubbed so this test cannot load user settings or host UI.
  const source = readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js", import.meta.url), "utf8");
  const imports = source.match(/^import .*;$/gm) ?? [];
  assert.equal(imports.length, 3, "check isolated runner imports after Pi upgrades");
  const isolatedSource = `
    const theme = {};
    const getCurrentSystemMessage = () => undefined;
    const buildSystemPrompt = () => "";
    const normalizeBuildSystemPromptOptions = (value) => value;
  ` + source.replace(/^import .*;$/gm, "");
  const { ExtensionRunner } = await import(`data:text/javascript;base64,${Buffer.from(isolatedSource).toString("base64")}`);
  const h = harness();
  const blocked = deferred();
  const release = deferred();
  const startDelivered = deferred();
  const endDelivered = deferred();
  const runner = new ExtensionRunner([
    { path: "earlier-extension", handlers: new Map([["ui_prompt_start", [async () => { blocked.resolve(); await release.promise; }]]]) },
    { path: "pi-cmux", handlers: new Map([...h.handlers].map(([name, handler]) => [name, [handler]])) },
    { path: "observer", handlers: new Map([
      ["ui_prompt_start", [() => startDelivered.resolve()]],
      ["ui_prompt_end", [() => endDelivered.resolve()]],
    ]) },
  ], {}, ".", {}, {});
  let answer!: (value: boolean) => void;
  runner.setUIContext({ confirm: () => new Promise<boolean>((resolve) => { answer = resolve; }) }, "tui");
  const prompt = runner.getUIContext().confirm("Private title", "Private body");
  await blocked.promise;
  answer(true);
  await prompt;
  await endDelivered.promise;
  await h.flush();
  assert.deepEqual(h.calls, []);
  release.resolve();
  await startDelivered.promise;
  await h.flush();
  assert.deepEqual(h.calls, []);
  h.emitPrompt("ui_prompt_start");
  await h.flush();
  assert.deepEqual(h.calls, ["capture", "notify:Pi needs input: Dependency update"]);
  await h.emit("session_shutdown");
});

test("cmux-status reports diagnostics and settings without emitting a popup to cmux", async () => {
  const h = harness();
  await h.commands.get("cmux-status")!.handler("", h.context);
  const result = JSON.parse(h.uiMessages[0]);
  assert.equal(result.transport, "local");
  assert.deepEqual(result.supportedCommands, ["log"]);
  assert.equal(result.active, false);
  assert.deepEqual(h.calls, []);
  await h.emit("session_shutdown");
});
