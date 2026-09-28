# pi-cmux

cmux notifications and status integration for [pi](https://pi.dev).

`pi-cmux` is a standalone pi extension/package. It sends generic pi lifecycle updates to cmux and exposes an optional in-process notifier API that other pi extensions can use for semantic notifications.

Package name: `@devnazim/pi-cmux`. See [release notes](CHANGELOG.md).

Compatibility: `pi-cmux` requires Pi 0.80.4 or newer and is tested against Pi 0.87.1. Its cmux integration is checked against the [v0.64.25 CLI/RPC contract](https://github.com/manaflow-ai/cmux/releases/tag/v0.64.25). It uses the `agent_settled` lifecycle event so retries, compaction, and queued continuations do not trigger premature completion notifications. Input-wait alerts require Pi 0.84.4 or newer, which provides the UI prompt events.

Current cmux releases also provide a first-party Pi extension through `cmux hooks pi install` and `cmux hooks setup`. Set `"lifecycle": false` in this package's configuration when using the first-party hook. This keeps the cross-extension notifier API and `/cmux-status` without competing automatic activity or notification updates. Otherwise, enabling both lifecycle integrations can produce duplicate completion notifications.

## Install

From npm:

```bash
pi install npm:@devnazim/pi-cmux
```

From a local checkout:

```bash
pi install /path/to/pi-cmux
```

Or try without installing:

```bash
pi -e /path/to/pi-cmux
```

## What it does

| pi event | cmux action |
| --- | --- |
| Agent starts | report the cmux workspace/surface as running (`surface.report_shell_state`) |
| Agent run ends with queued messages | keep/report the workspace/surface as running |
| Agent settles successfully | completion notification with session name + report prompt/idle |
| Agent settles after failure | error notification + error log + report prompt/idle |
| Agent settles after cancellation | report prompt/idle without a completion popup |
| Blocking Pi UI prompt opens | at most one "Pi needs input" popup per observed waiting episode |
| Blocking Pi UI prompt closes | cancel any pending input-wait popup |
| Session shuts down/reloads | discard queued deliveries and clear owned activity/status |
| Optional extension notification | popup/status/log best-effort, controlled by the caller |

All cmux calls are best-effort. Lifecycle handlers enqueue delivery without waiting for cmux, so a slow CLI does not delay agent startup or settlement. The queue preserves report order. A new run cancels obsolete completion delivery. Shutdown waits for in-flight delivery and owned cleanup, but discards pending notifications. Failed cleanup remains owned so shutdown can retry it. Each subprocess has a three-second timeout.

Each Pi session uses its own sidebar status key, registered with its local process PID and captured panel. Finishing one session does not clear another session's sidebar entry. cmux can remove owned entries after the process exits or the panel closes. Failed clears from retired sessions remain in a process-local retry list across extension reloads and retry on later session/start events.

Aborted runs do not generate success popups; failed runs use `notifications.error`, independently of `notifications.done`. Automatic completion and input-wait popups are disabled outside TUI mode unless `notifications.headless` is enabled. Activity reporting and logs are unaffected by this popup guard.

Input-wait alerts cover blocking `ctx.ui` dialogs, not assistant text asking a question. They use a generic body, without dialog titles, contents, or answers. Closing a prompt cancels a queued or in-flight delivery where possible; an already-delivered desktop notification cannot be withdrawn. Alerts follow Pi's delivered prompt events. Delayed handlers in other extensions can cause separate waiting episodes to be grouped together.

## cmux, SSH, and tmux behavior

`pi-cmux` detects cmux with:

- `CMUX_WORKSPACE_ID` or compatibility `CMUX_TAB_ID`
- `CMUX_SURFACE_ID` or compatibility `CMUX_PANEL_ID`
- any non-empty `CMUX_SOCKET_PATH` (including remote relay values like `127.0.0.1:<port>`)
- deprecated `CMUX_SOCKET` as a compatibility signal
- the current `~/.local/state/cmux/cmux.sock` path and cmux's user-scoped socket variants, then legacy `/tmp/cmux.sock`, as filesystem fallbacks

It resolves an executable cmux CLI from `CMUX_BUNDLED_CLI_PATH`, falling back to `cmux` on `PATH`.

For SSH/tmux/surface-aware notifications, it targets the active cmux surface by preferring explicit env vars:

- `CMUX_SURFACE_ID`
- `CMUX_PANEL_ID`

If neither is present but `CMUX_WORKSPACE_ID` or `CMUX_TAB_ID` exists, `pi-cmux` asks cmux for that workspace's surfaces with `surface.list` and chooses the focused surface, then the selected-in-pane surface, then the first surface.

Lifecycle delivery captures this target once per Pi session. Once a surface is resolved, later focus changes cannot send the completion to another terminal or leave the original terminal marked busy. Connection details still refresh before every call. A changed workspace does not silently replace the captured target. If the initial lookup cannot resolve a surface, lifecycle shell-state reports and popups are skipped instead of falling back to current focus. If cmux no longer accepts a captured target, delivery remains best-effort; reload Pi to resolve a new one. The optional notifier API resolves its target for each request.

Notifications use the relay-compatible scoped RPC:

```text
cmux rpc notification.create '{"workspace_id":"...","surface_id":"...","title":"..."}'
```

`workspace_id` and `surface_id` are included when known. With no surface, the workspace scope is retained; with no routing context, local cmux resolves the notification from caller/focus context. Restricted remote relays require a valid workspace ID for notifications, but accept workspace-only popups when the surface cannot be resolved. `pi-cmux` does not use `notification.create_for_surface`, because current cmux documents that method as local-only and not relay-reachable.

If `TMUX_PANE` is set, `pi-cmux` asks tmux for a readable pane label and prefixes notification bodies with it, e.g. `[dev:1 %2] Ready for input`. If tmux lookup fails, it falls back to the raw pane id.

When running inside tmux, `pi-cmux` also refreshes cmux's managed shared environment values from `tmux show-environment` before each cmux call. It does not import socket passwords/capabilities or stale surface IDs from tmux; those remain process-scoped, and the active surface is resolved from the refreshed workspace. This helps after SSH relay reconnects, such as when a laptop sleeps and wakes with a new `CMUX_SOCKET_PATH` port. Existing processes cannot recover if tmux itself still has stale shared cmux environment values; in that case, start a new cmux/tmux pane or restart pi from a shell with fresh `CMUX_*` variables.

This avoids terminal OSC notifications and works through SSH/tmux when the cmux shell integration exposes the needed env/socket/CLI access in the remote environment. Without that cmux environment, the extension silently no-ops.

Current cmux builds expose notification and shell-state RPCs as well as the top-level `set-status`, `clear-status`, and `log` commands. `pi-cmux` uses the shell-state RPC for lifecycle activity with the captured surface ID. Reports include `CMUX_TERMINAL_LIFECYCLE_ID` only when both the surface and lifecycle ID still match the explicit runtime environment. Inferred surfaces, including those resolved after tmux refresh, omit it because the lifecycle ID may belong to another terminal. Local connections probe `cmux --help` before optional sidebar status/log calls. Successful probes are cached per executable; failed probes retry on a later call. Restricted remote relays do not accept the legacy sidebar protocol, so the extension skips `set-status`, `clear-status`, and `log` on those transports. Notification and shell-state RPCs remain available.

## Configuration

Create `~/.config/pi-cmux/config.json` or set `PI_CMUX_CONFIG` to another path.

```json
{
  "lifecycle": true,
  "notifications": {
    "done": true,
    "error": true,
    "xplan": true,
    "input": true,
    "headless": false
  },
  "status": true,
  "logs": true
}
```

| Option | Default | Description |
| --- | --- | --- |
| `lifecycle` | `true` | Enable automatic activity, completion, and input-wait integration. Set `false` for notifier-only mode. |
| `notifications.done` | `true` | Show successful-run "Pi done" notifications. |
| `notifications.error` | `true` | Show failed-run notifications and allow error-level popups from optional callers. |
| `notifications.xplan` | `true` | Allow popup notifications from `source: "xplan"`. |
| `notifications.input` | `true` | Show automatic popups for blocking Pi UI prompts. |
| `notifications.headless` | `false` | Allow automatic completion and input-wait popups outside TUI mode. |
| `status` | `true` | Report cmux workspace/surface activity, and allow supported optional status commands. |
| `logs` | `true` | Write cmux log entries when the local CLI exposes `cmux log`; skip restricted relays. |

Malformed or omitted values fall back to defaults. Reload Pi after changing the file. These options do not change or install cmux's own hooks.

With `lifecycle: false`, explicit notifier requests still follow `status`, `logs`, and the relevant notification filters. Explicit requests are not blocked by `notifications.headless`; callers control whether to send them. Cleanup already owed by retired sessions can still retry.

## Diagnostics

Run `/cmux-status` in Pi to inspect detection, CLI path, local or relay transport, workspace/surface target, optional command support, configuration, and pending retired-status cleanup count. It also shows up to five recent cmux failures as operation names and exit codes. Failed capability probes appear as `null`; unsupported commands appear as an empty list.

The command does not send a desktop notification. It excludes credentials, notification contents, and raw subprocess output. It does not enable cmux's first-party hooks or change configuration.

## Optional notifier API

Other extensions can request cmux notifications without importing or depending on `pi-cmux`:

```ts
const notify = (globalThis as any)[Symbol.for("pi.cmux.notify.v1")];

if (typeof notify === "function") {
  await notify({
    source: "xplan",
    type: "step_ready",
    title: "xplan step ready",
    body: "S2 is ready for review",
    level: "success",
    status: { key: "xplan", text: "review", icon: "check", color: "#22c55e" },
  });
}
```

If `pi-cmux` is not installed, the symbol is absent. Callers should treat notifications as optional and never require them for workflow state.

Supported payload fields:

- `title` — required notification title
- `subtitle`, `body` — optional body parts, joined with ` — `
- `source` — log/status source, e.g. `xplan`
- `type` — caller-defined event type
- `level` — `info`, `success`, `warning`, `error`, or `warn`
- `notify: false` — skip popup notification
- `log: false` — skip cmux log entry
- `status` — optional keyed status set/clear request; used only when the installed cmux CLI supports those commands

## Development

```bash
npm install
npm test
npm run check
```

The implementation no-ops outside cmux, scopes relay-safe notifications and shell-state reports to the active workspace/surface when possible, waits for Pi's fully settled lifecycle state, infers SSH/tmux surfaces with `surface.list`, adds tmux pane labels and Pi session names for disambiguation, probes optional commands before using them, keeps sidebar status calls best-effort in the background, and executes commands without shell interpolation.
