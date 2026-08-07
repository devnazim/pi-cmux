import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PiCmuxLogLevel } from "./types.js";

export type CmuxEnv = Record<string, string | undefined>;
export type ExistsFn = (path: string) => boolean;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  env?: CmuxEnv;
}

export type CommandRunner = (command: string, args: readonly string[], options?: CommandRunOptions) => Promise<CommandResult>;

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

const CMUX_STATE_DIRECTORY = join(homedir(), ".local", "state", "cmux");
const CURRENT_CMUX_SOCKET_PATH = join(CMUX_STATE_DIRECTORY, "cmux.sock");
const LEGACY_CMUX_SOCKET_PATH = "/tmp/cmux.sock";
const USER_ID = process.getuid?.();
const USER_SCOPED_CMUX_SOCKET_PATHS =
  USER_ID === undefined ? [] : [join(CMUX_STATE_DIRECTORY, `cmux-${USER_ID}.sock`), `/tmp/cmux-${USER_ID}.sock`];
const TMUX_SHARED_CMUX_ENV_KEYS = new Set([
  "CMUX_BUNDLED_CLI_PATH",
  "CMUX_BUNDLE_ID",
  "CMUXD_UNIX_PATH",
  "CMUXTERM_REPO_ROOT",
  "CMUX_DEBUG_LOG",
  "CMUX_LOAD_GHOSTTY_ZSH_INTEGRATION",
  "CMUX_PORT",
  "CMUX_PORT_END",
  "CMUX_PORT_RANGE",
  "CMUX_REMOTE_DAEMON_ALLOW_LOCAL_BUILD",
  "CMUX_SHELL_INTEGRATION",
  "CMUX_SHELL_INTEGRATION_DIR",
  "CMUX_SOCKET_ENABLE",
  "CMUX_SOCKET_MODE",
  "CMUX_SOCKET_PATH",
  "CMUX_SSH_ATTEMPT_ID",
  "CMUX_TAB_ID",
  "CMUX_TAG",
  "CMUX_TERMINAL_LIFECYCLE_ID",
  "CMUX_WORKSPACE_ID",
]);

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isInCmuxEnv(env: CmuxEnv = process.env, exists: ExistsFn = existsSync): boolean {
  if (nonEmpty(env.CMUX_WORKSPACE_ID)) return true;
  if (nonEmpty(env.CMUX_TAB_ID)) return true;
  if (nonEmpty(env.CMUX_SURFACE_ID)) return true;
  if (nonEmpty(env.CMUX_PANEL_ID)) return true;
  if (nonEmpty(env.CMUX_SOCKET_PATH)) return true;
  if (nonEmpty(env.CMUX_SOCKET)) return true;
  return exists(CURRENT_CMUX_SOCKET_PATH) || exists(LEGACY_CMUX_SOCKET_PATH) || USER_SCOPED_CMUX_SOCKET_PATHS.some(exists);
}

export function resolveCmuxCli(env: CmuxEnv = process.env, exists: ExistsFn = isExecutableFile): string {
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

export function parseTmuxEnvironmentOutput(output: string): CmuxEnv {
  const env: CmuxEnv = {};

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("-")) {
      const key = line.slice(1);
      if (TMUX_SHARED_CMUX_ENV_KEYS.has(key)) env[key] = undefined;
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = line.slice(0, equalsIndex);
    if (TMUX_SHARED_CMUX_ENV_KEYS.has(key)) env[key] = line.slice(equalsIndex + 1);
  }

  return env;
}

export async function getTmuxCmuxEnv(env: CmuxEnv = process.env, runner: CommandRunner = execFileRunner): Promise<CmuxEnv> {
  if (!nonEmpty(env.TMUX)) return {};

  const readEnvironment = async (args: string[]): Promise<CmuxEnv | undefined> => {
    try {
      const result = await runner("tmux", args, { env });
      return result.exitCode === 0 ? parseTmuxEnvironmentOutput(result.stdout) : undefined;
    } catch {
      return undefined;
    }
  };

  const [globalEnv, sessionEnv] = await Promise.all([
    readEnvironment(["show-environment", "-g"]),
    readEnvironment(["show-environment"]),
  ]);
  if (!globalEnv && !sessionEnv) {
    return { CMUX_SURFACE_ID: undefined, CMUX_PANEL_ID: undefined };
  }

  return {
    ...globalEnv,
    ...sessionEnv,
    // cmux intentionally keeps surface identity out of tmux's shared environment.
    // Resolve the active surface from the refreshed workspace instead of trusting
    // inherited values that can point at another pane after reconnects or moves.
    CMUX_SURFACE_ID: undefined,
    CMUX_PANEL_ID: undefined,
  };
}

