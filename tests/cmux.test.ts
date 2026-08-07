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
  parseTmuxEnvironmentOutput,
  pickBestSurfaceId,
  resolveCmuxCli,
  type CommandRunner,
} from "../src/cmux.js";

test("detects current cmux environment and socket signals", () => {
  assert.equal(isInCmuxEnv({}, () => false), false);
  assert.equal(isInCmuxEnv({}, (path) => path.endsWith("/.local/state/cmux/cmux.sock")), true);
  assert.equal(isInCmuxEnv({}, (path) => path === "/tmp/cmux.sock"), true);
  if (process.getuid) {
    assert.equal(isInCmuxEnv({}, (path) => path.endsWith(`/cmux-${process.getuid?.()}.sock`)), true);
  }
  assert.equal(isInCmuxEnv({ CMUX_WORKSPACE_ID: "workspace:1" }, () => false), true);
  assert.equal(isInCmuxEnv({ CMUX_TAB_ID: "tab:1" }, () => false), true);
  assert.equal(isInCmuxEnv({ CMUX_SURFACE_ID: "surface:1" }, () => false), true);
  assert.equal(isInCmuxEnv({ CMUX_PANEL_ID: "panel:1" }, () => false), true);
  assert.equal(isInCmuxEnv({ CMUX_SOCKET_PATH: "/tmp/custom-cmux.sock" }, () => false), true);
  assert.equal(isInCmuxEnv({ CMUX_SOCKET_PATH: "127.0.0.1:<port>" }, () => false), true);
  assert.equal(isInCmuxEnv({ CMUX_SOCKET: "/tmp/compat-cmux.sock" }, () => false), true);
});

test("resolves bundled cmux cli only when it exists", () => {
  assert.equal(resolveCmuxCli({ CMUX_BUNDLED_CLI_PATH: "/opt/cmux" }, (path) => path === "/opt/cmux"), "/opt/cmux");
  assert.equal(resolveCmuxCli({ CMUX_BUNDLED_CLI_PATH: "/missing/cmux" }, () => false), "cmux");
  assert.equal(resolveCmuxCli({}, () => false), "cmux");
});

test("builds relay-safe scoped notification payloads", () => {
  const args = buildNotificationArgs(
    { title: "Done", subtitle: "Task", body: "Ready" },
    {
      CMUX_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
      CMUX_SURFACE_ID: "22222222-2222-4222-8222-222222222222",
    },
    "[dev:1 %2]",
  );

  assert.deepEqual(args.slice(0, 2), ["rpc", "notification.create"]);
  assert.deepEqual(JSON.parse(args[2]), {
    title: "Done",
    body: "[dev:1 %2] Task — Ready",
    workspace_id: "11111111-1111-4111-8111-111111111111",
    surface_id: "22222222-2222-4222-8222-222222222222",
  });
});

