import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CmuxClient, parseTmuxEnvironmentOutput, resolveRuntimeCmuxEnv, type CmuxEnv, type CommandRunner } from "../src/cmux.js";
import { normalizeConfig } from "../src/config.js";
import { handlePiCmuxNotification, registerPiCmuxExtension } from "../src/index.js";
import { sendTuiNotification, type TuiTarget } from "../src/tui.js";

const terminalId = `term_${"a".repeat(32)}`;
const sessionId = `session_${"b".repeat(32)}`;
interface Request {
  protocol: string;
  type: string;
  id: string;
  operation: string;
  idempotency_key: string;
  params: { machine: string; session: string; terminal_id: string; title: string; body: string; subtitle?: string };
}

function success(request: Request) {
  return {
    protocol: "cmux.protocol/2", type: "response", id: request.id, ok: true,
    result: {
      generation: "generation", revision: "1", replayed: false,
      value: {
        id: `notification_${"c".repeat(32)}`, session_id: sessionId, terminal_id: request.params.terminal_id,
        title: request.params.title, body: request.params.body, level: "info", created_at_ms: "1", unread: true, read_by: [],
      },
    },
  };
}

async function fakeServer(t: TestContext, handler: (socket: Socket, request: Request) => void) {
  const directory = await mkdtemp(join(tmpdir(), "pi-cmux-tui-"));
  const path = join(directory, "s.sock");
  const requests: Request[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const request = JSON.parse(buffer.slice(0, end)) as Request;
        buffer = buffer.slice(end + 1);
        requests.push(request);
        handler(socket, request);
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.removeListener("error", reject); resolve(); });
  });
  return { path, requests, sockets };
}

const forbiddenCommands: Array<{ command: string; args: readonly string[] }> = [];
const noCommands: CommandRunner = async (command, args) => {
  forbiddenCommands.push({ command, args });
  return { exitCode: 1, stdout: "", stderr: "" };
};
// Runner exceptions are best-effort and can be caught by the client. Check calls
// after every test instead of relying on an assertion inside the runner.
test.afterEach(() => assert.deepEqual(forbiddenCommands.splice(0), [], "No CLI or helper may run"));

function envFor(path: string): CmuxEnv {
  return { CMUX_TUI_SOCKET: path, CMUX_TUI_TERMINAL_ID: terminalId, CMUX_TUI_SESSION_ID: sessionId };
}

function targetFor(path: string): TuiTarget {
  return { tuiSocketPath: path, terminalId, sessionId };
}

test("tui uses the resource protocol with unique request and mutation IDs", async (t) => {
  const server = await fakeServer(t, (socket, request) => socket.end(JSON.stringify(success(request)) + "\n"));
  for (let i = 0; i < 2; i++) {
    assert.equal(await sendTuiNotification(targetFor(server.path), { title: "Done", subtitle: "Task", body: "Ready" }), "delivered");
  }
  for (const request of server.requests) {
    assert.equal(request.protocol, "cmux.protocol/2");
    assert.equal(request.type, "request");
    assert.equal(request.operation, "notification.create");
    assert.deepEqual(request.params, { machine: "current", session: sessionId, terminal_id: terminalId, title: "Done", subtitle: "Task", body: "Ready" });
    assert.notEqual(request.id, request.idempotency_key);
  }
  assert.notEqual(server.requests[0].id, server.requests[1].id);
  assert.notEqual(server.requests[0].idempotency_key, server.requests[1].idempotency_key);
});

test("tui keeps fragmented UTF-8 and multiple response lines correctly framed and correlated", async (t) => {
  const server = await fakeServer(t, (socket, request) => {
    const response = success(request);
    response.result.value.title = "Ready 😀";
    const bytes = Buffer.from(" \n" + JSON.stringify({ ...response, id: "other" }) + "\n" + JSON.stringify(response) + "\n");
    const split = bytes.lastIndexOf(Buffer.from("😀")) + 1;
    socket.write(bytes.subarray(0, split));
    setImmediate(() => socket.end(bytes.subarray(split)));
  });
  assert.equal(await sendTuiNotification(targetFor(server.path), { title: "Done", body: "" }), "delivered");
});

