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
  signal?: AbortSignal;
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

export interface CmuxTarget {
  workspaceId?: string;
  surfaceId?: string;
  terminalLifecycleId?: string;
}

export interface CmuxDiagnostics {
  available: boolean;
  cli: string;
  transport: "local" | "relay";
  workspaceId?: string;
  surfaceId?: string;
  supportedCommands: string[] | null;
  recentFailures: Array<{ operation: string; exitCode: number }>;
}

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

function workspaceMatches(value: unknown, requestedWorkspaceId: string): boolean {
  if (typeof value !== "string") return false;
  const workspaceId = nonEmpty(value);
  if (!workspaceId) return false;
  if (workspaceId === requestedWorkspaceId) return true;

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(workspaceId) &&
    uuidPattern.test(requestedWorkspaceId) &&
    workspaceId.toLowerCase() === requestedWorkspaceId.toLowerCase();
}

function parseCurrentSurfaceOutput(output: string, workspaceId: string): string | undefined {
  const result: unknown = JSON.parse(output);
  if (!isRecord(result) || result.surface_type !== "terminal") return undefined;
  if (!workspaceMatches(result.workspace_id, workspaceId) && !workspaceMatches(result.workspace_ref, workspaceId)) return undefined;
  return typeof result.surface_id === "string" ? nonEmpty(result.surface_id) : undefined;
}

export function buildSurfaceListArgs(workspaceId: string): string[] {
  return ["rpc", "surface.list", JSON.stringify({ workspace_id: workspaceId })];
}

