import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentSession, ExtensionAPI, ExtensionError } from "@earendil-works/pi-coding-agent";

import { normalizeConfig } from "../src/config.js";
import { registerPiCmuxExtension } from "../src/index.js";
import { PI_CMUX_NOTIFY_SYMBOL } from "../src/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("installed Pi sessions deliver cmux notifications only at final settlement", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cmux-session-"));
  const env = {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const symbols = [PI_CMUX_NOTIFY_SYMBOL, Symbol.for("pi.cmux.status-cleanup.v1")];
  const previousGlobals = symbols.map((symbol) => Object.getOwnPropertyDescriptor(globalThis, symbol));
  let networkCalls = 0;
  Object.assign(process.env, env);
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("Pi session tests must stay offline");
  };
  for (const symbol of symbols) delete globals[symbol];
  t.after(async () => {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    symbols.forEach((symbol, index) => {
      const descriptor = previousGlobals[index];
      if (descriptor) Object.defineProperty(globalThis, symbol, descriptor);
      else delete globals[symbol];
    });
    await rm(dir, { recursive: true, force: true });
    assert.equal(networkCalls, 0);
  });

  // Import after isolation. All model/auth state is in memory, and the loader
  // can see only this empty temporary workspace and agent directory.
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");

  async function createFixture(ctx: TestContext, beforeStart?: (pi: ExtensionAPI) => void) {
    const cwd = await mkdtemp(join(dir, "workspace-"));
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    });
    const faux = fauxProvider({ provider: "pi-cmux-offline", tokensPerSecond: Infinity });
    modelRuntime.registerNativeProvider(faux.provider);
    const target = { workspaceId: "workspace:test", surfaceId: "surface:test" };
    const statuses = new Map<string, string>();
    const statusKeys: string[] = [];
    const activityTargets: unknown[] = [];
    const lifecycle: string[] = [];
    const settlements: boolean[] = [];
    const deliveries: Array<{ title: string; phase: string | undefined; idle: boolean; statusCount: number; scope: unknown }> = [];
    const calls: string[] = [];
    const errors: ExtensionError[] = [];
    const releases: Array<() => void> = [];
    let shellState = "prompt";
    let session: AgentSession | undefined;
    let api!: ExtensionAPI;
    let registration!: ReturnType<typeof registerPiCmuxExtension>;
    ctx.after(async () => {
      // Release test barriers even when an assertion fails, then stop the run.
      for (const release of releases) release();
      try {
        if (session) {
          await session.abort();
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          await registration.flush();
        }
      } finally {
        session?.dispose();
        modelRuntime.unregisterProvider("pi-cmux-offline");
      }
      assert.deepEqual(errors, [], "Pi must not swallow extension handler errors");
      assert.equal(statuses.size, 0, "cleanup must release owned activity");
      for (const scope of activityTargets) assert.equal(scope, target, "activity and cleanup must use the captured target");
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: env.PI_CODING_AGENT_DIR, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Reply with a short answer. No tools are available.",
      extensionFactories: [(pi) => {
        api = pi;
        // Observe the real session lifecycle before the cmux handlers run.
        pi.on("agent_start", () => { lifecycle.push("agent_start"); });
        pi.on("agent_end", () => { lifecycle.push("agent_end"); });
        pi.on("agent_settled", (event) => {
          lifecycle.push("agent_settled");
          settlements.push(event.aborted);
        });
        registration = registerPiCmuxExtension(pi, normalizeConfig(undefined), {
          async captureTarget() { calls.push("capture"); return target; },
          async reportShellState(state, scope) {
            activityTargets.push(scope); shellState = state; calls.push(`shell:${state}`); return true;
          },
          async setStatus(key, text, _options, scope) {
            activityTargets.push(scope); statuses.set(key, text); statusKeys.push(key); calls.push(`status:${text}`); return "attempted";
          },
          async clearStatus(key, scope) {
            activityTargets.push(scope); statuses.delete(key); statusKeys.push(key); calls.push("clear"); return true;
          },
          async notify(input, scope, signal) {
            if (signal?.aborted) return;
            deliveries.push({ title: input.title, phase: lifecycle.at(-1), idle: session!.isIdle, statusCount: statuses.size, scope });
            calls.push(`notify:${input.title}`);
          },
          async log(_message, options) { calls.push(`log:${options?.level}`); },
          async getDiagnostics() {
            return { available: true, cli: "test", transport: "local", ...target, supportedCommands: [], recentFailures: [] };
          },
        });
        pi.on("agent_end", async () => {
          await registration.flush();
          // Keep observations outside handler assertions, which Pi would catch.
          calls.push(`agent_end:popups=${deliveries.length}`);
        });
        pi.registerCommand("test-custom-run", {
          description: "Start an offline custom-message run",
          handler: async () => {
            pi.sendMessage({ customType: "first", content: "first task", display: true }, { triggerTurn: true });
          },
        });
        beforeStart?.(pi);
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(resourceLoader.getExtensions().extensions.length, 1, "only the explicit test extension loads");
    ({ session } = await createAgentSession({
      cwd, agentDir: env.PI_CODING_AGENT_DIR, modelRuntime, model: faux.getModel(), thinkingLevel: "off",
      resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: [],
    }));
    await session.bindExtensions({ mode: "tui", onError: (error) => { errors.push(error); } });
    await registration.flush();
    assert.equal(calls.length, 0, "session startup must not report activity");
    return { session, api, registration, faux, statuses, statusKeys, lifecycle, settlements, deliveries, calls, target, releases,
      getShellState: () => shellState };
  }

  await t.test("normal completion clears activity and sends one popup after settlement", async (ctx) => {
    const fixture = await createFixture(ctx);
    const requestStarted = deferred();
    const releaseResponse = deferred();
    fixture.releases.push(releaseResponse.resolve);
    fixture.faux.setResponses([async () => {
      requestStarted.resolve();
      await releaseResponse.promise;
      return fauxAssistantMessage("done");
    }]);
    const run = fixture.session.prompt("hello");
    await requestStarted.promise;
    await fixture.registration.flush();
    assert.equal(fixture.session.isIdle, false);
    assert.deepEqual([...fixture.statuses.values()], ["working"]);
    assert.equal(fixture.getShellState(), "running");
    assert.deepEqual(fixture.deliveries, []);
    releaseResponse.resolve();
    await run;
    await fixture.session.waitForIdle();
    await fixture.registration.flush();
    assert.deepEqual(fixture.lifecycle, ["agent_start", "agent_end", "agent_settled"]);
    assert.deepEqual(fixture.settlements, [false]);
    assert.deepEqual(fixture.deliveries, [{ title: "Pi done", phase: "agent_settled", idle: true, statusCount: 0, scope: fixture.target }]);
    assert.ok(fixture.calls.includes("agent_end:popups=0"));
    assert.equal(fixture.statuses.size, 0);
    assert.equal(fixture.getShellState(), "prompt");
    assert.equal(fixture.calls.filter((call) => call === "clear").length, 1);
    assert.equal(new Set(fixture.statusKeys).size, 1);
  });

  await t.test("extension custom-message startup queues work without early or duplicate popups", async (ctx) => {
    const handlerStarted = deferred();
    const releaseHandler = deferred();
    const fixture = await createFixture(ctx, (pi) => {
      pi.on("before_agent_start", async (event) => {
        if (event.messageType !== "custom" || event.message.customType !== "first") return;
        handlerStarted.resolve();
        await releaseHandler.promise;
      });
    });
    fixture.releases.push(releaseHandler.resolve);
    const finalRequestStarted = deferred();
    const releaseFinalResponse = deferred();
    fixture.releases.push(releaseFinalResponse.resolve);
    const requests: string[] = [];
    fixture.faux.setResponses([
      (context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("first done"); },
      async (context) => {
        requests.push(JSON.stringify(context.messages));
        finalRequestStarted.resolve();
        await releaseFinalResponse.promise;
        return fauxAssistantMessage("all done");
      },
    ]);
    await fixture.session.prompt("/test-custom-run");
    await handlerStarted.promise;
    assert.equal(fixture.session.isIdle, false, "startup counts as busy");
    fixture.api.sendMessage({ customType: "second", content: "second task", display: true }, { triggerTurn: true });
    fixture.api.sendMessage({ customType: "third", content: "third task", display: true }, { triggerTurn: true, deliverAs: "followUp" });
    await fixture.registration.flush();
    assert.deepEqual(fixture.deliveries, []);
    assert.equal(fixture.faux.state.callCount, 0, "provider waits for before_agent_start");
    releaseHandler.resolve();
    await finalRequestStarted.promise;
    await fixture.registration.flush();
    assert.equal(fixture.session.isIdle, false);
    assert.deepEqual([...fixture.statuses.values()], ["working"]);
    assert.deepEqual(fixture.deliveries, [], "first assistant response is not final settlement");
    releaseFinalResponse.resolve();
    await fixture.session.waitForIdle();
    await fixture.registration.flush();
    assert.equal(requests.length, 2);
    assert.ok(requests[0].includes("first task"));
    assert.ok(requests[0].includes("second task"), "startup steering joins the first request");
    assert.ok(requests[0].indexOf("first task") < requests[0].indexOf("second task"), "startup messages retain their order");
    assert.equal(requests[0].includes("third task"), false, "follow-up must not enter the first request");
    assert.equal(requests[1].split("third task").length - 1, 1, "startup follow-up reaches the next request once");
    assert.equal(fixture.lifecycle.filter((event) => event === "agent_settled").length, 1);
    assert.deepEqual(fixture.settlements, [false]);
    assert.deepEqual(fixture.deliveries, [{ title: "Pi done", phase: "agent_settled", idle: true, statusCount: 0, scope: fixture.target }]);
    assert.ok(fixture.calls.includes("agent_end:popups=0"));
    assert.equal(fixture.statuses.size, 0);
    assert.equal(fixture.getShellState(), "prompt");
    assert.equal(fixture.calls.filter((call) => call === "clear").length, 1);
    assert.equal(new Set(fixture.statusKeys).size, 1);
  });

  await t.test("cancellation during before_agent_start clears activity without a success popup", async (ctx) => {
    const handlerStarted = deferred();
    const releaseHandler = deferred();
    const fixture = await createFixture(ctx, (pi) => {
      pi.on("before_agent_start", async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
      });
    });
    fixture.releases.push(releaseHandler.resolve);
    fixture.faux.setResponses([fauxAssistantMessage("must not succeed")]);
    await fixture.session.prompt("/test-custom-run");
    await handlerStarted.promise;
    assert.equal(fixture.session.isIdle, false);
    assert.equal(fixture.faux.state.callCount, 0);
    const aborted = fixture.session.abort();
    await fixture.registration.flush();
    assert.deepEqual(fixture.deliveries, []);
    releaseHandler.resolve();
    await aborted;
    await fixture.session.waitForIdle();
    await fixture.registration.flush();
    const last = fixture.session.messages.at(-1);
    assert.equal(last?.role, "assistant");
    // ModelRuntime can encode a pre-provider AbortError as stopReason "error".
    // Pi's final settlement is the authoritative cancellation signal.
    assert.deepEqual(fixture.settlements, [true]);
    assert.equal(fixture.session.isIdle, true);
    assert.equal(fixture.lifecycle.filter((event) => event === "agent_settled").length, 1);
    assert.deepEqual(fixture.deliveries, [], "cancelled startup must never send a success popup");
    assert.equal(fixture.statuses.size, 0);
    assert.equal(fixture.getShellState(), "prompt");
    assert.ok(fixture.calls.includes("status:working"), "the cancelled run had owned activity to clear");
    assert.equal(fixture.calls.filter((call) => call === "clear").length, 1);
    assert.ok(!fixture.calls.includes("log:success"));
  });
});
