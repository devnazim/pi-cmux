# Changelog

## 0.2.2

### Compatibility

- Updated the Pi development dependency to 1.0.0 and Node 24 types to 24.19.1.
- Tested against Pi 1.0.0. The minimum supported Pi version remains 0.80.4.
- Added an offline compatibility test using Pi's real extension loader and event runner for lifecycle notifications, input prompts, and shutdown.

## 0.2.1

### Fixed

- Resolve missing relay surface IDs with workspace-scoped `surface.current` instead of `surface.list`. Reject failed, malformed, mismatched, or non-terminal results rather than moving lifecycle delivery to current focus.
- Keep captured relay targets pinned across focus, workspace, and relay-port changes without attaching unrelated terminal lifecycle IDs.

## 0.2.0

### Upgrade notes

- Automatic completion popups are now disabled outside TUI mode. Set `notifications.headless` to `true` to enable them for print, JSON, RPC, or SDK sessions. Explicit cross-extension notifier requests remain caller-controlled.
- Blocking Pi UI prompts now produce generic "Pi needs input" alerts by default. Set `notifications.input` to `false` to disable them. This feature requires Pi 0.84.4 or newer.
- Set `lifecycle` to `false` when using cmux's first-party Pi hook. The optional notifier API and `/cmux-status` remain available without duplicate automatic updates.
- Lifecycle delivery now requires a resolved surface and retains it for the Pi session. Missing or stale targets no longer fall back to whichever terminal has focus. Reload Pi to resolve a new target.

### Added

- `/cmux-status` diagnostics for routing, command support, recent failure metadata, configuration, and pending status cleanup. Credentials and notification contents are excluded.
- PID/panel ownership for session-specific sidebar status keys, plus cleanup retries that survive extension reloads.
- Cancellable input-wait alerts with handling for overlapping and reordered Pi prompt events.

### Fixed

- Keep completion notifications and activity cleanup on the same surface when tmux focus changes.
- Prevent one Pi session from clearing another session's sidebar status.
- Suppress success popups for cancelled runs and classify failed runs as errors.
- Run lifecycle delivery through an ordered background queue instead of delaying agent startup or settlement. Cancel obsolete completion delivery when a new run starts.
- Retry failed capability probes and retain cleanup ownership after uncertain writes or failed clears. Skipped writes do not create cleanup entries.
- Skip unsupported legacy sidebar commands on restricted remote relays while retaining notification and shell-state RPCs.
- Match cmux's relay endpoint parser and avoid attaching unrelated terminal lifecycle IDs to inferred surfaces.

### Compatibility

- Requires Pi 0.80.4 or newer; tested against Pi 0.87.1.
- Checked against the cmux v0.64.25 CLI/RPC source contract.
- Updated development dependencies to Pi 0.87.1, TypeScript 7.0.2, tsx 4.23.15, and Node 24.19.0 types.
- Pi can deliver UI prompt events out of order when other extensions delay handlers. Separate waiting episodes may be grouped together; prompt alerts remain best-effort.
