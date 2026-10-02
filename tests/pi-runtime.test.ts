import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentEndEvent, ExtensionError, ExtensionRunner } from "@earendil-works/pi-coding-agent";

import { PI_CMUX_NOTIFY_SYMBOL } from "../src/types.js";

test("installed Pi loads the package and delivers its lifecycle through the real runner", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cmux-runtime-"));
  const env = {
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_CMUX_CONFIG: join(dir, "config.json"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const runners: ExtensionRunner[] = [];
  const errors: ExtensionError[] = [];
  let networkCalls = 0;
  Object.assign(process.env, env);
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("Pi runtime compatibility test must stay offline");
  };
  t.after(async () => {
    try {
      for (const runner of runners) {
        await runner.emit({ type: "session_shutdown", reason: "quit" });
        runner.invalidate();
      }
    } finally {
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Import after isolation is set. No source rewriting, private imports,
  // credentials, discovered user extensions, or model requests are needed.
  const { discoverAndLoadExtensions, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager } =
    await import("@earendil-works/pi-coding-agent");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const sessions = SessionManager.inMemory(dir);
  let idle = true;
  let pending = false;
  const uiMessages: string[] = [];

  async function load(path: string) {
    const result = await discoverAndLoadExtensions([path], dir, env.PI_CODING_AGENT_DIR);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings ?? [], []);
    assert.equal(result.extensions.length, 1);
    const runner = new ExtensionRunner(result.extensions, result.runtime, dir, sessions, new ModelRegistry(modelRuntime));
    runners.push(runner);
    runner.onError((error) => { errors.push(error); });
    runner.bindCore({ ...result.runtime, getSessionName: () => "Compatibility test" }, {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => idle,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort() { throw new Error("Unexpected agent abort"); },
      hasPendingMessages: () => pending,
      shutdown() { throw new Error("Unexpected shutdown request"); },
      getContextUsage: () => undefined,
      compact() { throw new Error("Unexpected compaction request"); },
      getSystemPrompt: () => "",
    });
    runner.setUIContext({ ...runner.getUIContext(), notify: (message) => { uiMessages.push(message); } }, "tui");
    return runner;
  }

  // Discover the package directory, including its actual pi.extensions manifest
  // and default factory. Registration and shutdown must not start cmux I/O.
  const entry = await load(fileURLToPath(new URL("../", import.meta.url)));
  assert.equal(entry.getCommand("cmux-status")?.name, "cmux-status");
  const lifecycle = ["session_start", "agent_start", "agent_end", "agent_settled", "ui_prompt_start", "ui_prompt_end", "session_shutdown"];
  for (const event of lifecycle) assert.equal(entry.hasHandlers(event), true, event);
  assert.equal(typeof (globalThis as Record<symbol, unknown>)[PI_CMUX_NOTIFY_SYMBOL], "function");
  await entry.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal((globalThis as Record<symbol, unknown>)[PI_CMUX_NOTIFY_SYMBOL], undefined);

  // The file fixture injects only a fake cmux client into the real registration
  // function. Pi still loads the TypeScript and supplies all event contexts.
  const runner = await load(fileURLToPath(new URL("./fixtures/runtime-extension.ts", import.meta.url)));
  async function snapshot(reset = false): Promise<{ calls: string[]; statusKeys: string[] }> {
    const command = runner.getCommand("test-cmux-flush");
    assert.ok(command);
    await command.handler(reset ? "reset" : "", runner.createCommandContext());
    return JSON.parse(uiMessages.pop()!);
  }
  const message: AgentEndEvent["messages"][number] = {
    role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "offline-test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0,
  };
  await runner.emit({ type: "session_start", reason: "startup" });
  assert.deepEqual((await snapshot()).calls, []);
  idle = false;
  await runner.emit({ type: "agent_start" });
  assert.deepEqual((await snapshot()).calls, ["capture", "shell:running", "status:working"]);
  await snapshot(true);
  pending = true;
  await runner.emit({ type: "agent_end", messages: [message] });
  await runner.emit({ type: "agent_settled" });
  assert.deepEqual((await snapshot()).calls, ["shell:running", "status:queued"], "agent_end is not completion");
  await snapshot(true);
  pending = false;
  await runner.emit({ type: "agent_start" });
  await runner.emit({ type: "agent_end", messages: [message] });
  idle = true;
  await runner.emit({ type: "agent_settled" });
  await runner.emit({ type: "agent_settled" });
  const completed = await snapshot();
  assert.deepEqual(completed.calls, [
    "shell:running", "status:working", "shell:prompt", "clear",
    "notify:Pi done: Compatibility test:Ready for input",
    "log:success:Pi done: Compatibility test: ready for input",
  ]);
  assert.equal(new Set(completed.statusKeys).size, 1, "one status owner per session");

  for (const stopReason of ["error", "aborted"] as const) {
    await snapshot(true);
    await runner.emit({ type: "agent_start" });
    await runner.emit({ type: "agent_end", messages: [{ ...message, stopReason }] });
    await runner.emit({ type: "agent_settled" });
    assert.deepEqual((await snapshot()).calls, [
      "shell:running", "status:working", "shell:prompt", "clear",
      ...(stopReason === "error" ? ["notify:Pi error: Compatibility test:Run failed. Check Pi for details."] : []),
      stopReason === "error" ? "log:error:Pi error: Compatibility test: run failed" : "log:info:Pi cancelled: Compatibility test: run cancelled",
    ]);
  }

  await snapshot(true);
  let answer!: (value: boolean) => void;
  runner.setUIContext({
    ...runner.getUIContext(),
    confirm: () => new Promise<boolean>((resolve) => { answer = resolve; }),
  }, "tui");
  const prompt = runner.getUIContext().confirm("Private title", "Private body");
  await Promise.resolve(); // Pi queues prompt events separately from the dialog.
  assert.deepEqual((await snapshot()).calls, ["notify:Pi needs input: Compatibility test:Pi is waiting for your input."]);
  answer(true);
  assert.equal(await prompt, true);
  await Promise.resolve();
  await snapshot(true);
  const nextPrompt = runner.getUIContext().confirm("Another private title", "Another private body");
  await Promise.resolve();
  assert.deepEqual((await snapshot()).calls, ["notify:Pi needs input: Compatibility test:Pi is waiting for your input."], "prompt end permits the next input alert");
  answer(false);
  assert.equal(await nextPrompt, false);
  await Promise.resolve();
  await snapshot(true);

  runner.setUIContext(undefined, "print");
  await runner.emit({ type: "agent_start" });
  await runner.emit({ type: "agent_end", messages: [message] });
  await runner.emit({ type: "agent_settled" });
  runner.setUIContext({ ...runner.getUIContext(), notify: (message) => { uiMessages.push(message); } }, "print");
  assert.deepEqual((await snapshot()).calls, [
    "shell:running", "status:working", "shell:prompt", "clear",
    "log:success:Pi done: Compatibility test: ready for input",
  ], "headless completion suppresses popups by default");
  await snapshot(true);
  await runner.emit({ type: "agent_start" });
  await snapshot();
  await snapshot(true);
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual((await snapshot()).calls, ["shell:prompt", "clear"], "shutdown cleans an active session once");
  assert.equal((globalThis as Record<symbol, unknown>)[PI_CMUX_NOTIFY_SYMBOL], undefined);
  assert.deepEqual(errors, [], "Pi must not report swallowed handler errors");
  assert.equal(networkCalls, 0);
});
