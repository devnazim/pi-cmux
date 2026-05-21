import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, defaultConfigPath, normalizeConfig } from "../src/config.js";

test("normalizes config with useful defaults", () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ notifications: { done: false }, logs: false }), {
    notifications: {
      done: false,
      error: true,
      xplan: true,
    },
    status: true,
    logs: false,
  });
});

test("ignores malformed config values", () => {
  assert.deepEqual(
    normalizeConfig({ notifications: { done: "no", error: false, xplan: 1 }, status: "yes", logs: null }),
    {
      notifications: {
        done: true,
        error: false,
        xplan: true,
      },
      status: true,
      logs: true,
    },
  );
});

test("resolves config path from env or xdg config home", () => {
  assert.equal(defaultConfigPath({ PI_CMUX_CONFIG: "/tmp/pi-cmux.json" }), "/tmp/pi-cmux.json");
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/config" }), "/tmp/config/pi-cmux/config.json");
});
