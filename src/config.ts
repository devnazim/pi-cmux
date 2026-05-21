import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PiCmuxConfig } from "./types.js";

export const DEFAULT_CONFIG: PiCmuxConfig = {
  notifications: {
    done: true,
    error: true,
    xplan: true,
  },
  status: true,
  logs: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_CMUX_CONFIG?.trim()) return env.PI_CMUX_CONFIG.trim();
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "pi-cmux", "config.json");
}

export function normalizeConfig(input: unknown): PiCmuxConfig {
  if (!isRecord(input)) return structuredClone(DEFAULT_CONFIG);

  const notifications = isRecord(input.notifications) ? input.notifications : {};
  return {
    notifications: {
      done: booleanOrDefault(notifications.done, DEFAULT_CONFIG.notifications.done),
      error: booleanOrDefault(notifications.error, DEFAULT_CONFIG.notifications.error),
      xplan: booleanOrDefault(notifications.xplan, DEFAULT_CONFIG.notifications.xplan),
    },
    status: booleanOrDefault(input.status, DEFAULT_CONFIG.status),
    logs: booleanOrDefault(input.logs, DEFAULT_CONFIG.logs),
  };
}

export function loadConfig(path = defaultConfigPath()): PiCmuxConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
