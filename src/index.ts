import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CmuxClient, type CmuxTarget } from "./cmux.js";
import { loadConfig } from "./config.js";
import { PI_CMUX_NOTIFY_SYMBOL, type PiCmuxNotification, type PiCmuxNotifier } from "./types.js";

const STATUS_WORKING = { icon: "terminal", color: "#f59e0b" };
const STATUS_QUEUED = { icon: "clock", color: "#3b82f6" };

const STATUS_CLEANUP_SYMBOL = Symbol.for("pi.cmux.status-cleanup.v1");
type CmuxGlobal = {
  [PI_CMUX_NOTIFY_SYMBOL]?: PiCmuxNotifier;
  [STATUS_CLEANUP_SYMBOL]?: Map<string, CmuxTarget>;
};
type NotificationCmuxClient = Pick<CmuxClient, "setStatus" | "clearStatus" | "notify" | "log">;
type PiCmuxClient = NotificationCmuxClient & Pick<CmuxClient, "reportShellState" | "captureTarget" | "getDiagnostics">;
type CompletionOutcome = "success" | "error" | "aborted" | "unknown";

interface SessionState {
  statusKey: string;
  target?: Promise<CmuxTarget>;
  completionDelivery?: AbortController;
  inputDelivery?: AbortController;
  promptBalance: number;
  active: boolean;
  generation: number;
  closed: boolean;
  shellReported: boolean;
  statusWritten: boolean;
  outcome: CompletionOutcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotification(value: unknown): value is PiCmuxNotification {
  return isRecord(value) && typeof value.title === "string" && value.title.trim() !== "";
}

function notificationLogMessage(notification: PiCmuxNotification): string {
  const parts = [notification.subtitle, notification.body].filter((part): part is string => part !== undefined && part.trim() !== "");
  return parts.length > 0 ? `${notification.title}: ${parts.join(" — ")}` : notification.title;
}

function shouldShowPopup(notification: PiCmuxNotification, config: ReturnType<typeof loadConfig>): boolean {
  if (notification.notify === false) return false;
  if (notification.source === "xplan" && !config.notifications.xplan) return false;
  if (notification.level === "error" && !config.notifications.error) return false;
  return true;
}

export function formatDoneTitle(sessionName: string | undefined): string {
  const name = sessionName?.trim();
  return name ? `Pi done: ${name}` : "Pi done";
}

export function completionOutcome(messages: readonly unknown[]): CompletionOutcome {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.cmuxSuppressNotification === true) return "aborted";
    if (message.stopReason === "error") return "error";
    if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") return "success";
    return "unknown";
  }
  return "unknown";
}

export async function handlePiCmuxNotification(
  notification: PiCmuxNotification,
  config: ReturnType<typeof loadConfig>,
  cmux: NotificationCmuxClient,
): Promise<void> {
  const source = notification.source ?? "pi";
  const statusKey = notification.status?.key ?? source;

  if (shouldShowPopup(notification, config)) {
    await cmux.notify({ title: notification.title, subtitle: notification.subtitle, body: notification.body });
  }

  const tasks: Array<Promise<unknown>> = [];

  if (config.status && notification.status) {
    if (notification.status.action === "clear") {
      tasks.push(cmux.clearStatus(statusKey));
    } else {
      tasks.push(
        cmux.setStatus(statusKey, notification.status.text, {
          icon: notification.status.icon,
          color: notification.status.color,
        }),
      );
    }
  }

  if (config.logs && notification.log !== false) {
    tasks.push(cmux.log(notificationLogMessage(notification), { level: notification.level ?? "info", source }));
  }

  await Promise.all(tasks);
}

