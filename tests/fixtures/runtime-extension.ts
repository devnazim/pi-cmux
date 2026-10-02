import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { normalizeConfig } from "../../src/config.js";
import { registerPiCmuxExtension } from "../../src/index.js";

// Load the same registration code as the package entry point. Only cmux I/O
// is replaced, so the installed Pi owns API registration and event contexts.
export default function runtimeExtension(pi: ExtensionAPI): void {
  const calls: string[] = [];
  const statusKeys: string[] = [];
  const target = { workspaceId: "workspace:test", surfaceId: "surface:test" };
  const registration = registerPiCmuxExtension(pi, normalizeConfig(undefined), {
    async captureTarget() { calls.push("capture"); return target; },
    async reportShellState(state) { calls.push(`shell:${state}`); return true; },
    async setStatus(key, text) { calls.push(`status:${text}`); statusKeys.push(key); return "attempted"; },
    async clearStatus(key) { calls.push("clear"); statusKeys.push(key); return true; },
    async notify(input, scope, signal) {
      if (signal?.aborted) return;
      if (scope !== target) throw new Error("Notification lost its captured target");
      calls.push(`notify:${input.title}:${input.body}`);
    },
    async log(message, options) { calls.push(`log:${options?.level}:${message}`); },
    async getDiagnostics() {
      return { available: true, cli: "test", transport: "local", ...target, supportedCommands: [], recentFailures: [] };
    },
  });
  pi.registerCommand("test-cmux-flush", {
    description: "Wait for test deliveries and report them",
    handler: async (args, ctx) => {
      await registration.flush();
      if (args === "reset") calls.length = 0;
      ctx.ui.notify(JSON.stringify({ calls, statusKeys }), "info");
    },
  });
}