export async function resolveRuntimeCmuxEnv(env: CmuxEnv = process.env, runner: CommandRunner = execFileRunner): Promise<CmuxEnv> {
  return { ...env, ...(await getTmuxCmuxEnv(env, runner)) };
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
    .map((surface) => ({
      id: nonEmpty(typeof surface.id === "string" ? surface.id : undefined),
      focused: surface.focused,
      selectedInPane: surface.selected_in_pane,
      selected: surface.selected,
    }))
    .filter(
      (surface): surface is { id: string; focused: unknown; selectedInPane: unknown; selected: unknown } =>
        surface.id !== undefined,
    );

  return (
    surfaces.find((surface) => surface.focused === true)?.id ??
    surfaces.find((surface) => surface.selectedInPane === true)?.id ??
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
  const payload: { title: string; body?: string; workspace_id?: string; surface_id?: string } = { title: input.title };
  if (body) payload.body = body;

  const workspaceId = getWorkspaceId(env);
  if (workspaceId) payload.workspace_id = workspaceId;
  if (resolvedSurfaceId) payload.surface_id = resolvedSurfaceId;

  // notification.create_for_surface is local-only in current cmux. The scoped
  // notification.create shape works locally and through SSH/cloud relays.
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
  if (!workspaceId) return undefined;

  const payload: { workspace_id: string; surface_id?: string; state: CmuxShellState } = { workspace_id: workspaceId, state };
  if (resolvedSurfaceId) payload.surface_id = resolvedSurfaceId;

  return ["rpc", "surface.report_shell_state", JSON.stringify(payload)];
}

export function buildLogArgs(message: string, options: CmuxLogOptions = {}): string[] {
  const args = ["log"];
  const level = normalizeLogLevel(options.level);
  if (level !== undefined) args.push("--level", level);
  if (options.source !== undefined) args.push("--source", options.source);
  args.push("--", message);
  return args;
}

function processEnvWith(overrides: CmuxEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  return env;
}

export const execFileRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 1024 * 1024,
        ...(options?.env ? { env: processEnvWith(options.env) } : {}),
      },
      (error, stdout, stderr) => {
        const maybeCode = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          exitCode: typeof maybeCode === "number" ? maybeCode : error ? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });

export async function resolveCmuxSurfaceId(
  env: CmuxEnv = process.env,
  exists: ExistsFn = isExecutableFile,
  runner: CommandRunner = execFileRunner,
): Promise<string | undefined> {
  const explicitSurfaceId = getSurfaceId(env);
  if (explicitSurfaceId) return explicitSurfaceId;

  const workspaceId = getWorkspaceId(env);
  if (!workspaceId) return undefined;

  try {
    const result = await runner(resolveCmuxCli(env, exists), buildSurfaceListArgs(workspaceId), { env });
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
    const result = await runner("tmux", ["display-message", "-p", "-t", pane, "-F", "#{session_name}:#{window_index} #{pane_id}"], { env });
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
  private readonly supportedCommandsPromises = new Map<string, Promise<Set<string>>>();
  private optionalStatusQueue: Promise<void> = Promise.resolve();

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
    const env = await this.getRuntimeEnv();
    if (!isInCmuxEnv(env, this.exists)) return;

    const paneLabel = await getTmuxPaneLabel(env, this.runner);
    const surfaceId = await this.resolveSurfaceId(env);
    await this.run(buildNotificationArgs(input, env, paneLabel, surfaceId), env);
  }

  async reportShellState(state: CmuxShellState): Promise<void> {
    const env = await this.getRuntimeEnv();
    if (!isInCmuxEnv(env, this.exists)) return;

    const surfaceId = await this.resolveSurfaceId(env);
    const args = buildReportShellStateArgs(state, env, surfaceId);
    if (args) await this.run(args, env);
  }

  async setStatus(key: string, text: string, options?: CmuxStatusOptions): Promise<void> {
    await this.enqueueStatus(async () => {
      const env = await this.getRuntimeEnv();
      if (await this.supportsCliCommand("set-status", env)) {
        await this.run(buildSetStatusArgs(key, text, options), env);
      }
    });
  }

  async clearStatus(key: string): Promise<void> {
    await this.enqueueStatus(async () => {
      const env = await this.getRuntimeEnv();
      if (await this.supportsCliCommand("clear-status", env)) {
        await this.run(buildClearStatusArgs(key), env);
      }
    });
  }

  async log(message: string, options?: CmuxLogOptions): Promise<void> {
    const env = await this.getRuntimeEnv();
    if (await this.supportsCliCommand("log", env)) {
      await this.run(buildLogArgs(message, options), env);
    }
  }

  private get env(): CmuxEnv {
    return this.options.env ?? process.env;
  }

  private get exists(): ExistsFn {
    return this.options.exists ?? existsSync;
  }

  private get cliExists(): ExistsFn {
    return this.options.exists ?? isExecutableFile;
  }

  private get runner(): CommandRunner {
    return this.options.runner ?? execFileRunner;
  }

  private async getRuntimeEnv(): Promise<CmuxEnv> {
    return resolveRuntimeCmuxEnv(this.env, this.runner);
  }

  private enqueueStatus(task: () => Promise<void>): Promise<void> {
    const next = this.optionalStatusQueue.then(task, task);
    this.optionalStatusQueue = next.catch(() => {
      // Sidebar status is best-effort; keep the queue alive after failures.
    });
    return this.optionalStatusQueue;
  }

  private async supportsCliCommand(commandName: string, env: CmuxEnv): Promise<boolean> {
    if (!isInCmuxEnv(env, this.exists)) return false;
    try {
      const commands = await this.getSupportedCliCommands(env);
      return commands.has(commandName);
    } catch {
      return false;
    }
  }

  private getSupportedCliCommands(env: CmuxEnv): Promise<Set<string>> {
    const cli = resolveCmuxCli(env, this.cliExists);
    let commands = this.supportedCommandsPromises.get(cli);
    if (!commands) {
      commands = this.readSupportedCliCommands(cli, env);
      this.supportedCommandsPromises.set(cli, commands);
    }
    return commands;
  }

  private async resolveSurfaceId(env: CmuxEnv): Promise<string | undefined> {
    return resolveCmuxSurfaceId(env, this.cliExists, this.runner);
  }

  private async readSupportedCliCommands(cli: string, env: CmuxEnv): Promise<Set<string>> {
    const commands = new Set<string>();

    try {
      const result = await this.runner(cli, ["--help"], { env });
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

  private async run(args: string[], env: CmuxEnv): Promise<void> {
    if (!isInCmuxEnv(env, this.exists)) return;
    try {
      await this.runner(resolveCmuxCli(env, this.cliExists), args, { env });
    } catch {
      // cmux is best-effort; never let notification failures affect pi.
    }
  }
}