test("falls back to an unscoped notification without cmux context", () => {
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
  const workspaceShellStateArgs = buildReportShellStateArgs("prompt", { CMUX_WORKSPACE_ID: "workspace:1" });
  assert.deepEqual(workspaceShellStateArgs?.slice(0, 2), ["rpc", "surface.report_shell_state"]);
  assert.deepEqual(JSON.parse(workspaceShellStateArgs?.[2] ?? "{}"), {
    workspace_id: "workspace:1",
    state: "prompt",
  });
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

test("parses only cmux-managed shared values from tmux environment output", () => {
  assert.deepEqual(
    parseTmuxEnvironmentOutput([
      "CMUX_SOCKET_PATH=127.0.0.1:60000",
      "CMUX_WORKSPACE_ID=workspace:new",
      "CMUX_SURFACE_ID=surface:stale",
      "CMUX_REMOTE_TRANSPORT=ws",
      "CMUX_SOCKET_CAPABILITY=secret-capability",
      "CMUX_SOCKET_PASSWORD=secret-password",
      "SHELL=/bin/bash",
      "-CMUX_PANEL_ID",
      "-CMUX_SHELL_INTEGRATION_DIR",
    ].join("\n")),
    {
      CMUX_SOCKET_PATH: "127.0.0.1:60000",
      CMUX_WORKSPACE_ID: "workspace:new",
      CMUX_SHELL_INTEGRATION_DIR: undefined,
    },
  );
});

test("selects current cmux focused and selected-in-pane surface fields", () => {
  assert.equal(
    pickBestSurfaceId({
      surfaces: [
        { id: "surface:first" },
        { id: "surface:selected", selected_in_pane: true },
      ],
    }),
    "surface:selected",
  );
  assert.equal(
    pickBestSurfaceId({
      surfaces: [
        { id: "surface:selected", selected_in_pane: true },
        { id: "surface:focused", focused: true },
      ],
    }),
    "surface:focused",
  );
});

test("client refreshes shared cmux env from tmux and resolves its surface", async () => {
  const calls: Array<{
    command: string;
    args: readonly string[];
    socketPath: string | undefined;
    socketCapability: string | undefined;
    socketPassword: string | undefined;
  }> = [];
  const showEnvironmentTmuxValues: Array<string | undefined> = [];
  const runner: CommandRunner = async (command, args, options) => {
    if (command === "tmux" && args[0] === "show-environment") {
      showEnvironmentTmuxValues.push(options?.env?.TMUX);
      return {
        exitCode: 0,
        stdout: [
          "CMUX_SOCKET_PATH=127.0.0.1:60000",
          "CMUX_WORKSPACE_ID=workspace:new",
          "CMUX_SURFACE_ID=surface:stale",
          "CMUX_SOCKET_CAPABILITY=tmux-must-not-override",
          "CMUX_SOCKET_PASSWORD=tmux-must-not-override",
        ].join("\n"),
        stderr: "",
      };
    }

    calls.push({
      command,
      args,
      socketPath: options?.env?.CMUX_SOCKET_PATH,
      socketCapability: options?.env?.CMUX_SOCKET_CAPABILITY,
      socketPassword: options?.env?.CMUX_SOCKET_PASSWORD,
    });
    if (args[1] === "surface.list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ surfaces: [{ id: "surface:new", selected_in_pane: true }] }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await new CmuxClient({
    env: {
      TMUX: "/tmp/tmux-1000/default,1,0",
      CMUX_SOCKET_PATH: "127.0.0.1:50000",
      CMUX_SOCKET_CAPABILITY: "process-capability",
      CMUX_SOCKET_PASSWORD: "process-password",
      CMUX_WORKSPACE_ID: "workspace:old",
      CMUX_SURFACE_ID: "surface:old",
    },
    exists: () => false,
    runner,
  }).notify({ title: "Done" });

  assert.deepEqual(showEnvironmentTmuxValues, ["/tmp/tmux-1000/default,1,0", "/tmp/tmux-1000/default,1,0"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ socketPath }) => socketPath), ["127.0.0.1:60000", "127.0.0.1:60000"]);
  assert.deepEqual(calls.map(({ socketCapability }) => socketCapability), ["process-capability", "process-capability"]);
  assert.deepEqual(calls.map(({ socketPassword }) => socketPassword), ["process-password", "process-password"]);
  assert.deepEqual(calls[0].args.slice(0, 2), ["rpc", "surface.list"]);
  assert.deepEqual(JSON.parse(calls[0].args[2]), { workspace_id: "workspace:new" });
  assert.deepEqual(calls[1].args.slice(0, 2), ["rpc", "notification.create"]);
  assert.deepEqual(JSON.parse(calls[1].args[2]), {
    title: "Done",
    workspace_id: "workspace:new",
    surface_id: "surface:new",
  });
});

test("client preserves inherited shared cmux values when tmux refresh is partial", async () => {
  const calls: Array<{ args: readonly string[]; socketPath: string | undefined }> = [];
  const runner: CommandRunner = async (command, args, options) => {
    if (command === "tmux" && args[0] === "show-environment") {
      if (args.includes("-g")) {
        return { exitCode: 0, stdout: "CMUX_SOCKET_PATH=127.0.0.1:60000\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "no session" };
    }

    calls.push({ args, socketPath: options?.env?.CMUX_SOCKET_PATH });
    if (args[1] === "surface.list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ surfaces: [{ id: "surface:resolved", selected_in_pane: true }] }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await new CmuxClient({
    env: {
      TMUX: "/tmp/tmux-1000/default,1,0",
      CMUX_SOCKET_PATH: "127.0.0.1:50000",
      CMUX_WORKSPACE_ID: "workspace:old",
      CMUX_SURFACE_ID: "surface:stale",
    },
    exists: () => false,
    runner,
  }).notify({ title: "Done" });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ socketPath }) => socketPath), ["127.0.0.1:60000", "127.0.0.1:60000"]);
  assert.deepEqual(calls[0].args.slice(0, 2), ["rpc", "surface.list"]);
  assert.deepEqual(JSON.parse(calls[0].args[2]), { workspace_id: "workspace:old" });
  assert.deepEqual(calls[1].args.slice(0, 2), ["rpc", "notification.create"]);
  assert.deepEqual(JSON.parse(calls[1].args[2]), {
    title: "Done",
    workspace_id: "workspace:old",
    surface_id: "surface:resolved",
  });
});

