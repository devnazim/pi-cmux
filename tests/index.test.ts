import assert from "node:assert/strict";
import test from "node:test";

import { formatDoneTitle } from "../src/index.js";

test("formats done notification titles with optional session names", () => {
  assert.equal(formatDoneTitle(undefined), "Pi done");
  assert.equal(formatDoneTitle(""), "Pi done");
  assert.equal(formatDoneTitle("  Refactor auth  "), "Pi done: Refactor auth");
});