test("tui rejects malformed envelopes, payloads, UTF-8 and incomplete JSON without retry", async (t) => {
  const cases: Array<(request: Request) => string | Buffer> = [
    () => "not json\n",
    () => Buffer.from([0xff, 10]),
    () => "{",
    (request) => JSON.stringify({ ...success(request), protocol: "cmux.protocol/1" }) + "\n",
    (request) => JSON.stringify({ ...success(request), extra: "unknown" }) + "\n",
    (request) => JSON.stringify({ ...success(request), ok: "true" }) + "\n",
    (request) => JSON.stringify({ ...success(request), result: {} }) + "\n",
    ...[{ toString: null }, ["info"]].map((level) => (request: Request) => {
      const response = success(request);
      return JSON.stringify({ ...response, result: { ...response.result, value: { ...response.result.value, level } } }) + "\n";
    }),
    (request) => { const response = success(request); response.result.value.terminal_id = `term_${"d".repeat(32)}`; return JSON.stringify(response) + "\n"; },
    (request) => JSON.stringify({ protocol: "cmux.protocol/2", type: "response", id: request.id, ok: false, error: "private path" }) + "\n",
  ];
  for (const makeResponse of cases) {
    const server = await fakeServer(t, (socket, request) => socket.end(makeResponse(request)));
    assert.equal(await sendTuiNotification(targetFor(server.path), { title: "Done", body: "" }), "malformed");
    assert.equal(server.requests.length, 1);
  }
});

test("tui fails best-effort on a structured refusal or disconnect, without retry", async (t) => {
  for (const disconnected of [false, true]) {
    const server = await fakeServer(t, (socket, request) => {
      if (disconnected) socket.destroy();
      else socket.end(JSON.stringify({
        protocol: "cmux.protocol/2", type: "response", id: request.id, ok: false,
        error: { code: "selector.not_found", message: "secret socket path and notification", details: {}, retryable: false },
      }) + "\n");
    });
    assert.equal(await sendTuiNotification(targetFor(server.path), { title: "Done", body: "" }), disconnected ? "disconnected" : "refused");
    assert.equal(server.requests.length, 1);
  }
});

test("tui bounds response memory", async (t) => {
  const server = await fakeServer(t, (socket) => socket.write("x".repeat(1024 * 1024 + 1)));
  assert.equal(await sendTuiNotification(targetFor(server.path), { title: "Done", body: "" }), "overflow");
  assert.equal(server.requests.length, 1);
});

test("tui has a three-second absolute timeout despite unrelated response traffic", async (t) => {
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  t.after(() => intervals.forEach(clearInterval));
  const server = await fakeServer(t, (socket, request) => {
    const timer = setInterval(() => socket.write(JSON.stringify({ ...success(request), id: "other" }) + "\n"), 30);
    intervals.push(timer);
    socket.once("close", () => clearInterval(timer));
  });
  const started = Date.now();
  assert.equal(await sendTuiNotification(targetFor(server.path), { title: "Done", body: "" }), "timeout");
  assert.ok(Date.now() - started >= 2900);
  assert.ok(Date.now() - started < 4500);
  assert.equal(server.requests.length, 1);
});

test("tui cancellation closes the dedicated connection before completion and never retries", async (t) => {
  const controller = new AbortController();
  let closed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => { closed = resolve; });
  const server = await fakeServer(t, (socket) => {
    socket.once("close", closed);
    controller.abort();
  });
  let adds = 0;
  let removes = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<typeof add>) => { adds++; add(...args); };
  controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removes++; remove(...args); };
  assert.equal(await sendTuiNotification(targetFor(server.path), { title: "Done", body: "" }, controller.signal), "cancelled");
  assert.equal(adds, removes);
  await connectionClosed;
  assert.equal(server.sockets.size, 0);
  assert.equal(server.requests.length, 1);
  assert.equal(await sendTuiNotification(targetFor(server.path), { title: "Done", body: "" }, controller.signal), "cancelled");
  assert.equal(server.requests.length, 1);
});

test("tui accepts Unicode character limits and rejects overlong contents before dispatch", async (t) => {
  const server = await fakeServer(t, (socket, request) => socket.end(JSON.stringify(success(request)) + "\n"));
  assert.equal(await sendTuiNotification(targetFor(server.path), { title: "😀".repeat(512), subtitle: "😀".repeat(512), body: "😀".repeat(4096) }), "delivered");
  for (const input of [{ title: "", body: "" }, { title: "😀".repeat(513), body: "" }, { title: "Done", subtitle: "a".repeat(513), body: "" }, { title: "Done", body: "😀".repeat(4097) }]) {
    assert.equal(await sendTuiNotification(targetFor(server.path), input), "invalid");
  }
  assert.equal(server.requests.length, 1);
});

