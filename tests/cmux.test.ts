import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClearStatusArgs,
  buildLogArgs,
  buildNotificationArgs,
  buildReportShellStateArgs,
  buildSetStatusArgs,
  CmuxClient,
  formatNotificationBody,
  getTmuxPaneLabel,
  isInCmuxEnv,
  resolveCmuxCli,
  type CommandRunner,
} from "../src/cmux.js";

test("detects cmux from workspace id, socket env, or default socket", () => {
  assert.equal(isInCmuxEnv({}, () => false), false);
  assert.equal(isInCmuxEnv({}, (path) => path === "/tmp/cmux.sock"), true);
  assert.equal(isInCmuxEnv({ CMUX_WORKSPACE_ID: "workspace:1" }, () => false), true);
  assert.equal(isInCmuxEnv({ CMUX_TAB_ID: "tab:1" }, () => false), true);
  assert.equal(isInCmuxEnv({ CMUX_SOCKET_PATH: "/tmp/custom-cmux.sock" }, () => false), true);
  assert.equal(isInCmuxEnv({ CMUX_SOCKET_PATH: "127.0.0.1:<port>" }, () => false), true);
});

test("resolves bundled cmux cli only when it exists", () => {
  assert.equal(resolveCmuxCli({ CMUX_BUNDLED_CLI_PATH: "/opt/cmux" }, (path) => path === "/opt/cmux"), "/opt/cmux");
  assert.equal(resolveCmuxCli({ CMUX_BUNDLED_CLI_PATH: "/missing/cmux" }, () => false), "cmux");
  assert.equal(resolveCmuxCli({}, () => false), "cmux");
});

test("builds surface-targeted notification payloads", () => {
  const args = buildNotificationArgs(
    { title: "Done", subtitle: "Task", body: "Ready" },
    { CMUX_SURFACE_ID: "surface:7" },
    "[dev:1 %2]",
  );

  assert.deepEqual(args.slice(0, 2), ["rpc", "notification.create_for_surface"]);
  assert.deepEqual(JSON.parse(args[2]), {
    title: "Done",
    body: "[dev:1 %2] Task — Ready",
    surface_id: "surface:7",
  });
});

test("falls back to workspace notification without surface id", () => {
  const args = buildNotificationArgs({ title: "Done" }, {}, "[pane]");

  assert.deepEqual(args.slice(0, 2), ["rpc", "notification.create"]);
  assert.deepEqual(JSON.parse(args[2]), { title: "Done", body: "[pane]" });
});

test("formats status and log commands without shell interpolation", () => {
  assert.deepEqual(buildSetStatusArgs("pi", "working", { icon: "terminal", color: "#f59e0b" }), [
    "set-status",
    "pi",
    "working",
    "--icon",
    "terminal",
    "--color",
    "#f59e0b",
  ]);
  assert.deepEqual(buildClearStatusArgs("pi"), ["clear-status", "pi"]);
  assert.deepEqual(buildLogArgs("Done", { level: "warn", source: "pi" }), ["log", "--level", "warning", "--source", "pi", "--", "Done"]);

  const shellStateArgs = buildReportShellStateArgs("running", {
    CMUX_WORKSPACE_ID: "workspace:1",
    CMUX_SURFACE_ID: "surface:2",
  });
  assert.deepEqual(shellStateArgs?.slice(0, 2), ["rpc", "surface.report_shell_state"]);
  assert.deepEqual(JSON.parse(shellStateArgs?.[2] ?? "{}"), {
    workspace_id: "workspace:1",
    surface_id: "surface:2",
    state: "running",
  });
  assert.equal(buildReportShellStateArgs("prompt", { CMUX_WORKSPACE_ID: "workspace:1" }), undefined);
});

test("formats notification bodies with optional pane labels", () => {
  assert.equal(formatNotificationBody({ subtitle: "Step S1", body: "Ready" }, "[dev:1 %2]"), "[dev:1 %2] Step S1 — Ready");
  assert.equal(formatNotificationBody({}, "[dev:1 %2]"), "[dev:1 %2]");
  assert.equal(formatNotificationBody({ body: "Ready" }), "Ready");
});

