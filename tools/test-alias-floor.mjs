import assert from "node:assert/strict";
import test from "node:test";
import {createFspIdentityConfig} from "../src/core/config.mjs";

test("field floor covers the alias header and the observed Civ7 window", () => {
  const config = createFspIdentityConfig();
  // Archived Switch 2 marker wave, 2026-11-15. This was not a per-copy sample.
  const observedMarkerWindowBytes = 0x2690;
  const maximumCacheHeaderBytes = 0x28;
  const requiredCacheBytes = config.MARKER_OFFSET +
    Math.max(config.CACHE_ALIAS_PREFIX.length, maximumCacheHeaderBytes) + 1;

  assert.ok(requiredCacheBytes <= config.FIELD_MINIMUM_CACHE_HELD);
  assert.ok(config.FIELD_MINIMUM_CACHE_HELD <= observedMarkerWindowBytes);
  assert.ok(config.WINDOW_MINIMUM_CACHE_HELD <= observedMarkerWindowBytes);
});