test("tui missing or invalid socket and identity inputs fail closed, even with Mac inputs", async () => {
  for (const overrides of [
    { CMUX_TUI_SOCKET: undefined }, { CMUX_TUI_SOCKET: "localhost:60000" }, { CMUX_TUI_SOCKET: "/tmp/invalid\0socket" },
    { CMUX_TUI_TERMINAL_ID: undefined }, { CMUX_TUI_TERMINAL_ID: "current" }, { CMUX_TUI_TERMINAL_ID: "term_1" },
    { CMUX_TUI_TERMINAL_ID: terminalId.toUpperCase() }, { CMUX_TUI_SESSION_ID: "current" }, { CMUX_TUI_SESSION_ID: "" },
  ]) {
    const client = new CmuxClient({
      env: { ...envFor("/tmp/not-opened.sock"), CMUX_WORKSPACE_ID: "workspace:mac", CMUX_SURFACE_ID: "surface:mac", ...overrides },
      exists: () => true, runner: noCommands,
    });
    assert.equal(client.isAvailable(), false);
    const target = await client.captureTarget();
    assert.equal(target.transport, "tui");
    await client.notify({ title: "Done" });
    await client.notify({ title: "Done" }, target);
    assert.equal((await client.getDiagnostics(target)).transport, "tui");
  }
});

test("present but empty tui markers cannot fall back to Mac delivery", async () => {
  for (const key of ["CMUX_TUI_SOCKET", "CMUX_MUX_SOCKET", "CMUX_TUI_TERMINAL_ID", "CMUX_TUI_SESSION_ID"]) {
    for (const value of ["", "   "]) {
      const client = new CmuxClient({
        env: { [key]: value, CMUX_SOCKET_PATH: "/tmp/mac.sock", CMUX_WORKSPACE_ID: "mac", CMUX_SURFACE_ID: "mac" },
        exists: () => true, runner: noCommands,
      });
      assert.equal(client.isAvailable(), false);
      const target = await client.captureTarget();
      assert.equal(target.transport, "tui");
      await client.notify({ title: "Done" });
      await client.notify({ title: "Done" }, target);
      assert.equal((await client.getDiagnostics(target)).transport, "tui");
    }
  }
});

test("tui client accepts the socket alias and prefers the primary socket", async (t) => {
  const server = await fakeServer(t, (socket, request) => socket.end(JSON.stringify(success(request)) + "\n"));
  for (const env of [
    { CMUX_MUX_SOCKET: server.path, CMUX_TUI_TERMINAL_ID: terminalId },
    { CMUX_TUI_SOCKET: "", CMUX_MUX_SOCKET: server.path, CMUX_TUI_TERMINAL_ID: terminalId },
    { ...envFor(server.path), CMUX_MUX_SOCKET: "/tmp/not-used.sock" },
  ]) {
    const client = new CmuxClient({ env, runner: noCommands });
    assert.equal(client.isAvailable(), true);
    await client.notify({ title: "Done" });
    assert.deepEqual((await client.getDiagnostics()).recentFailures, []);
  }
  assert.equal(server.requests.length, 3);
  assert.deepEqual(server.requests.map((request) => request.params.session), ["current", "current", sessionId]);
  assert.ok(server.requests.every((request) => request.params.terminal_id === terminalId));
});

test("captured tui targets keep socket, terminal and session ownership after environment changes", async (t) => {
  const original = await fakeServer(t, (socket, request) => socket.end(JSON.stringify(success(request)) + "\n"));
  const other = await fakeServer(t, () => assert.fail("Captured delivery must not move"));
  const env = envFor(original.path);
  const client = new CmuxClient({ env, runner: noCommands });
  const target = await client.captureTarget();
  Object.assign(env, envFor(other.path), { CMUX_TUI_TERMINAL_ID: `term_${"d".repeat(32)}`, CMUX_TUI_SESSION_ID: `session_${"e".repeat(32)}` });
  await client.notify({ title: "Done" }, target);
  delete env.CMUX_TUI_SOCKET;
  delete env.CMUX_TUI_TERMINAL_ID;
  delete env.CMUX_TUI_SESSION_ID;
  Object.assign(env, { CMUX_SOCKET_PATH: "/tmp/mac.sock", CMUX_WORKSPACE_ID: "mac", CMUX_SURFACE_ID: "mac" });
  await client.notify({ title: "Done again" }, target);
  const diagnostics = await client.getDiagnostics(target);
  assert.equal(diagnostics.transport, "tui");
  assert.equal(diagnostics.terminalId, terminalId);
  assert.equal(diagnostics.sessionId, sessionId);
  assert.equal(original.requests.length, 2);
  assert.equal(other.requests.length, 0);
});

