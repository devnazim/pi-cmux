import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { isAbsolute } from "node:path";

export interface TuiTarget {
  tuiSocketPath?: string;
  terminalId?: string;
  sessionId?: string;
}

export interface TuiNotification {
  title: string;
  body: string;
  subtitle?: string;
}

export type TuiDelivery = "delivered" | "cancelled" | "invalid" | "refused" | "disconnected" | "timeout" | "malformed" | "overflow";

const RESPONSE_LIMIT = 1024 * 1024;
const TIMEOUT_MS = 3_000;

export function isTuiEnv(env: Record<string, string | undefined>): boolean {
  return [env.CMUX_TUI_SOCKET, env.CMUX_MUX_SOCKET, env.CMUX_TUI_TERMINAL_ID, env.CMUX_TUI_SESSION_ID]
    .some((value) => value !== undefined);
}

export function tuiTargetFromEnv(env: Record<string, string | undefined>): TuiTarget {
  return {
    tuiSocketPath: env.CMUX_TUI_SOCKET?.trim() ? env.CMUX_TUI_SOCKET : env.CMUX_MUX_SOCKET,
    terminalId: env.CMUX_TUI_TERMINAL_ID,
    sessionId: env.CMUX_TUI_SESSION_ID,
  };
}

export function isValidTuiTarget(target: TuiTarget): boolean {
  return typeof target.tuiSocketPath === "string" && isAbsolute(target.tuiSocketPath) &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(target.tuiSocketPath) &&
    typeof target.terminalId === "string" && /^term_[0-9a-f]{32}$/.test(target.terminalId) &&
    (target.sessionId === undefined || typeof target.sessionId === "string" && /^session_[0-9a-f]{32}$/.test(target.sessionId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFields(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function isDecimal(value: unknown): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) &&
    value.length <= 20 && BigInt(value) <= 18446744073709551615n;
}

function isNotificationResult(result: unknown, target: TuiTarget): boolean {
  if (!isRecord(result) || !hasFields(result, ["value", "generation", "revision", "replayed"]) ||
    typeof result.generation !== "string" || !result.generation || !isDecimal(result.revision) ||
    typeof result.replayed !== "boolean" || !isRecord(result.value)) return false;
  const value = result.value;
  return hasFields(value, ["id", "session_id", "title", "body", "level", "created_at_ms", "unread", "read_by"],
    ["subtitle", "terminal_id", "extra"]) &&
    typeof value.id === "string" && /^notification_[0-9a-f]{32}$/.test(value.id) &&
    typeof value.session_id === "string" && /^session_[0-9a-f]{32}$/.test(value.session_id) &&
    (target.sessionId === undefined || value.session_id === target.sessionId) &&
    value.terminal_id === target.terminalId && typeof value.title === "string" && typeof value.body === "string" &&
    (value.subtitle === undefined || typeof value.subtitle === "string" && [...value.subtitle].length <= 512) &&
    typeof value.level === "string" && ["info", "warning", "error"].includes(value.level) && isDecimal(value.created_at_ms) &&
    typeof value.unread === "boolean" && Array.isArray(value.read_by) && value.read_by.length <= 256 &&
    value.read_by.every((id) => typeof id === "string" && [...id].length >= 1 && [...id].length <= 128) &&
    (value.extra === undefined || isRecord(value.extra));
}

/** One mutation per dedicated connection. Failures never cause an implicit retry. */
export async function sendTuiNotification(
  target: TuiTarget,
  input: TuiNotification,
  signal?: AbortSignal,
): Promise<TuiDelivery> {
  if (signal?.aborted) return "cancelled";
  if (!isValidTuiTarget(target) || !input.title || [...input.title].length > 512 ||
    [...input.body].length > 4096 || (input.subtitle !== undefined && [...input.subtitle].length > 512)) return "invalid";

  const id = randomUUID();
  const request = JSON.stringify({
    protocol: "cmux.protocol/2", type: "request", id, operation: "notification.create", idempotency_key: randomUUID(),
    params: {
      machine: "current", session: target.sessionId ?? "current", terminal_id: target.terminalId,
      title: input.title, body: input.body, ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
    },
  }) + "\n";

  return new Promise((resolve) => {
    const socket = new Socket();
    let outcome: TuiDelivery | undefined;
    let receivedBytes = 0;
    let frame = Buffer.alloc(RESPONSE_LIMIT);
    let frameLength = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // This deadline includes connection and dispatch, not just socket idleness.
    const timer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
    const abort = () => finish("cancelled");

    function finish(result: TuiDelivery): void {
      if (outcome) return;
      outcome = result;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      frame = Buffer.alloc(0);
      frameLength = 0;
      socket.destroy();
    }

    function onClose(): void {
      if (!outcome) finish("disconnected");
      socket.removeListener("connect", onConnect);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onClose);
      resolve(outcome!);
    }

    function onConnect(): void {
      if (!outcome) socket.write(request);
    }
    function onError(error: NodeJS.ErrnoException): void {
      finish(error.code === "ECONNREFUSED" ? "refused" : "disconnected");
    }
    function onEnd(): void {
      finish(frameLength ? "malformed" : "disconnected");
    }
    function onData(chunk: Buffer): void {
      if (outcome) return;
      receivedBytes += chunk.length;
      if (receivedBytes > RESPONSE_LIMIT) return finish("overflow");
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        chunk.copy(frame, frameLength, start, end);
        frameLength += end - start;
        let response: unknown;
        try {
          const line = decoder.decode(frame.subarray(0, frameLength));
          frameLength = 0;
          start = end + 1;
          if (!line.trim()) continue;
          response = JSON.parse(line);
        } catch {
          return finish("malformed");
        }
        if (!isRecord(response) || response.protocol !== "cmux.protocol/2" || response.type !== "response" ||
          typeof response.id !== "string" || typeof response.ok !== "boolean") return finish("malformed");
        if (response.id !== id) continue;
        if (response.ok) {
          return finish(hasFields(response, ["protocol", "type", "id", "ok", "result"]) &&
            isNotificationResult(response.result, target) ? "delivered" : "malformed");
        }
        const error = response.error;
        return finish(hasFields(response, ["protocol", "type", "id", "ok", "error"]) && isRecord(error) &&
          hasFields(error, ["code", "message", "details", "retryable"]) && typeof error.code === "string" &&
          typeof error.message === "string" && isRecord(error.details) && typeof error.retryable === "boolean" ? "refused" : "malformed");
      }
      if (start < chunk.length) {
        chunk.copy(frame, frameLength, start);
        frameLength += chunk.length - start;
      }
    }

    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return finish("cancelled");
    try {
      socket.connect(target.tuiSocketPath!);
    } catch {
      finish("invalid");
    }
  });
}
