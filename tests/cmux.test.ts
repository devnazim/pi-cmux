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
  resolveCmuxSurfaceId,
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

test("keeps local scoped notification payloads", () => {
  const args = buildNotificationArgs(
    { title: "Done", subtitle: "Task", body: "Ready" },
    {
      CMUX_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
      CMUX_SURFACE_ID: "22222222-2222-4222-8222-222222222222",
    },
    "[dev:1 %2]",
  );

  assert.ok(args);
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

  assert.ok(args);
  assert.deepEqual(args.slice(0, 2), ["rpc", "notification.create"]);
  assert.deepEqual(JSON.parse(args[2]), { title: "Done", body: "[pane]" });
});

test("builds relay notifications with both target identities and compatibility aliases", () => {
  for (const socketKey of ["CMUX_SOCKET_PATH", "CMUX_SOCKET"]) {
    for (const ids of [
      { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" },
      { CMUX_TAB_ID: "workspace:1", CMUX_PANEL_ID: "surface:1" },
    ]) {
      const args = buildNotificationArgs(
        { title: "Done", subtitle: "Task", body: "Ready" },
        { ...ids, [socketKey]: "localhost:60000" },
        "[dev:1 %2]",
      );
      assert.ok(args);
      assert.deepEqual(args.slice(0, 2), ["rpc", "notification.create_for_target"]);
      assert.deepEqual(JSON.parse(args[2]), {
        title: "Done", body: "[dev:1 %2] Task — Ready", workspace_id: "workspace:1", surface_id: "surface:1",
      });
    }
  }
});

test("relay notification payloads require both identities", () => {
  for (const missing of [undefined, "", "  "]) {
    assert.equal(buildNotificationArgs({ title: "Done" }, {
      CMUX_SOCKET_PATH: "127.0.0.1:60000", CMUX_WORKSPACE_ID: missing, CMUX_SURFACE_ID: "surface:1",
    }), undefined);
    assert.equal(buildNotificationArgs({ title: "Done" }, {
      CMUX_SOCKET_PATH: "127.0.0.1:60000", CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: missing,
    }), undefined);
  }
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

test("shell-state payloads include only non-empty terminal lifecycle IDs", () => {
  const env = { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:2" };
  for (const lifecycleId of [undefined, "", "  ", "11111111-1111-4111-8111-111111111111"]) {
    const args = buildReportShellStateArgs("running", { ...env, CMUX_TERMINAL_LIFECYCLE_ID: lifecycleId });
    assert.ok(args);
    assert.deepEqual(JSON.parse(args[2]), {
      workspace_id: "workspace:1",
      surface_id: "surface:2",
      state: "running",
      ...(lifecycleId?.trim() ? { terminal_lifecycle_id: lifecycleId } : {}),
    });
  }
});

test("shell-state payloads omit lifecycle IDs for inferred or mismatched surfaces", () => {
  for (const explicitSurface of [undefined, "surface:reporter"]) {
    for (const target of ["surface:focused", ""]) {
      const args = buildReportShellStateArgs("running", {
        CMUX_WORKSPACE_ID: "workspace:1",
        CMUX_SURFACE_ID: explicitSurface,
        CMUX_TERMINAL_LIFECYCLE_ID: "11111111-1111-4111-8111-111111111111",
      }, target);
      assert.ok(args);
      assert.deepEqual(JSON.parse(args[2]), {
        workspace_id: "workspace:1",
        state: "running",
        ...(target ? { surface_id: target } : {}),
      });
    }
  }
});

test("shell-state payloads preserve lifecycle IDs with the explicit compatibility surface", () => {
  const args = buildReportShellStateArgs("prompt", {
    CMUX_WORKSPACE_ID: "workspace:1",
    CMUX_PANEL_ID: "surface:reporter",
    CMUX_TERMINAL_LIFECYCLE_ID: "11111111-1111-4111-8111-111111111111",
  });
  assert.ok(args);
  assert.deepEqual(JSON.parse(args[2]), {
    workspace_id: "workspace:1",
    surface_id: "surface:reporter",
    state: "prompt",
    terminal_lifecycle_id: "11111111-1111-4111-8111-111111111111",
  });
});

test("shell-state workspace fallback is local-only", () => {
  for (const socketPath of ["127.0.0.1:60000", "localhost:1", "LOCALHOST:65535", " localhost:00080 ", "localhost:+80"]) {
    for (const socketKey of ["CMUX_SOCKET_PATH", "CMUX_SOCKET"]) {
      assert.equal(buildReportShellStateArgs("prompt", { CMUX_WORKSPACE_ID: "workspace:1", [socketKey]: socketPath }), undefined);
    }
  }
  for (const socketPath of [
    undefined, "/tmp/cmux.sock", "/tmp/cmux:local.sock", "./cmux:local.sock", "cmux:local.sock",
    "tcp://127.0.0.1:60000", "[::1]:60000", "example.com:80", "127.0.0.2:80",
    "localhost:0", "localhost:65536", "localhost:-1", "localhost:1.5", "localhost:1e3",
    "localhost:", "localhost:abc", "localhost: 80", "localhost:80:90",
  ]) {
    for (const socketKey of ["CMUX_SOCKET_PATH", "CMUX_SOCKET"]) {
      assert.ok(buildReportShellStateArgs("prompt", { CMUX_WORKSPACE_ID: "workspace:1", [socketKey]: socketPath }));
    }
  }
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

test("surface resolver uses workspace-scoped relay lookup and keeps local selection", async () => {
  const relayCalls: Array<readonly string[]> = [];
  const workspaceId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const relaySurfaceId = await resolveCmuxSurfaceId(
    { CMUX_WORKSPACE_ID: workspaceId, CMUX_SOCKET_PATH: "127.0.0.1:60000" },
    () => false,
    async (_command, args) => {
      relayCalls.push(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          workspace_id: workspaceId.toUpperCase(),
          workspace_ref: "workspace:1",
          surface_id: "11111111-2222-4333-8444-555555555555",
          surface_ref: "surface:1",
          pane_id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
          surface_type: "terminal",
        }),
        stderr: "",
      };
    },
  );

  assert.equal(relaySurfaceId, "11111111-2222-4333-8444-555555555555");
  assert.deepEqual(relayCalls[0].slice(0, 2), ["rpc", "surface.current"]);
  assert.deepEqual(JSON.parse(relayCalls[0][2]), { workspace_id: workspaceId });

  const refSurfaceId = await resolveCmuxSurfaceId(
    { CMUX_WORKSPACE_ID: "workspace:7", CMUX_SOCKET_PATH: "localhost:60000" },
    () => false,
    async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        workspace_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        workspace_ref: "workspace:7",
        surface_id: "surface:7",
        surface_ref: "surface:7-ref",
        pane_id: "pane:7",
        surface_type: "terminal",
      }),
      stderr: "",
    }),
  );
  assert.equal(refSurfaceId, "surface:7");

  const localCalls: Array<readonly string[]> = [];
  const localSurfaceId = await resolveCmuxSurfaceId(
    { CMUX_WORKSPACE_ID: "workspace:local", CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
    () => false,
    async (_command, args) => {
      localCalls.push(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ surfaces: [{ id: "surface:first" }, { id: "surface:focused", focused: true }] }),
        stderr: "",
      };
    },
  );
  assert.equal(localSurfaceId, "surface:focused");
  assert.deepEqual(localCalls[0].slice(0, 2), ["rpc", "surface.list"]);
});