test("captured tui targets without a session keep current routing after a session appears", async (t) => {
  const server = await fakeServer(t, (socket, request) => socket.end(JSON.stringify(success(request)) + "\n"));
  const env = envFor(server.path);
  delete env.CMUX_TUI_SESSION_ID;
  const client = new CmuxClient({ env, runner: noCommands });
  const target = await client.captureTarget();
  env.CMUX_TUI_SESSION_ID = sessionId;
  await client.notify({ title: "Done" }, target);
  assert.equal(server.requests[0].params.session, "current");
  assert.equal(server.requests[0].params.terminal_id, terminalId);
});

test("captured incomplete tui targets never recover from later environment or Mac focus", async (t) => {
  const server = await fakeServer(t, () => assert.fail("No notification may be sent"));
  const env = { CMUX_TUI_SOCKET: server.path } as CmuxEnv;
  const client = new CmuxClient({ env, exists: () => true, runner: noCommands });
  const target = await client.captureTarget();
  Object.assign(env, envFor(server.path), { CMUX_SURFACE_ID: "mac" });
  await client.notify({ title: "Done" }, target);
  assert.equal((await client.getDiagnostics(target)).available, false);
});

test("captured Mac targets cannot switch to tui when its environment appears", async () => {
  const env: CmuxEnv = { CMUX_WORKSPACE_ID: "workspace:mac", CMUX_SURFACE_ID: "surface:mac" };
  const calls: string[][] = [];
  const client = new CmuxClient({ env, exists: () => false, runner: async (_command, args) => {
    calls.push([...args]); return { exitCode: 0, stdout: "", stderr: "" };
  } });
  const target = await client.captureTarget();
  Object.assign(env, envFor("/tmp/not-used.sock"));
  await client.notify({ title: "Done" }, target);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["rpc", "notification.create"]]);
  assert.equal(JSON.parse(calls[0][2]).surface_id, "surface:mac");
});

test("tui optional Mac shell-state, sidebar and log operations skip without probes", async () => {
  const client = new CmuxClient({ env: envFor("/tmp/not-opened.sock"), runner: noCommands });
  const target = await client.captureTarget();
  for (const captured of [undefined, target]) {
    assert.equal(await client.reportShellState("running", captured), false);
    assert.equal(await client.setStatus("pi", "working", {}, captured), "skipped");
    assert.equal(await client.clearStatus("pi", captured), true);
    await client.log("Done", {}, captured);
    assert.deepEqual((await client.getDiagnostics(captured)).supportedCommands, []);
  }
});

test("tmux shared state cannot supply or replace tui capabilities and IDs", async () => {
  const output = [
    "CMUX_TUI_SOCKET=/tmp/shared-secret.sock", "CMUX_MUX_SOCKET=/tmp/shared-alias.sock",
    `CMUX_TUI_TERMINAL_ID=term_${"d".repeat(32)}`, `CMUX_TUI_SESSION_ID=session_${"e".repeat(32)}`,
    "-CMUX_TUI_SOCKET", "-CMUX_MUX_SOCKET", "-CMUX_TUI_TERMINAL_ID", "-CMUX_TUI_SESSION_ID", "CMUX_WORKSPACE_ID=workspace:mac",
  ].join("\n");
  assert.deepEqual(parseTmuxEnvironmentOutput(output), { CMUX_WORKSPACE_ID: "workspace:mac" });
  const env = { ...envFor("/tmp/process-secret.sock"), CMUX_MUX_SOCKET: "/tmp/process-alias.sock", TMUX: "/tmp/mock" };
  const runtime = await resolveRuntimeCmuxEnv(env, async () => ({ exitCode: 0, stdout: output, stderr: "" }));
  for (const key of ["CMUX_TUI_SOCKET", "CMUX_MUX_SOCKET", "CMUX_TUI_TERMINAL_ID", "CMUX_TUI_SESSION_ID"]) {
    assert.equal(runtime[key], env[key as keyof typeof env]);
  }
});

