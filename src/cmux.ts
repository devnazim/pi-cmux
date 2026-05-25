import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import type { PiCmuxLogLevel } from "./types.js";

export type CmuxEnv = Record<string, string | undefined>;
export type ExistsFn = (path: string) => boolean;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export interface CmuxNotificationInput {
  title: string;
  subtitle?: string;
  body?: string;
}

export interface CmuxStatusOptions {
  icon?: string;
  color?: string;
}

export interface CmuxLogOptions {
  level?: PiCmuxLogLevel;
  source?: string;
}

export type CmuxShellState = "prompt" | "running" | "unknown";

const DEFAULT_CMUX_SOCKET_PATH = "/tmp/cmux.sock";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isInCmuxEnv(env: CmuxEnv = process.env, exists: ExistsFn = existsSync): boolean {
  if (nonEmpty(env.CMUX_WORKSPACE_ID)) return true;
  if (nonEmpty(env.CMUX_TAB_ID)) return true;
  if (nonEmpty(env.CMUX_SOCKET_PATH)) return true;
  return exists(DEFAULT_CMUX_SOCKET_PATH);
}

export function resolveCmuxCli(env: CmuxEnv = process.env, exists: ExistsFn = existsSync): string {
  const bundled = nonEmpty(env.CMUX_BUNDLED_CLI_PATH);
  if (bundled && exists(bundled)) return bundled;
  return "cmux";
}

export function getWorkspaceId(env: CmuxEnv = process.env): string | undefined {
  return nonEmpty(env.CMUX_WORKSPACE_ID) ?? nonEmpty(env.CMUX_TAB_ID);
}

export function getSurfaceId(env: CmuxEnv = process.env): string | undefined {
  return nonEmpty(env.CMUX_SURFACE_ID) ?? nonEmpty(env.CMUX_PANEL_ID);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function surfaceListEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  for (const key of ["surfaces", "data", "items"]) {
    const entries = value[key];
    if (Array.isArray(entries)) return entries;
  }

  return [];
}

export function pickBestSurfaceId(surfaceList: unknown): string | undefined {
  const surfaces = surfaceListEntries(surfaceList)
    .filter(isRecord)
    .map((surface) => ({ id: nonEmpty(typeof surface.id === "string" ? surface.id : undefined), focused: surface.focused, selected: surface.selected }))
    .filter((surface): surface is { id: string; focused: unknown; selected: unknown } => surface.id !== undefined);

  return (
    surfaces.find((surface) => surface.focused === true)?.id ??
    surfaces.find((surface) => surface.selected === true)?.id ??
    surfaces[0]?.id
  );
}

export function parseSurfaceListOutput(output: string): string | undefined {
  return pickBestSurfaceId(JSON.parse(output));
}

export function buildSurfaceListArgs(workspaceId: string): string[] {
  return ["rpc", "surface.list", JSON.stringify({ workspace_id: workspaceId })];
}

export function normalizeLogLevel(level: PiCmuxLogLevel | undefined): string | undefined {
  return level === "warn" ? "warning" : level;
}

export function formatNotificationBody(input: Pick<CmuxNotificationInput, "subtitle" | "body">, paneLabel = ""): string | undefined {
  const bodyParts = [input.subtitle, input.body].filter((part): part is string => part !== undefined && part.trim() !== "");
  const baseBody = bodyParts.join(" — ");
  if (!paneLabel) return baseBody || undefined;
  return baseBody ? `${paneLabel} ${baseBody}` : paneLabel;
}

export function buildNotificationArgs(
  input: CmuxNotificationInput,
  env: CmuxEnv = process.env,
  paneLabel = "",
  resolvedSurfaceId = getSurfaceId(env),
): string[] {
  const body = formatNotificationBody(input, paneLabel);
  const payload: { title: string; body?: string; surface_id?: string } = { title: input.title };
  if (body) payload.body = body;

  if (resolvedSurfaceId) {
    payload.surface_id = resolvedSurfaceId;
    return ["rpc", "notification.create_for_surface", JSON.stringify(payload)];
  }

  return ["rpc", "notification.create", JSON.stringify(payload)];
}

export function buildSetStatusArgs(key: string, text: string, options: CmuxStatusOptions = {}): string[] {
  const args = ["set-status", key, text];
  if (options.icon !== undefined) args.push("--icon", options.icon);
  if (options.color !== undefined) args.push("--color", options.color);
  return args;
}

export function buildClearStatusArgs(key: string): string[] {
  return ["clear-status", key];
}

export function buildReportShellStateArgs(
  state: CmuxShellState,
  env: CmuxEnv = process.env,
  resolvedSurfaceId = getSurfaceId(env),
): string[] | undefined {
  const workspaceId = getWorkspaceId(env);
  if (!workspaceId || !resolvedSurfaceId) return undefined;

  return [
    "rpc",
    "surface.report_shell_state",
    JSON.stringify({ workspace_id: workspaceId, surface_id: resolvedSurfaceId, state }),
  ];
}