test("surface resolver rejects unsafe relay responses and skips explicit lookup", async (t) => {
  const workspaceId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const cases: Array<{ name: string; result: { exitCode: number; stdout: string; stderr: string } }> = [
    { name: "command failure", result: { exitCode: 7, stdout: "", stderr: "failed" } },
    { name: "invalid JSON", result: { exitCode: 0, stdout: "not json", stderr: "" } },
    { name: "non-object response", result: { exitCode: 0, stdout: "[]", stderr: "" } },
    { name: "missing workspace ownership", result: { exitCode: 0, stdout: JSON.stringify({ surface_id: "surface:1", surface_type: "terminal" }), stderr: "" } },
    { name: "mismatched workspace", result: { exitCode: 0, stdout: JSON.stringify({ workspace_id: "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb", surface_id: "surface:1", surface_type: "terminal" }), stderr: "" } },
    { name: "empty surface", result: { exitCode: 0, stdout: JSON.stringify({ workspace_id: workspaceId, surface_id: "  ", surface_type: "terminal" }), stderr: "" } },
    { name: "missing surface type", result: { exitCode: 0, stdout: JSON.stringify({ workspace_id: workspaceId, surface_id: "surface:1" }), stderr: "" } },
    { name: "non-terminal surface", result: { exitCode: 0, stdout: JSON.stringify({ workspace_id: workspaceId, surface_id: "surface:1", surface_type: "browser" }), stderr: "" } },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let calls = 0;
      const surfaceId = await resolveCmuxSurfaceId(
        { CMUX_WORKSPACE_ID: workspaceId, CMUX_SOCKET_PATH: "127.0.0.1:60000" },
        () => false,
        async () => {
          calls++;
          return entry.result;
        },
      );
      assert.equal(surfaceId, undefined);
      assert.equal(calls, 1);
    });
  }

  let calls = 0;
  assert.equal(await resolveCmuxSurfaceId(
    { CMUX_WORKSPACE_ID: workspaceId, CMUX_SURFACE_ID: "surface:explicit", CMUX_SOCKET_PATH: "127.0.0.1:60000" },
    () => false,
    async () => {
      calls++;
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    },
  ), "surface:explicit");
  assert.equal(calls, 0);
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
    if (args[1] === "surface.current") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          workspace_id: "workspace:new",
          workspace_ref: "workspace:1",
          surface_id: "surface:new",
          surface_ref: "surface:1",
          pane_id: "pane:new",
          surface_type: "terminal",
        }),
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
  assert.deepEqual(calls[0].args.slice(0, 2), ["rpc", "surface.current"]);
  assert.deepEqual(JSON.parse(calls[0].args[2]), { workspace_id: "workspace:new" });
  assert.deepEqual(calls[1].args.slice(0, 2), ["rpc", "notification.create_for_target"]);
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
    if (args[1] === "surface.current") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          workspace_id: "workspace:old",
          workspace_ref: "workspace:1",
          surface_id: "surface:resolved",
          surface_ref: "surface:1",
          pane_id: "pane:resolved",
          surface_type: "terminal",
        }),
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
  assert.deepEqual(calls[0].args.slice(0, 2), ["rpc", "surface.current"]);
  assert.deepEqual(JSON.parse(calls[0].args[2]), { workspace_id: "workspace:old" });
  assert.deepEqual(calls[1].args.slice(0, 2), ["rpc", "notification.create_for_target"]);
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

  assert.equal(calls.length, 1);
  assert.equal(calls[0].socketPath, "127.0.0.1:50000");
  assert.deepEqual(calls[0].args.slice(0, 2), ["rpc", "surface.current"]);
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