export function registerPiCmuxExtension(
  pi: ExtensionAPI,
  config: ReturnType<typeof loadConfig>,
  cmux: PiCmuxClient,
): { flush(): Promise<void> } {
  const cmuxGlobal = globalThis as unknown as CmuxGlobal;
  // Plain targets survive extension reloads without retaining an old runtime.
  const pendingStatusCleanup = cmuxGlobal[STATUS_CLEANUP_SYMBOL] ??= new Map<string, CmuxTarget>();
  let queue: Promise<void> = Promise.resolve();

  function newSession(): SessionState {
    return {
      statusKey: `pi:${randomUUID()}`,
      promptBalance: 0,
      active: false,
      generation: 0,
      closed: false,
      shellReported: false,
      statusWritten: false,
      outcome: "unknown",
    };
  }

  let session = newSession();

  function targetFor(state: SessionState): Promise<CmuxTarget> {
    state.target ??= cmux.captureTarget();
    return state.target;
  }

  function enqueue(state: SessionState, task: () => Promise<void>): void {
    queue = queue.then(async () => {
      if (!state.closed) await task();
    }).catch(() => {
      // A failed delivery must not block Pi or subsequent deliveries.
    });
  }

  async function setPiStatus(state: SessionState, text: string, options: typeof STATUS_WORKING): Promise<void> {
    const target = await targetFor(state);
    if (state.closed) return;
    state.shellReported = true;
    await cmux.reportShellState("running", target);
    if (state.closed || !target.workspaceId || !target.surfaceId) return;
    const write = await cmux.setStatus(state.statusKey, text, options, target);
    if (write === "attempted") state.statusWritten = true;
  }

  async function clearPiStatus(state: SessionState): Promise<void> {
    if (!state.target) return;
    const target = await state.target;
    if (state.shellReported) {
      state.shellReported = !(await cmux.reportShellState("prompt", target));
    }
    if (state.statusWritten) {
      // Only retired keys enter the shared retry list. An active session may
      // write its key again, and another runtime must not clear that new write.
      if (state.closed) pendingStatusCleanup.set(state.statusKey, target);
      state.statusWritten = !(await cmux.clearStatus(state.statusKey, target));
      if (!state.statusWritten) pendingStatusCleanup.delete(state.statusKey);
    }
  }

  async function retryStatusCleanup(): Promise<void> {
    for (const [key, target] of [...pendingStatusCleanup]) {
      try {
        if (await cmux.clearStatus(key, target)) pendingStatusCleanup.delete(key);
      } catch {
        // Keep failed retired keys for the next session/start, including reloads.
      }
    }
  }

  function closeSession(state: SessionState): Promise<void> {
    if (!state.closed) {
      state.closed = true;
      state.completionDelivery?.abort();
      state.inputDelivery?.abort();
      // Drop queued deliveries. Finish only in-flight work and owned cleanup.
      queue = queue.then(() => clearPiStatus(state)).catch(() => {});
    }
    return queue;
  }

  const notifier: PiCmuxNotifier = async (notification) => {
    try {
      if (isNotification(notification)) await handlePiCmuxNotification(notification, config, cmux);
    } catch {
      // Optional cross-extension notifications must never affect callers.
    }
  };

  cmuxGlobal[PI_CMUX_NOTIFY_SYMBOL] = notifier;

  pi.registerCommand("cmux-status", {
    description: "Show cmux routing, capabilities, and recent delivery failures",
    handler: async (_args, ctx) => {
      const diagnostics = await cmux.getDiagnostics(session.target ? await session.target : undefined);
      ctx.ui.notify(JSON.stringify({
        ...diagnostics,
        statusKey: session.statusKey,
        active: session.active,
        pendingStatusCleanup: pendingStatusCleanup.size,
        lifecycle: config.lifecycle,
        notifications: config.notifications,
        status: config.status,
        logs: config.logs,
      }, null, 2), "info");
    },
  });

  pi.on("session_start", () => {
    void closeSession(session);
    session = newSession();
    enqueue(session, retryStatusCleanup);
    cmuxGlobal[PI_CMUX_NOTIFY_SYMBOL] = notifier;
  });

  pi.on("agent_start", () => {
    const state = session;
    if (state.closed || !config.lifecycle) return;
    state.completionDelivery?.abort();
    state.active = true;
    state.generation++;
    state.outcome = "unknown";
    enqueue(state, async () => {
      await retryStatusCleanup();
      if (state.closed) return;
      // Capture once per session even when activity reporting is disabled.
      await targetFor(state);
      if (config.status) await setPiStatus(state, "working", STATUS_WORKING);
    });
  });

  pi.on("agent_end", (event, ctx) => {
    const state = session;
    if (state.closed || !config.lifecycle) return;
    state.outcome = completionOutcome(event.messages);
    if (state.active && ctx.hasPendingMessages() && config.status) {
      enqueue(state, () => setPiStatus(state, "queued", STATUS_QUEUED));
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const state = session;
    if (!config.lifecycle || !state.active || !ctx.isIdle()) return;
    state.active = false;
    const outcome = state.outcome;
    const generation = state.generation;
    const allowPopup = ctx.mode === "tui" || config.notifications.headless;
    const delivery = new AbortController();
    state.completionDelivery = delivery;
    const name = pi.getSessionName()?.trim();
    const title = outcome === "success" ? formatDoneTitle(name) : `Pi ${outcome === "error" ? "error" : "cancelled"}${name ? `: ${name}` : ""}`;
    enqueue(state, async () => {
      const target = await targetFor(state);
      if (state.closed || state.generation !== generation) return;
      await clearPiStatus(state);
      if (state.closed || state.generation !== generation || outcome === "unknown") return;
      if (allowPopup && ((outcome === "success" && config.notifications.done) || (outcome === "error" && config.notifications.error))) {
        await cmux.notify({ title, body: outcome === "error" ? "Run failed. Check Pi for details." : "Ready for input" }, target, delivery.signal);
      }
      if (state.closed || state.generation !== generation) return;
      if (config.logs) {
        await cmux.log(`${title}: ${outcome === "success" ? "ready for input" : outcome === "error" ? "run failed" : "run cancelled"}`, {
          level: outcome === "success" ? "success" : outcome === "error" ? "error" : "info",
          source: "pi",
        }, target);
      }
    });
  });

  pi.on("ui_prompt_start", (_event, ctx) => {
    const state = session;
    if (state.closed) return;
    // Pi dispatches prompt events independently. An earlier async extension
    // can delay a start until after its end; preserve that unmatched end.
    state.promptBalance++;
    if (state.promptBalance !== 1 || !config.lifecycle || !config.notifications.input) return;
    if (ctx.mode !== "tui" && !config.notifications.headless) return;
    const delivery = new AbortController();
    state.inputDelivery = delivery;
    const name = pi.getSessionName()?.trim();
    enqueue(state, async () => {
      if (delivery.signal.aborted) return;
      const target = await targetFor(state);
      if (state.closed || delivery.signal.aborted) return;
      // Keep dialog titles, contents, and answers out of desktop notifications.
      await cmux.notify({ title: `Pi needs input${name ? `: ${name}` : ""}`, body: "Pi is waiting for your input." }, target, delivery.signal);
    });
  });

  pi.on("ui_prompt_end", () => {
    if (session.closed) return;
    session.promptBalance--;
    if (session.promptBalance <= 0) {
      session.inputDelivery?.abort();
      session.inputDelivery = undefined;
    }
  });

  pi.on("session_shutdown", async () => {
    if (cmuxGlobal[PI_CMUX_NOTIFY_SYMBOL] === notifier) delete cmuxGlobal[PI_CMUX_NOTIFY_SYMBOL];
    await closeSession(session);
  });

  return { flush: () => queue };
}

export default function piCmuxExtension(pi: ExtensionAPI): void {
  registerPiCmuxExtension(pi, loadConfig(), new CmuxClient());
}