export function buildLogArgs(message: string, options: CmuxLogOptions = {}): string[] {
  const args = ["log"];
  const level = normalizeLogLevel(options.level);
  if (level !== undefined) args.push("--level", level);
  if (options.source !== undefined) args.push("--source", options.source);
  args.push("--", message);
  return args;
}

export const execFileRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 3_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const maybeCode = (error as NodeJS.ErrnoException | null)?.code;
      resolve({
        exitCode: typeof maybeCode === "number" ? maybeCode : error ? 1 : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });

export async function resolveCmuxSurfaceId(
  env: CmuxEnv = process.env,
  exists: ExistsFn = existsSync,
  runner: CommandRunner = execFileRunner,
): Promise<string | undefined> {
  const explicitSurfaceId = getSurfaceId(env);
  if (explicitSurfaceId) return explicitSurfaceId;

  const workspaceId = getWorkspaceId(env);
  if (!workspaceId) return undefined;

  try {
    const result = await runner(resolveCmuxCli(env, exists), buildSurfaceListArgs(workspaceId));
    if (result.exitCode !== 0) return undefined;
    return parseSurfaceListOutput(result.stdout);
  } catch {
    return undefined;
  }
}

export async function getTmuxPaneLabel(env: CmuxEnv = process.env, runner: CommandRunner = execFileRunner): Promise<string> {
  const pane = nonEmpty(env.TMUX_PANE);
  if (!pane) return "";

  try {
    const result = await runner("tmux", ["display-message", "-p", "-t", pane, "-F", "#{session_name}:#{window_index} #{pane_id}"]);
    if (result.exitCode === 0) {
      const text = result.stdout.trim();
      if (text) return `[${text}]`;
    }
  } catch {
    // Fall back to the raw pane id below.
  }

  return `[${pane}]`;
}

export class CmuxClient {
  private supportedCommandsPromise?: Promise<Set<string>>;
  private legacyStatusQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      env?: CmuxEnv;
      exists?: ExistsFn;
      runner?: CommandRunner;
    } = {},
  ) {}

  isAvailable(): boolean {
    return isInCmuxEnv(this.env, this.exists);
  }

  async notify(input: CmuxNotificationInput): Promise<void> {
    if (!this.isAvailable()) return;
    const paneLabel = await getTmuxPaneLabel(this.env, this.runner);
    const surfaceId = await this.resolveSurfaceId();
    await this.run(buildNotificationArgs(input, this.env, paneLabel, surfaceId));
  }

  async reportShellState(state: CmuxShellState): Promise<void> {
    if (!this.isAvailable()) return;
    const surfaceId = await this.resolveSurfaceId();
    const args = buildReportShellStateArgs(state, this.env, surfaceId);
    if (args) await this.run(args);
  }

  async setStatus(key: string, text: string, options?: CmuxStatusOptions): Promise<void> {
    await this.enqueueLegacyStatus(async () => {
      if (await this.supportsCliCommand("set-status")) {
        await this.run(buildSetStatusArgs(key, text, options));
      }
    });
  }

  async clearStatus(key: string): Promise<void> {
    await this.enqueueLegacyStatus(async () => {
      if (await this.supportsCliCommand("clear-status")) {
        await this.run(buildClearStatusArgs(key));
      }
    });
  }

  async log(message: string, options?: CmuxLogOptions): Promise<void> {
    if (await this.supportsCliCommand("log")) {
      await this.run(buildLogArgs(message, options));
    }
  }

  private get env(): CmuxEnv {
    return this.options.env ?? process.env;
  }

  private get exists(): ExistsFn {
    return this.options.exists ?? existsSync;
  }

  private get runner(): CommandRunner {
    return this.options.runner ?? execFileRunner;
  }

  private enqueueLegacyStatus(task: () => Promise<void>): Promise<void> {
    const next = this.legacyStatusQueue.then(task, task);
    this.legacyStatusQueue = next.catch(() => {
      // Legacy status is best-effort; keep the queue alive after failures.
    });
    return this.legacyStatusQueue;
  }

  private async supportsCliCommand(commandName: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      const commands = await this.getSupportedCliCommands();
      return commands.has(commandName);
    } catch {
      return false;
    }
  }

  private getSupportedCliCommands(): Promise<Set<string>> {
    this.supportedCommandsPromise ??= this.readSupportedCliCommands();
    return this.supportedCommandsPromise;
  }

  private async resolveSurfaceId(): Promise<string | undefined> {
    return resolveCmuxSurfaceId(this.env, this.exists, this.runner);
  }

  private async readSupportedCliCommands(): Promise<Set<string>> {
    const commands = new Set<string>();

    try {
      const result = await this.runner(resolveCmuxCli(this.env, this.exists), ["--help"]);
      const output = `${result.stdout}\n${result.stderr}`;
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s{2}([a-z][\w-]*)\b/);
        if (match) commands.add(match[1]);
      }
    } catch {
      // Unknown/old cmux CLI shape; treat optional commands as unsupported.
    }

    return commands;
  }

  private async run(args: string[]): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await this.runner(resolveCmuxCli(this.env, this.exists), args);
    } catch {
      // cmux is best-effort; never let notification failures affect pi.
    }
  }
}