test("client clears stale process cmux env when tmux marks values unset", async () => {
  let calls = 0;
  const runner: CommandRunner = async (command, args) => {
    if (command === "tmux" && args[0] === "show-environment") {
      return {
        exitCode: 0,
        stdout: ["-CMUX_SOCKET_PATH", "-CMUX_WORKSPACE_ID", "-CMUX_TAB_ID", "-CMUX_SURFACE_ID", "-CMUX_PANEL_ID"].join("\n"),
        stderr: "",
      };
    }

    calls++;
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await new CmuxClient({
    env: {
      TMUX: "/tmp/tmux-1000/default,1,0",
      CMUX_SOCKET_PATH: "127.0.0.1:50000",
      CMUX_WORKSPACE_ID: "workspace:old",
      CMUX_SURFACE_ID: "surface:old",
    },
    exists: () => false,
    runner,
  }).notify({ title: "Done" });

  assert.equal(calls, 0);
});

test("client preserves inherited shared cmux env when tmux omits values", async () => {
  const calls: Array<{ args: readonly string[]; socketPath: string | undefined }> = [];
  const runner: CommandRunner = async (command, args, options) => {
    if (command === "tmux" && args[0] === "show-environment") {
      return { exitCode: 0, stdout: "SHELL=/bin/bash\n", stderr: "" };
    }

    calls.push({ args, socketPath: options?.env?.CMUX_SOCKET_PATH });
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await new CmuxClient({
    env: {
      TMUX: "/tmp/tmux-1000/default,1,0",
      CMUX_SOCKET_PATH: "127.0.0.1:50000",
      CMUX_WORKSPACE_ID: "workspace:old",
      CMUX_SURFACE_ID: "surface:stale",
    },
    exists: () => false,
    runner,
  }).notify({ title: "Done" });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ socketPath }) => socketPath), ["127.0.0.1:50000", "127.0.0.1:50000"]);
  assert.deepEqual(calls.map(({ args }) => args[1]), ["surface.list", "notification.create"]);
  assert.deepEqual(JSON.parse(calls[1].args[2]), { title: "Done", workspace_id: "workspace:old" });
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
        stdout: JSON.stringify({
          surfaces: [
            { id: "surface:first" },
            { id: "surface:selected", selected_in_pane: true },
            { id: "surface:focused", focused: true },
          ],
        }),
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
  assert.deepEqual(calls[1].args.slice(0, 2), ["rpc", "notification.create"]);
  assert.deepEqual(JSON.parse(calls[1].args[2]), {
    title: "Pi done",
    workspace_id: "workspace:1",
    surface_id: "surface:focused",
  });
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
      assert.deepEqual(JSON.parse(calls[1][2]), { title: "Done", workspace_id: "workspace:1" });
    });
  }
});

test("client reports shell state with resolved workspace surface", async () => {
  const calls: Array<readonly string[]> = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[1] === "surface.list") {
      return { exitCode: 0, stdout: JSON.stringify({ surfaces: [{ id: "surface:9", selected_in_pane: true }] }), stderr: "" };
    }
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

test("client reports workspace-only shell state when no surface can be resolved", async () => {
  const calls: Array<readonly string[]> = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[1] === "surface.list") return { exitCode: 1, stdout: "", stderr: "unavailable" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner }).reportShellState("unknown");

  assert.deepEqual(calls.map((args) => args[1]), ["surface.list", "surface.report_shell_state"]);
  assert.deepEqual(JSON.parse(calls[1][2]), {
    workspace_id: "workspace:1",
    state: "unknown",
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

  assert.deepEqual(calls.map((args) => args[1]), ["notification.create", "surface.report_shell_state"]);
  assert.deepEqual(JSON.parse(calls[0][2]), {
    title: "Done",
    workspace_id: "workspace:1",
    surface_id: "surface:explicit",
  });
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

test("client uses optional status commands only when supported", async () => {
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

test("client serializes optional status commands", async () => {
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

test("client uses optional log command only when supported", async () => {
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

test("client re-probes optional commands when refreshed bundled cli path changes", async () => {
  let bundledCliPath = "/old/cmux";
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    if (command === "tmux" && args[0] === "show-environment") {
      return {
        exitCode: 0,
        stdout: [`CMUX_BUNDLED_CLI_PATH=${bundledCliPath}`, "CMUX_WORKSPACE_ID=workspace:1"].join("\n"),
        stderr: "",
      };
    }

    calls.push({ command, args });
    if (args[0] === "--help") {
      return {
        exitCode: 0,
        stdout: command === "/new/cmux" ? "Commands:\n  log   Write log entry\n" : "Commands:\n  ping   Check connectivity\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const client = new CmuxClient({
    env: { TMUX: "/tmp/tmux-1000/default,1,0", CMUX_BUNDLED_CLI_PATH: "/old/cmux", CMUX_WORKSPACE_ID: "workspace:old" },
    exists: (path) => path === "/old/cmux" || path === "/new/cmux",
    runner,
  });

  await client.log("Old");
  bundledCliPath = "/new/cmux";
  await client.log("New");

  assert.deepEqual(calls, [
    { command: "/old/cmux", args: ["--help"] },
    { command: "/new/cmux", args: ["--help"] },
    { command: "/new/cmux", args: ["log", "--", "New"] },
  ]);
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
  assert.deepEqual(calls[1].args.slice(0, 2), ["rpc", "notification.create"]);
  assert.deepEqual(JSON.parse(calls[1].args[2]), {
    title: "Pi done",
    body: "[dev:1 %2] Ready for input",
    workspace_id: "workspace:1",
    surface_id: "panel:3",
  });
});
