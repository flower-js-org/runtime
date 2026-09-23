import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The site builder is an untyped Node script.
import { buildDocs } from "../scripts/build-docs.mjs";

test("the website is built from its page list, with every internal link resolving", () => {
  assert.doesNotThrow(() => buildDocs({ check: true }));
});