test("gets tmux pane label and falls back to raw pane id", async () => {
  const okRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "dev:1 %2\n", stderr: "" });
  assert.equal(await getTmuxPaneLabel({ TMUX_PANE: "%2" }, okRunner), "[dev:1 %2]");

  const failingRunner: CommandRunner = async () => ({ exitCode: 1, stdout: "", stderr: "no pane" });
  assert.equal(await getTmuxPaneLabel({ TMUX_PANE: "%2" }, failingRunner), "[%2]");
  assert.equal(await getTmuxPaneLabel({}, failingRunner), "");
});

test("client no-ops outside cmux and swallows command failures", async () => {
  let calls = 0;
  const runner: CommandRunner = async () => {
    calls++;
    throw new Error("cmux failed");
  };

  await new CmuxClient({ env: {}, exists: () => false, runner }).notify({ title: "Done" });
  assert.equal(calls, 0);

  await assert.doesNotReject(async () => {
    await new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner }).setStatus("pi", "working");
  });
  assert.equal(calls, 1);
});

test("client resolves workspace surface for notifications", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args[1] === "surface.list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { id: "surface:first" },
          { id: "surface:selected", selected: true },
          { id: "surface:focused", focused: true },
        ]),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const client = new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner });
  await client.notify({ title: "Pi done" });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 2), ["rpc", "surface.list"]);
  assert.deepEqual(JSON.parse(calls[0].args[2]), { workspace_id: "workspace:1" });
  assert.deepEqual(calls[1].args.slice(0, 2), ["rpc", "notification.create_for_surface"]);
  assert.deepEqual(JSON.parse(calls[1].args[2]), { title: "Pi done", surface_id: "surface:focused" });
});

test("client falls back to generic notification when workspace surface cannot be resolved", async (t) => {
  const cases: Array<{ name: string; result: { exitCode: number; stdout: string; stderr: string } }> = [
    { name: "surface.list fails", result: { exitCode: 1, stdout: "", stderr: "failed" } },
    { name: "surface.list returns invalid JSON", result: { exitCode: 0, stdout: "not json", stderr: "" } },
    { name: "surface.list returns no surfaces", result: { exitCode: 0, stdout: JSON.stringify([]), stderr: "" } },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const calls: Array<readonly string[]> = [];
      const runner: CommandRunner = async (_command, args) => {
        calls.push(args);
        if (args[1] === "surface.list") return entry.result;
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      await new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner }).notify({ title: "Done" });

      assert.deepEqual(calls.map((args) => args[1]), ["surface.list", "notification.create"]);
      assert.deepEqual(JSON.parse(calls[1][2]), { title: "Done" });
    });
  }
});

test("client reports shell state with resolved workspace surface", async () => {
  const calls: Array<readonly string[]> = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[1] === "surface.list") return { exitCode: 0, stdout: JSON.stringify({ surfaces: [{ id: "surface:9", selected: true }] }), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner }).reportShellState("running");

  assert.deepEqual(calls.map((args) => args[1]), ["surface.list", "surface.report_shell_state"]);
  assert.deepEqual(JSON.parse(calls[1][2]), {
    workspace_id: "workspace:1",
    surface_id: "surface:9",
    state: "running",
  });
});

test("client prefers explicit surface env and does not call surface.list", async () => {
  const calls: Array<readonly string[]> = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const client = new CmuxClient({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:explicit" },
    exists: () => false,
    runner,
  });

  await client.notify({ title: "Done" });
  await client.reportShellState("prompt");

  assert.deepEqual(calls.map((args) => args[1]), ["notification.create_for_surface", "surface.report_shell_state"]);
  assert.deepEqual(JSON.parse(calls[0][2]), { title: "Done", surface_id: "surface:explicit" });
  assert.deepEqual(JSON.parse(calls[1][2]), {
    workspace_id: "workspace:1",
    surface_id: "surface:explicit",
    state: "prompt",
  });
});

test("client reports surface shell state explicitly", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const client = new CmuxClient({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:2" },
    exists: () => false,
    runner,
  });

  await client.reportShellState("running");
  await client.reportShellState("prompt");

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 2), ["rpc", "surface.report_shell_state"]);
  assert.deepEqual(JSON.parse(calls[0].args[2]), {
    workspace_id: "workspace:1",
    surface_id: "surface:2",
    state: "running",
  });
  assert.deepEqual(JSON.parse(calls[1].args[2]), {
    workspace_id: "workspace:1",
    surface_id: "surface:2",
    state: "prompt",
  });
});