test("client skips unresolved relay shell state and notifications", async () => {
  const calls: Array<readonly string[]> = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[1] === "surface.current") return { exitCode: 1, stdout: "", stderr: "unavailable" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const client = new CmuxClient({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SOCKET_PATH: "127.0.0.1:60000" },
    exists: () => false,
    runner,
  });

  await client.reportShellState("running");
  assert.deepEqual(calls.map((args) => args[1]), ["surface.current"]);
  await client.notify({ title: "Done" });
  assert.deepEqual(calls.map((args) => args[1]), ["surface.current", "surface.current"]);
});

test("client omits a refreshed tmux lifecycle when another terminal has focus", async () => {
  const calls: Array<readonly string[]> = [];
  const lifecycleId = "11111111-1111-4111-8111-111111111111";
  const runner: CommandRunner = async (command, args) => {
    if (command === "tmux") {
      return { exitCode: 0, stdout: `CMUX_TERMINAL_LIFECYCLE_ID=${lifecycleId}\nCMUX_SOCKET_PATH=127.0.0.1:60000`, stderr: "" };
    }
    calls.push(args);
    if (args[1] === "surface.current") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          workspace_id: "workspace:1",
          workspace_ref: "workspace:1-ref",
          surface_id: "surface:focused",
          surface_ref: "surface:1",
          pane_id: "pane:focused",
          surface_type: "terminal",
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await new CmuxClient({
    env: {
      TMUX: "/tmp/tmux-1000/default,1,0",
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:reporter",
      CMUX_TERMINAL_LIFECYCLE_ID: "22222222-2222-4222-8222-222222222222",
    },
    exists: () => false,
    runner,
  }).reportShellState("running");

  assert.deepEqual(calls.map((args) => args[1]), ["surface.current", "surface.report_shell_state"]);
  assert.deepEqual(JSON.parse(calls[1][2]), {
    workspace_id: "workspace:1",
    surface_id: "surface:focused",
    state: "running",
  });
});

test("client prefers explicit surface env and does not perform surface lookup", async () => {
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

test("both help layouts support owned sidebar cleanup, logs and diagnostics", async (t) => {
  // Command rows from v0.64.25 usage and v0.65.0 Automation task help.
  const rows = [
    "set-status <key> <value> [--workspace <id|ref|index>] [--window <id|ref|index>] [--icon <name>] [--color <#hex>] [--priority <n>]",
    "clear-status <key> [--workspace <id|ref|index>] [--window <id|ref|index>]",
    "log [--level <level>] [--source <name>] [--workspace <id|ref|index>] [--window <id|ref|index>] <message>",
  ];
  for (const grouped of [false, true]) {
    for (const stream of ["stdout", "stderr"] as const) {
      await t.test(`${grouped ? "v0.65.0 grouped" : "legacy"} help on ${stream}`, async () => {
        const help = ["cmux - control cmux via Unix socket", "", "Commands:",
          ...(grouped ? ["  Automation:"] : []),
          ...rows.map((row) => `${grouped ? "    " : "  "}${row}`),
        ].join("\n");
        const env = { CMUX_WORKSPACE_ID: "workspace:original", CMUX_SURFACE_ID: "surface:original" };
        const calls: Array<{ args: readonly string[]; workspaceId?: string; surfaceId?: string }> = [];
        const client = new CmuxClient({ env, exists: () => false, runner: async (_command, args, options) => {
          calls.push({ args, workspaceId: options?.env?.CMUX_WORKSPACE_ID, surfaceId: options?.env?.CMUX_SURFACE_ID });
          if (args[0] === "--help") return { exitCode: 0, stdout: "", stderr: "", [stream]: help };
          return { exitCode: args[0] === "set-status" ? 7 : 0, stdout: "", stderr: "" };
        } });
        const target = await client.captureTarget();
        assert.equal(await client.setStatus("owner", "working", {}, target), "attempted");
        env.CMUX_WORKSPACE_ID = "workspace:other";
        env.CMUX_SURFACE_ID = "surface:other";
        assert.equal(await client.clearStatus("owner", target), true);
        await client.log("done", {}, target);
        const diagnostics = await client.getDiagnostics(target);
        assert.deepEqual(diagnostics.supportedCommands, ["set-status", "clear-status", "log"]);
        assert.deepEqual(diagnostics.recentFailures, [{ operation: "set-status", exitCode: 7 }]);
        assert.equal(diagnostics.transport, "local");
        assert.equal(diagnostics.workspaceId, "workspace:original");
        assert.equal(diagnostics.surfaceId, "surface:original");
        assert.ok(calls.every(({ workspaceId, surfaceId }) => workspaceId === "workspace:original" && surfaceId === "surface:original"));
        assert.deepEqual(calls.map(({ args }) => args), [
          ["--help"],
          ["set-status", "owner", "working", "--panel=surface:original", `--pid=${process.pid}`],
          ["clear-status", "owner", "--panel=surface:original"],
          ["log", "--", "done"],
        ]);
      });
    }
  }
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

test("captured tmux target survives focus, workspace and relay-port changes", async () => {
  let workspaceId = "workspace:original";
  let surfaceId = "surface:original";
  let socketPath = "127.0.0.1:50000";
  const calls: Array<{ args: readonly string[]; socketPath?: string }> = [];
  const runner: CommandRunner = async (command, args, options) => {
    if (command === "tmux") {
      return { exitCode: 0, stdout: `CMUX_WORKSPACE_ID=${workspaceId}\nCMUX_SOCKET_PATH=${socketPath}\nCMUX_TERMINAL_LIFECYCLE_ID=unrelated`, stderr: "" };
    }
    calls.push({ args, socketPath: options?.env?.CMUX_SOCKET_PATH });
    if (args[1] === "surface.current") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          workspace_id: workspaceId,
          workspace_ref: "workspace:1",
          surface_id: surfaceId,
          surface_ref: "surface:1",
          pane_id: "pane:1",
          surface_type: "terminal",
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const client = new CmuxClient({ env: { TMUX: "/tmp/mock-tmux" }, exists: () => false, runner });
  const target = await client.captureTarget();
  await client.reportShellState("running", target);
  workspaceId = "workspace:other";
  surfaceId = "surface:other";
  socketPath = "127.0.0.1:60000";
  await client.reportShellState("prompt", target);
  await client.notify({ title: "Done" }, target);
  assert.deepEqual(calls.map(({ args }) => args[1]), ["surface.current", "surface.report_shell_state", "surface.report_shell_state", "notification.create_for_target"]);
  assert.deepEqual(calls.map(({ socketPath }) => socketPath), ["127.0.0.1:50000", "127.0.0.1:50000", "127.0.0.1:60000", "127.0.0.1:60000"]);
  for (const { args } of calls.slice(1)) {
    const payload = JSON.parse(args[2]);
    assert.equal(payload.workspace_id, "workspace:original");
    assert.equal(payload.surface_id, "surface:original");
    assert.equal(payload.terminal_lifecycle_id, undefined);
  }
});

test("captured target keeps sidebar ownership and drops a replaced lifecycle token", async () => {
  const env = {
    CMUX_WORKSPACE_ID: "workspace:original", CMUX_SURFACE_ID: "surface:original", CMUX_TERMINAL_LIFECYCLE_ID: "lifecycle:original",
  };
  const calls: Array<{ args: readonly string[]; workspaceId?: string; surfaceId?: string }> = [];
  const client = new CmuxClient({ env, exists: () => false, runner: async (_command, args, options) => {
    calls.push({ args, workspaceId: options?.env?.CMUX_WORKSPACE_ID, surfaceId: options?.env?.CMUX_SURFACE_ID });
    return { exitCode: 0, stdout: "Commands:\n  set-status Set\n  clear-status Clear\n  log Log\n", stderr: "" };
  } });
  const target = await client.captureTarget();
  await client.reportShellState("running", target);
  assert.equal(JSON.parse(calls[0].args[2]).terminal_lifecycle_id, "lifecycle:original");
  env.CMUX_WORKSPACE_ID = "workspace:other";
  env.CMUX_SURFACE_ID = "surface:other";
  env.CMUX_TERMINAL_LIFECYCLE_ID = "lifecycle:other";
  await client.reportShellState("prompt", target);
  await client.setStatus("owner", "working", {}, target);
  await client.clearStatus("owner", target);
  await client.log("done", {}, target);
  assert.equal(JSON.parse(calls[1].args[2]).terminal_lifecycle_id, undefined);
  assert.ok(calls.every((call) => call.workspaceId === "workspace:original" && call.surfaceId === "surface:original"));
  assert.deepEqual(calls.find(({ args }) => args[0] === "set-status")?.args, [
    "set-status", "owner", "working", "--panel=surface:original", `--pid=${process.pid}`,
  ]);
  assert.deepEqual(calls.find(({ args }) => args[0] === "clear-status")?.args, [
    "clear-status", "owner", "--panel=surface:original",
  ]);
});

test("incomplete captured targets cannot write unowned sidebar entries", async () => {
  const calls: Array<readonly string[]> = [];
  const client = new CmuxClient({
    env: { CMUX_WORKSPACE_ID: "workspace:focused", CMUX_SURFACE_ID: "surface:focused" }, exists: () => false,
    runner: async (_command, args) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  for (const target of [{}, { workspaceId: "workspace:1" }, { surfaceId: "surface:1" }]) {
    await client.setStatus("owner", "working", {}, target);
    assert.equal(await client.clearStatus("owner", target), true);
  }
  assert.deepEqual(calls, []);
});

test("client rejects unsafe relay targets and records lookup failures", async (t) => {
  const workspaceId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const cases: Array<{
    name: string;
    result: { exitCode: number; stdout: string; stderr: string };
    failure?: { operation: string; exitCode: number };
  }> = [
    {
      name: "command failure",
      result: { exitCode: 7, stdout: "", stderr: "failed" },
      failure: { operation: "rpc surface.current", exitCode: 7 },
    },
    {
      name: "JSON parse failure",
      result: { exitCode: 0, stdout: "not json", stderr: "" },
      failure: { operation: "rpc surface.current", exitCode: 1 },
    },
    {
      name: "mismatched workspace",
      result: {
        exitCode: 0,
        stdout: JSON.stringify({
          workspace_id: "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb",
          workspace_ref: "workspace:9",
          surface_id: "surface:other",
          surface_type: "terminal",
        }),
        stderr: "",
      },
    },
    {
      name: "missing surface type",
      result: { exitCode: 0, stdout: JSON.stringify({ workspace_id: workspaceId, surface_id: "surface:1" }), stderr: "" },
    },
    {
      name: "non-terminal surface",
      result: {
        exitCode: 0,
        stdout: JSON.stringify({ workspace_id: workspaceId, surface_id: "surface:1", surface_type: "browser" }),
        stderr: "",
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const calls: Array<readonly string[]> = [];
      const client = new CmuxClient({
        env: { CMUX_WORKSPACE_ID: workspaceId, CMUX_SOCKET_PATH: "127.0.0.1:60000" },
        exists: () => false,
        runner: async (_command, args) => {
          calls.push(args);
          return entry.result;
        },
      });
      const target = await client.captureTarget();
      assert.equal(target.workspaceId, workspaceId);
      assert.equal(target.surfaceId, undefined);
      assert.equal(await client.reportShellState("running", target), false);
      await client.notify({ title: "Done" }, target);
      assert.deepEqual(calls.map((args) => args[1]), ["surface.current"]);
      assert.deepEqual((await client.getDiagnostics(target)).recentFailures, entry.failure ? [entry.failure] : []);
      await client.notify({ title: "Done" });
      assert.deepEqual(calls.map((args) => args[1]), ["surface.current", "surface.current"]);
      assert.deepEqual((await client.getDiagnostics(target)).recentFailures, entry.failure ? [entry.failure, entry.failure] : []);
    });
  }
});

test("relay notifications skip missing workspace identity without falling back to focus", async () => {
  const calls: Array<readonly string[]> = [];
  const client = new CmuxClient({
    env: { CMUX_SOCKET_PATH: "localhost:60000", CMUX_SURFACE_ID: "surface:focused" }, exists: () => false,
    runner: async (_command, args) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  await client.notify({ title: "Done" });
  await client.notify({ title: "Done" }, { surfaceId: "surface:owned" });
  assert.deepEqual(calls, []);
});

test("relay notification diagnostics name the scoped RPC and omit private content", async () => {
  const calls: Array<readonly string[]> = [];
  const client = new CmuxClient({
    env: {
      CMUX_SOCKET_PATH: "localhost:60000", CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1",
      CMUX_SOCKET_PASSWORD: "secret-password", CMUX_SOCKET_CAPABILITY: "secret-capability",
    },
    exists: () => false,
    runner: async (_command, args) => {
      calls.push(args);
      return { exitCode: 7, stdout: "private stdout", stderr: "secret-password secret-capability private stderr" };
    },
  });
  await client.notify({ title: "private title", body: "private body" });
  assert.deepEqual(calls[0].slice(0, 2), ["rpc", "notification.create_for_target"]);
  const diagnostics = await client.getDiagnostics();
  assert.equal(calls.length, 1);
  assert.equal(diagnostics.transport, "relay");
  assert.deepEqual(diagnostics.supportedCommands, []);
  assert.deepEqual(diagnostics.recentFailures, [{ operation: "rpc notification.create_for_target", exitCode: 7 }]);
  assert.ok(!/secret|private/.test(JSON.stringify(diagnostics)));
});

test("an unresolved captured target never falls back to focus on local or relay connections", async () => {
  for (const socketPath of ["/tmp/cmux.sock", "localhost:60000"]) {
    const calls: Array<readonly string[]> = [];
    const client = new CmuxClient({
      env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SOCKET_PATH: socketPath }, exists: () => false,
      runner: async (_command, args) => {
        calls.push(args);
        if (args[1] === "surface.list") return { exitCode: 1, stdout: "", stderr: "failed" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const target = await client.captureTarget();
    assert.equal(await client.reportShellState("running", target), false);
    assert.equal(await client.reportShellState("prompt", target), false);
    await client.notify({ title: "Done" }, target);
    assert.deepEqual(calls.map((args) => args[1]), [socketPath.startsWith("localhost") ? "surface.current" : "surface.list"]);
  }
});

test("relay transports skip legacy sidebar commands even after a successful local probe", async () => {
  const calls: Array<readonly string[]> = [];
  const env = { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1", CMUX_SOCKET_PATH: "/tmp/cmux.sock" };
  const client = new CmuxClient({ env, exists: () => false, runner: async (_command, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "Commands:\n  set-status Set\n  clear-status Clear\n  log Log\n", stderr: "" };
  } });
  await client.log("local");
  calls.length = 0;
  env.CMUX_SOCKET_PATH = "localhost:60000";
  await client.setStatus("pi", "working");
  await client.clearStatus("pi");
  await client.log("remote");
  assert.deepEqual(calls, []);
  await client.reportShellState("running");
  await client.notify({ title: "Done" });
  assert.deepEqual(calls.map((args) => args[1]), ["surface.report_shell_state", "notification.create_for_target"]);
  const diagnostics = await client.getDiagnostics();
  assert.equal(diagnostics.transport, "relay");
  assert.deepEqual(diagnostics.supportedCommands, []);
});

test("failed capability probes recover at the same executable path", async (t) => {
  for (const throws of [false, true]) {
    await t.test(throws ? "thrown probe" : "nonzero exit", async () => {
      let probes = 0;
      let logs = 0;
      const client = new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner: async (_command, args) => {
        if (args[0] === "--help" && ++probes === 1) {
          if (throws) throw new Error("temporary failure");
          return { exitCode: 1, stdout: "", stderr: "temporary failure" };
        }
        if (args[0] === "log") logs++;
        return { exitCode: 0, stdout: "Commands:\n  log Log\n", stderr: "" };
      } });
      await client.log("first");
      await client.log("second");
      await client.log("third");
      assert.equal(probes, 2);
      assert.equal(logs, 2);
    });
  }
});

test("failed status writes remain attempted because cmux may have accepted them", async () => {
  const client = new CmuxClient({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" }, exists: () => false,
    runner: async (_command, args) => args[0] === "--help"
      ? { exitCode: 0, stdout: "Commands:\n  set-status Set\n", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "connection lost after send" },
  });
  const target = await client.captureTarget();
  assert.equal(await client.setStatus("owner", "working", {}, target), "attempted");
  assert.equal(await client.setStatus("owner", "working", {}, {}), "skipped");
});

test("cleanup reports command failure so its owner can retry", async () => {
  let succeeds = false;
  const client = new CmuxClient({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" }, exists: () => false,
    runner: async (_command, args) => args[0] === "--help"
      ? { exitCode: 0, stdout: "Commands:\n  clear-status Clear\n", stderr: "" }
      : { exitCode: succeeds ? 0 : 1, stdout: "", stderr: "" },
  });
  assert.equal(await client.reportShellState("prompt"), false);
  assert.equal(await client.clearStatus("owner"), false);
  succeeds = true;
  assert.equal(await client.reportShellState("prompt"), true);
  assert.equal(await client.clearStatus("owner"), true);
});

test("concurrent optional calls share one pending capability probe", async () => {
  let probes = 0;
  let unblock!: () => void;
  let started!: () => void;
  const probeStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const client = new CmuxClient({ env: { CMUX_WORKSPACE_ID: "workspace:1" }, exists: () => false, runner: async (_command, args) => {
    if (args[0] === "--help") { probes++; started(); await blocked; }
    return { exitCode: 0, stdout: "Commands:\n  log Log\n", stderr: "" };
  } });
  const first = client.log("one");
  const second = client.log("two");
  await probeStarted;
  unblock();
  await Promise.all([first, second]);
  assert.equal(probes, 1);
});

test("cancelled completion does not send after a slow tmux lookup", async () => {
  let started!: () => void;
  let release!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const controller = new AbortController();
  const client = new CmuxClient({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1", TMUX_PANE: "%1" }, exists: () => false,
    runner: async (command, args, options) => {
      if (command === "tmux") { started(); await blocked; }
      else { calls.push(args[0]); assert.equal(options?.signal, controller.signal); }
      return { exitCode: 0, stdout: "pane:1", stderr: "" };
    },
  });
  const target = await client.captureTarget();
  const pending = client.notify({ title: "Done" }, target, controller.signal);
  await lookupStarted;
  controller.abort();
  release();
  await pending;
  assert.deepEqual(calls, []);
});

test("diagnostics keep bounded failure metadata without credentials or message contents", async () => {
  const client = new CmuxClient({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1", CMUX_SOCKET_PASSWORD: "secret-password", CMUX_SOCKET_CAPABILITY: "secret-capability" },
    exists: () => false,
    runner: async () => ({ exitCode: 7, stdout: "private stdout", stderr: "secret-password secret-capability private stderr" }),
  });
  for (let i = 0; i < 7; i++) await client.notify({ title: "private title", body: "private body" });
  const diagnostics = await client.getDiagnostics();
  assert.equal(diagnostics.supportedCommands, null);
  assert.equal(diagnostics.recentFailures.length, 5);
  assert.deepEqual(diagnostics.recentFailures.at(-1), { operation: "--help", exitCode: 7 });
  assert.ok(!/secret|private/.test(JSON.stringify(diagnostics)));
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
