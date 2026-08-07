import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CmuxClient } from "./cmux.js";
import { loadConfig } from "./config.js";
import { PI_CMUX_NOTIFY_SYMBOL, type PiCmuxNotification, type PiCmuxNotifier } from "./types.js";

const STATUS_KEY = "pi";
const STATUS_WORKING = { icon: "terminal", color: "#f59e0b" };
const STATUS_QUEUED = { icon: "clock", color: "#3b82f6" };

type CmuxGlobal = { [key: symbol]: PiCmuxNotifier | undefined };
type NotificationCmuxClient = Pick<CmuxClient, "setStatus" | "clearStatus" | "notify" | "log">;
type PiCmuxClient = NotificationCmuxClient & Pick<CmuxClient, "reportShellState">;

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

function background(promise: Promise<unknown>): void {
  void promise.catch(() => {
    // cmux integration is best-effort and must not affect pi.
  });
}

export function formatDoneTitle(sessionName: string | undefined): string {
  const name = sessionName?.trim();
  return name ? `Pi done: ${name}` : "Pi done";
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

  const tasks: Array<Promise<void>> = [];

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
): void {
  const cmuxGlobal = globalThis as unknown as CmuxGlobal;

  async function setPiStatus(text: string, options: typeof STATUS_WORKING, completion: "await" | "background" = "background"): Promise<void> {
    await cmux.reportShellState("running");
    const status = cmux.setStatus(STATUS_KEY, text, options);
    if (completion === "await") await status;
    else background(status);
  }

  async function clearPiStatus(completion: "await" | "background" = "background"): Promise<void> {
    await cmux.reportShellState("prompt");
    const clear = cmux.clearStatus(STATUS_KEY);
    if (completion === "await") await clear;
    else background(clear);
  }

  function doneTitle(): string {
    return formatDoneTitle(pi.getSessionName());
  }

  const notifier: PiCmuxNotifier = async (notification) => {
    try {
      if (isNotification(notification)) await handlePiCmuxNotification(notification, config, cmux);
    } catch {
      // Optional cross-extension notifications must never affect callers.
    }
  };

  cmuxGlobal[PI_CMUX_NOTIFY_SYMBOL] = notifier;

  pi.on("agent_start", async () => {
    if (config.status) await setPiStatus("working", STATUS_WORKING);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.hasPendingMessages() && config.status) {
      await setPiStatus("queued", STATUS_QUEUED);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;

    const title = doneTitle();
    const tasks: Array<Promise<void>> = [];
    if (config.notifications.done) {
      tasks.push(cmux.notify({ title, body: "Ready for input" }));
    }
    if (config.logs) {
      tasks.push(cmux.log(`${title}: ready for input`, { level: "success", source: "pi" }));
    }
    if (config.status) tasks.push(clearPiStatus());
    await Promise.all(tasks);
  });

  pi.on("session_shutdown", async () => {
    if (cmuxGlobal[PI_CMUX_NOTIFY_SYMBOL] === notifier) delete cmuxGlobal[PI_CMUX_NOTIFY_SYMBOL];
    if (config.status) await clearPiStatus("await");
  });
}

export default function piCmuxExtension(pi: ExtensionAPI): void {
  registerPiCmuxExtension(pi, loadConfig(), new CmuxClient());
}