export function buildSurfaceCurrentArgs(workspaceId: string): string[] {
  return ["rpc", "surface.current", JSON.stringify({ workspace_id: workspaceId })];
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

export function isRemoteRelay(env: CmuxEnv): boolean {
  const socketPath = nonEmpty(env.CMUX_SOCKET_PATH) ?? nonEmpty(env.CMUX_SOCKET);
  // Match the CLI's loopback host and UInt16 port parser, not arbitrary ':' paths.
  const endpoint = socketPath?.match(/^(127\.0\.0\.1|localhost):(\+?\d+)$/i);
  return !!endpoint && Number(endpoint[2]) > 0 && Number(endpoint[2]) <= 65535;
}

export function buildReportShellStateArgs(
  state: CmuxShellState,
  env: CmuxEnv = process.env,
  resolvedSurfaceId = getSurfaceId(env),
): string[] | undefined {
  const workspaceId = getWorkspaceId(env);
  if (!workspaceId) return undefined;

  if (!resolvedSurfaceId && isRemoteRelay(env)) return undefined;

  const payload: { workspace_id: string; surface_id?: string; state: CmuxShellState; terminal_lifecycle_id?: string } = {
    workspace_id: workspaceId,
    state,
  };
  if (resolvedSurfaceId) payload.surface_id = resolvedSurfaceId;
  const lifecycleId = nonEmpty(env.CMUX_TERMINAL_LIFECYCLE_ID);
  // An inferred surface can belong to a different terminal than this lifecycle.
  if (lifecycleId && resolvedSurfaceId && resolvedSurfaceId === getSurfaceId(env)) {
    payload.terminal_lifecycle_id = lifecycleId;
  }

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
        ...(options?.signal ? { signal: options.signal } : {}),
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

  const relay = isRemoteRelay(env);
  const args = relay ? buildSurfaceCurrentArgs(workspaceId) : buildSurfaceListArgs(workspaceId);
  try {
    const result = await runner(resolveCmuxCli(env, exists), args, { env });
    if (result.exitCode !== 0) return undefined;
    return relay ? parseCurrentSurfaceOutput(result.stdout, workspaceId) : parseSurfaceListOutput(result.stdout);
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
  private readonly recentFailures: CmuxDiagnostics["recentFailures"] = [];

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

  async captureTarget(): Promise<CmuxTarget> {
    const env = await this.getRuntimeEnv();
    if (!isInCmuxEnv(env, this.exists)) return {};
    const surfaceId = await this.resolveSurfaceId(env);
    return {
      workspaceId: getWorkspaceId(env),
      surfaceId,
      terminalLifecycleId: surfaceId && surfaceId === getSurfaceId(env) ? nonEmpty(env.CMUX_TERMINAL_LIFECYCLE_ID) : undefined,
    };
  }

  async getDiagnostics(target?: CmuxTarget): Promise<CmuxDiagnostics> {
    const env = await this.getRuntimeEnv(target);
    const available = isInCmuxEnv(env, this.exists);
    const relay = isRemoteRelay(env);
    let supportedCommands: string[] | null = relay || !available ? [] : null;
    if (available && !relay) {
      try {
        const commands = await this.getSupportedCliCommands(env);
        supportedCommands = ["set-status", "clear-status", "log"].filter((command) => commands.has(command));
      } catch {
        // null distinguishes a failed probe from known unsupported commands.
      }
    }
    return {
      available,
      cli: resolveCmuxCli(env, this.cliExists),
      transport: relay ? "relay" : "local",
      workspaceId: getWorkspaceId(env),
      surfaceId: target ? target.surfaceId : await this.resolveSurfaceId(env),
      supportedCommands,
      recentFailures: this.recentFailures.map((failure) => ({ ...failure })),
    };
  }

  async notify(input: CmuxNotificationInput, target?: CmuxTarget, signal?: AbortSignal): Promise<void> {
    // A captured lifecycle target must never fall back to current focus.
    if (signal?.aborted || (target && !target.surfaceId)) return;
    const env = await this.getRuntimeEnv(target);
    if (!isInCmuxEnv(env, this.exists)) return;

    const paneLabel = await getTmuxPaneLabel(env, this.runner);
    const surfaceId = target ? target.surfaceId : await this.resolveSurfaceId(env);
    await this.run(buildNotificationArgs(input, env, paneLabel, surfaceId), env, signal);
  }

  async reportShellState(state: CmuxShellState, target?: CmuxTarget): Promise<boolean> {
    if (target && !target.surfaceId) return false;
    const env = await this.getRuntimeEnv(target);
    if (!isInCmuxEnv(env, this.exists)) return false;

    const surfaceId = target ? target.surfaceId : await this.resolveSurfaceId(env);
    const args = buildReportShellStateArgs(state, env, surfaceId);
    return args ? this.run(args, env) : false;
  }

  async setStatus(key: string, text: string, options?: CmuxStatusOptions, target?: CmuxTarget): Promise<"skipped" | "attempted"> {
    if (target && (!target.workspaceId || !target.surfaceId)) return "skipped";
    let result: "skipped" | "attempted" = "skipped";
    await this.enqueueStatus(async () => {
      const env = await this.getRuntimeEnv(target);
      if (await this.supportsCliCommand("set-status", env)) {
        const args = buildSetStatusArgs(key, text, options);
        if (target) args.push(`--panel=${target.surfaceId}`, `--pid=${process.pid}`);
        // Even a failed command may have reached cmux, so it needs cleanup.
        result = "attempted";
        await this.run(args, env);
      }
    });
    return result;
  }

  async clearStatus(key: string, target?: CmuxTarget): Promise<boolean> {
    // Incomplete lifecycle targets cannot have written an owned sidebar entry.
    if (target && (!target.workspaceId || !target.surfaceId)) return true;
    let cleared = false;
    await this.enqueueStatus(async () => {
      const env = await this.getRuntimeEnv(target);
      if (await this.supportsCliCommand("clear-status", env)) {
        const args = buildClearStatusArgs(key);
        if (target) args.push(`--panel=${target.surfaceId}`);
        cleared = await this.run(args, env);
      }
    });
    return cleared;
  }

  async log(message: string, options?: CmuxLogOptions, target?: CmuxTarget): Promise<void> {
    const env = await this.getRuntimeEnv(target);
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

  private async getRuntimeEnv(target?: CmuxTarget): Promise<CmuxEnv> {
    const env = await resolveRuntimeCmuxEnv(this.env, this.runner);
    if (!target) return env;
    // Refresh transport, not ownership. A reconnect must not move a pending
    // completion to whichever terminal now has focus.
    const sameLifecycle = target.surfaceId === getSurfaceId(env) && target.terminalLifecycleId === nonEmpty(env.CMUX_TERMINAL_LIFECYCLE_ID);
    return {
      ...env,
      CMUX_WORKSPACE_ID: target.workspaceId,
      CMUX_TAB_ID: undefined,
      CMUX_SURFACE_ID: target.surfaceId,
      CMUX_PANEL_ID: undefined,
      CMUX_TERMINAL_LIFECYCLE_ID: sameLifecycle ? target.terminalLifecycleId : undefined,
    };
  }

  private enqueueStatus(task: () => Promise<void>): Promise<void> {
    const next = this.optionalStatusQueue.then(task, task);
    this.optionalStatusQueue = next.catch(() => {
      // Sidebar status is best-effort; keep the queue alive after failures.
    });
    return this.optionalStatusQueue;
  }

  private async supportsCliCommand(commandName: string, env: CmuxEnv): Promise<boolean> {
    if (!isInCmuxEnv(env, this.exists) || isRemoteRelay(env)) return false;
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
      const pending = commands;
      void pending.catch(() => {
        if (this.supportedCommandsPromises.get(cli) === pending) this.supportedCommandsPromises.delete(cli);
      });
    }
    return commands;
  }

  private async resolveSurfaceId(env: CmuxEnv): Promise<string | undefined> {
    const explicitSurfaceId = getSurfaceId(env);
    if (explicitSurfaceId) return explicitSurfaceId;
    const workspaceId = getWorkspaceId(env);
    if (!workspaceId) return undefined;
    // Remote cmux's tmux integration uses this workspace-scoped lookup too.
    // Some relay/app versions fail surface.list despite accepting surface.current.
    const relay = isRemoteRelay(env);
    const args = relay ? buildSurfaceCurrentArgs(workspaceId) : buildSurfaceListArgs(workspaceId);
    const result = await this.execute(resolveCmuxCli(env, this.cliExists), args, env);
    if (result.exitCode !== 0) return undefined;
    try {
      return relay ? parseCurrentSurfaceOutput(result.stdout, workspaceId) : parseSurfaceListOutput(result.stdout);
    } catch {
      this.recordFailure(`rpc ${args[1]}`, 1);
      return undefined;
    }
  }

  private async readSupportedCliCommands(cli: string, env: CmuxEnv): Promise<Set<string>> {
    const result = await this.execute(cli, ["--help"], env);
    if (result.exitCode !== 0) throw new Error("cmux capability probe failed");
    const commands = new Set<string>();
    for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
      const match = line.match(/^\s{2}([a-z][\w-]*)\b/);
      if (match) commands.add(match[1]);
    }
    return commands;
  }

  private recordFailure(operation: string, exitCode: number): void {
    this.recentFailures.push({ operation, exitCode });
    if (this.recentFailures.length > 5) this.recentFailures.shift();
  }

  private async execute(cli: string, args: string[], env: CmuxEnv, signal?: AbortSignal): Promise<CommandResult> {
    if (signal?.aborted) return { exitCode: 1, stdout: "", stderr: "" };
    let result: CommandResult;
    try {
      result = await this.runner(cli, args, { env, ...(signal ? { signal } : {}) });
    } catch {
      result = { exitCode: 1, stdout: "", stderr: "" };
    }
    if (result.exitCode !== 0 && !signal?.aborted) this.recordFailure(args[0] === "rpc" ? `rpc ${args[1]}` : args[0], result.exitCode);
    return result;
  }

  private async run(args: string[], env: CmuxEnv, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || !isInCmuxEnv(env, this.exists)) return false;
    const result = await this.execute(resolveCmuxCli(env, this.cliExists), args, env, signal);
    return result.exitCode === 0;
  }
}
