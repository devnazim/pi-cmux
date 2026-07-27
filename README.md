# pi-cmux

cmux notifications and status integration for [pi](https://pi.dev).

`pi-cmux` is a standalone pi extension/package. It sends generic pi lifecycle updates to cmux and exposes an optional in-process notifier API that other pi extensions can use for semantic notifications.

Package name: `@devnazim/pi-cmux`.

Compatibility: `pi-cmux` requires Pi 0.80.4 or newer and is tested against Pi 0.82.1. It uses the `agent_settled` lifecycle event so retries, compaction, and queued continuations do not trigger premature completion notifications.

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
| Agent starts | mark the active cmux surface as running (`surface.report_shell_state`) |
| Agent run ends with queued messages | keep/report the active surface as running |
| Agent fully settles | desktop notification (including session name when set) + mark surface as prompt/idle |
| Session shuts down/reloads | mark surface as prompt/idle |
| Optional extension notification | popup/status/log best-effort, controlled by the caller |

All cmux calls are best-effort. If cmux is unavailable or a command fails, pi continues normally.

## cmux, SSH, and tmux behavior

`pi-cmux` detects cmux with:

- `CMUX_WORKSPACE_ID`
- `CMUX_TAB_ID`
- any non-empty `CMUX_SOCKET_PATH` (including remote relay values like `127.0.0.1:<port>`)
- `/tmp/cmux.sock` as a final fallback

It resolves the cmux CLI with `CMUX_BUNDLED_CLI_PATH`, falling back to `cmux` on `PATH`.

For SSH/tmux/surface-aware notifications, it targets the active cmux surface by preferring explicit env vars:

- `CMUX_SURFACE_ID`
- `CMUX_PANEL_ID`

If neither is present but `CMUX_WORKSPACE_ID` or `CMUX_TAB_ID` exists, `pi-cmux` asks cmux for that workspace's surfaces with `surface.list` and chooses the focused surface, then the selected surface, then the first surface.

When a surface is available, notifications use:

```text
cmux rpc notification.create_for_surface '{"surface_id":"...","title":"..."}'
```

Otherwise they fall back to:

```text
cmux rpc notification.create '{"title":"..."}'
```

If `TMUX_PANE` is set, `pi-cmux` asks tmux for a readable pane label and prefixes notification bodies with it, e.g. `[dev:1 %2] Ready for input`. If tmux lookup fails, it falls back to the raw pane id.

When running inside tmux, `pi-cmux` also refreshes `CMUX_*` values from `tmux show-environment` before each cmux call. This helps after SSH relay reconnects, such as when a laptop sleeps and wakes with a new `CMUX_SOCKET_PATH` port. Existing processes cannot recover if tmux itself still has stale cmux environment values; in that case, start a new cmux/tmux pane or restart pi from a shell with fresh `CMUX_*` variables.

This avoids terminal OSC notifications and works through SSH/tmux when the cmux shell integration exposes the needed env/socket/CLI access in the remote environment. Without that cmux environment, the extension silently no-ops.

Current cmux builds expose notifications and surface shell-state RPCs, but may not expose older `set-status`, `clear-status`, or `log` CLI commands. `pi-cmux` uses the shell-state RPC for surface activity, probes `cmux --help` before calling optional legacy status/log commands, and keeps legacy status calls off the critical agent lifecycle path.

## Configuration

Create `~/.config/pi-cmux/config.json` or set `PI_CMUX_CONFIG` to another path.

```json
{
  "notifications": {
    "done": true,
    "error": true,
    "xplan": true
  },
  "status": true,
  "logs": true
}
```

| Option | Default | Description |
| --- | --- | --- |
| `notifications.done` | `true` | Show generic “Pi done” notifications. |
| `notifications.error` | `true` | Allow error-level popup notifications from optional callers. |
| `notifications.xplan` | `true` | Allow popup notifications from `source: "xplan"`. |
| `status` | `true` | Report active cmux surface activity, or use supported legacy status commands when available. |
| `logs` | `true` | Write cmux log entries when the installed cmux CLI exposes `cmux log`; otherwise no-op. |

Malformed or omitted values fall back to defaults.

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
- `status` — optional keyed status set/clear request; used only when the installed cmux CLI supports legacy status commands

## Development

```bash
npm install
npm test
npm run check
```

The implementation no-ops outside cmux, targets notifications and shell-state reports to the active surface when possible, waits for Pi's fully settled lifecycle state, infers SSH/tmux surfaces with `surface.list`, adds tmux pane labels and pi session names for disambiguation, probes optional legacy commands before using them, keeps legacy status calls best-effort in the background, and executes commands without shell interpolation.
