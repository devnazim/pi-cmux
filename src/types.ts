export type PiCmuxLogLevel = "info" | "success" | "warning" | "error" | "warn";

export interface PiCmuxNotification {
  title: string;
  subtitle?: string;
  body?: string;
  source?: string;
  type?: string;
  level?: PiCmuxLogLevel;
  notify?: boolean;
  log?: boolean;
  status?:
    | {
        action?: "set";
        key?: string;
        text: string;
        icon?: string;
        color?: string;
      }
    | {
        action: "clear";
        key?: string;
      };
}

export interface PiCmuxConfig {
  notifications: {
    done: boolean;
    error: boolean;
    xplan: boolean;
  };
  status: boolean;
  logs: boolean;
}

export type PiCmuxNotifier = (notification: PiCmuxNotification) => void | Promise<void>;

export const PI_CMUX_NOTIFY_SYMBOL = Symbol.for("pi.cmux.notify.v1");
