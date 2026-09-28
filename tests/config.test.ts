import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, defaultConfigPath, normalizeConfig } from "../src/config.js";

test("normalizes config with approved lifecycle and notification defaults", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    lifecycle: true,
    notifications: { done: true, error: true, xplan: true, input: true, headless: false },
    status: true,
    logs: true,
  });
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ notifications: { done: false }, logs: false }), {
    ...DEFAULT_CONFIG,
    notifications: { ...DEFAULT_CONFIG.notifications, done: false },
    logs: false,
  });
});

test("ignores malformed config values", () => {
  assert.deepEqual(
    normalizeConfig({ lifecycle: "false", notifications: { done: "no", error: false, xplan: 1, input: null, headless: "true" }, status: "yes", logs: null }),
    { ...DEFAULT_CONFIG, notifications: { ...DEFAULT_CONFIG.notifications, error: false } },
  );
});

test("supports notifier-only mode and explicit input or headless preferences", () => {
  assert.deepEqual(normalizeConfig({ lifecycle: false, notifications: { input: false, headless: true } }), {
    ...DEFAULT_CONFIG,
    lifecycle: false,
    notifications: { ...DEFAULT_CONFIG.notifications, input: false, headless: true },
  });
});

test("config defaults are not shared mutable notification objects", () => {
  const config = normalizeConfig(undefined);
  config.notifications.input = false;
  assert.equal(normalizeConfig(undefined).notifications.input, true);
});

test("resolves config path from env or xdg config home", () => {
  assert.equal(defaultConfigPath({ PI_CMUX_CONFIG: "/tmp/pi-cmux.json" }), "/tmp/pi-cmux.json");
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/config" }), "/tmp/config/pi-cmux/config.json");
});