test("client uses optional legacy status commands only when supported", async () => {
  const unsupportedCalls: Array<readonly string[]> = [];
  const unsupportedRunner: CommandRunner = async (_command, args) => {
    unsupportedCalls.push(args);
    return { exitCode: 0, stdout: "Usage: cmux\n\nCommands:\n  ping   Check connectivity\n", stderr: "" };
  };

  const unsupportedClient = new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner: unsupportedRunner });
  await unsupportedClient.setStatus("pi", "working");
  await unsupportedClient.clearStatus("pi");
  assert.deepEqual(unsupportedCalls, [["--help"]]);

  const supportedCalls: Array<readonly string[]> = [];
  const supportedRunner: CommandRunner = async (_command, args) => {
    supportedCalls.push(args);
    if (args[0] === "--help") return { exitCode: 0, stdout: "Commands:\n  set-status   Set status\n  clear-status Clear status\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const supportedClient = new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner: supportedRunner });
  await supportedClient.setStatus("pi", "working", { icon: "terminal" });
  await supportedClient.clearStatus("pi");
  assert.deepEqual(supportedCalls, [["--help"], ["set-status", "pi", "working", "--icon", "terminal"], ["clear-status", "pi"]]);
});

test("client serializes optional legacy status commands", async () => {
  const calls: string[] = [];
  let activeStatusCommands = 0;
  let maxActiveStatusCommands = 0;
  let setStarted!: () => void;
  let unblockSet!: () => void;
  const setStartedPromise = new Promise<void>((resolve) => {
    setStarted = resolve;
  });
  const unblockSetPromise = new Promise<void>((resolve) => {
    unblockSet = resolve;
  });

  const runner: CommandRunner = async (_command, args) => {
    if (args[0] === "--help") {
      return { exitCode: 0, stdout: "Commands:\n  set-status   Set status\n  clear-status Clear status\n", stderr: "" };
    }

    calls.push(String(args[0]));
    activeStatusCommands++;
    maxActiveStatusCommands = Math.max(maxActiveStatusCommands, activeStatusCommands);
    if (args[0] === "set-status") {
      setStarted();
      await unblockSetPromise;
    }
    activeStatusCommands--;
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const client = new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner });
  const set = client.setStatus("pi", "working");
  const clear = client.clearStatus("pi");

  await setStartedPromise;
  assert.deepEqual(calls, ["set-status"]);
  unblockSet();
  await Promise.all([set, clear]);

  assert.deepEqual(calls, ["set-status", "clear-status"]);
  assert.equal(maxActiveStatusCommands, 1);
});

test("client uses optional legacy log command only when supported", async () => {
  const unsupportedCalls: Array<readonly string[]> = [];
  const unsupportedRunner: CommandRunner = async (_command, args) => {
    unsupportedCalls.push(args);
    return { exitCode: 0, stdout: "Usage: cmux\n\nCommands:\n  ping   Check connectivity\n", stderr: "" };
  };

  await new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner: unsupportedRunner }).log("Done");
  assert.deepEqual(unsupportedCalls, [["--help"]]);

  const supportedCalls: Array<readonly string[]> = [];
  const supportedRunner: CommandRunner = async (_command, args) => {
    supportedCalls.push(args);
    if (args[0] === "--help") return { exitCode: 0, stdout: "Commands:\n  log   Write log entry\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner: supportedRunner }).log("Done", {
    level: "success",
    source: "pi",
  });
  assert.deepEqual(supportedCalls, [["--help"], ["log", "--level", "success", "--source", "pi", "--", "Done"]]);
});

test("client sends tmux-labeled cmux notifications", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "tmux") return { exitCode: 0, stdout: "dev:1 %2\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const client = new CmuxClient({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_PANEL_ID: "panel:3", TMUX_PANE: "%2" },
    exists: () => false,
    runner,
  });
  await client.notify({ title: "Pi done", body: "Ready for input" });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "tmux");
  assert.deepEqual(calls[1].args.slice(0, 2), ["rpc", "notification.create_for_surface"]);
  assert.deepEqual(JSON.parse(calls[1].args[2]), {
    title: "Pi done",
    body: "[dev:1 %2] Ready for input",
    surface_id: "panel:3",
  });
});