test("tui client preserves pane labels without importing tmux routing state", async (t) => {
  const server = await fakeServer(t, (socket, request) => socket.end(JSON.stringify(success(request)) + "\n"));
  const client = new CmuxClient({ env: { ...envFor(server.path), TMUX: "/tmp/mock", TMUX_PANE: "%2" }, runner: async (command, args) => {
    assert.equal(command, "tmux"); assert.equal(args[0], "display-message");
    return { exitCode: 0, stdout: "dev:1 %2\n", stderr: "" };
  } });
  await client.notify({ title: "Done", subtitle: "Task", body: "Ready" }, await client.captureTarget());
  assert.equal(server.requests[0].params.body, "[dev:1 %2] Ready");
  assert.equal(server.requests[0].params.subtitle, "Task");
});

test("tui diagnostics bound failure metadata and do not reveal capabilities or raw errors", async (t) => {
  const server = await fakeServer(t, (socket, request) => socket.end(JSON.stringify({
    protocol: "cmux.protocol/2", type: "response", id: request.id, ok: false,
    error: { code: "private-error-code", message: server.path, details: { body: "private content", password: "private credential" }, retryable: true },
  }) + "\n"));
  const client = new CmuxClient({ env: { ...envFor(server.path), CMUX_SOCKET_CAPABILITY: "private capability", CMUX_BUNDLED_CLI_PATH: "/private/helper" }, runner: noCommands });
  for (let i = 0; i < 7; i++) await client.notify({ title: "private title", body: "private body" });
  const diagnostics = await client.getDiagnostics();
  assert.equal(diagnostics.recentFailures.length, 5);
  assert.ok(!JSON.stringify(diagnostics).includes(server.path));
  assert.ok(!JSON.stringify(diagnostics).includes("private"));
  assert.equal(diagnostics.transport, "tui");
  assert.equal(diagnostics.cli, "");
  assert.equal(server.requests.length, 7);
});

test("tui delivers the optional notify API and settled lifecycle without Mac activity", async (t) => {
  const server = await fakeServer(t, (socket, request) => socket.end(JSON.stringify(success(request)) + "\n"));
  const env = envFor(server.path);
  const client = new CmuxClient({ env, runner: noCommands });
  const config = normalizeConfig(undefined);
  await handlePiCmuxNotification({ title: "Optional", body: "Ready", status: { text: "working" } }, config, client);
  type Context = { mode: string; isIdle(): boolean; hasPendingMessages(): boolean };
  type Handler = (event: { messages: unknown[]; aborted?: boolean }, context: Context) => void | Promise<void>;
  const handlers = new Map<string, Handler>();
  const extension = registerPiCmuxExtension({
    getSessionName: () => "Task",
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    registerCommand() {},
  } as unknown as ExtensionAPI, config, client);
  const context = { mode: "tui", isIdle: () => true, hasPendingMessages: () => false };
  const completed = { messages: [{ role: "assistant", stopReason: "stop" }] };
  await handlers.get("agent_start")!(completed, context);
  await extension.flush();
  env.CMUX_TUI_SOCKET = "/tmp/not-used.sock";
  env.CMUX_TUI_TERMINAL_ID = `term_${"d".repeat(32)}`;
  await handlers.get("agent_end")!(completed, context);
  await extension.flush();
  assert.equal(server.requests.length, 1, "agent_end must not notify before settlement");
  await handlers.get("agent_settled")!(completed, context);
  await extension.flush();
  assert.deepEqual(server.requests.map((request) => request.params.title), ["Optional", "Pi done: Task"]);
  assert.ok(server.requests.every((request) => request.params.terminal_id === terminalId));
  await handlers.get("agent_start")!(completed, context);
  await handlers.get("agent_end")!(completed, context);
  await handlers.get("agent_settled")!({ ...completed, aborted: true }, context);
  await extension.flush();
  assert.equal(server.requests.length, 2, "aborted settlement must suppress a successful assistant popup");
  await handlers.get("session_shutdown")!(completed, context);
});

test("tui missing socket completes best-effort without a CLI fallback", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cmux-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new CmuxClient({ env: envFor(join(directory, "missing.sock")), runner: noCommands });
  await client.notify({ title: "Done" });
  assert.equal((await client.getDiagnostics()).recentFailures.length, 1);
});
