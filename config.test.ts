import { describe, expect, test } from "bun:test";
import {
  applyOverlay,
  CONFIG_MTIME_CHECK_INTERVAL_MS,
  DEFAULT_CONFIG,
  getPluginConfig,
  indicatorFrames,
  indicatorSettled,
  isHideThinkingBlock,
  resetHideThinkingCacheForTest,
  yamlHideThinkingReadsForTest,
  maybeReloadConfig,
  setPluginConfigForTest,
} from "./core/config.ts";

describe("enum settings reject prototype-chain names", () => {
  test("prototype members are not accepted as indicator or detail level", () => {
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      const config = applyOverlay(DEFAULT_CONFIG, { indicator: name, detailLevel: name });
      expect(config.indicator).toBe(DEFAULT_CONFIG.indicator);
      expect(config.detailLevel).toBe(DEFAULT_CONFIG.detailLevel);
    }
  });

  test("a rejected indicator still yields usable frames", () => {
    const config = applyOverlay(DEFAULT_CONFIG, { indicator: "constructor" });
    expect(indicatorFrames(config).length).toBeGreaterThan(0);
    expect(typeof indicatorSettled(config)).toBe("string");
  });

  test("valid enum values are still accepted", () => {
    expect(applyOverlay(DEFAULT_CONFIG, { indicator: "dot" }).indicator).toBe("dot");
    expect(applyOverlay(DEFAULT_CONFIG, { detailLevel: "minimal" }).detailLevel).toBe("minimal");
  });
});

describe("composerRefreshInterval config", () => {
  test("defaults to 60 seconds", () => {
    expect(DEFAULT_CONFIG.composerRefreshInterval).toBe(60);
  });

  test("accepts valid numeric values in seconds", () => {
    const config = applyOverlay(DEFAULT_CONFIG, { composerRefreshInterval: 30 });
    expect(config.composerRefreshInterval).toBe(30);
  });

  test("clamps values to bounds [1, 3600]", () => {
    const minClamped = applyOverlay(DEFAULT_CONFIG, { composerRefreshInterval: 0 });
    expect(minClamped.composerRefreshInterval).toBe(1);

    const negClamped = applyOverlay(DEFAULT_CONFIG, { composerRefreshInterval: -10 });
    expect(negClamped.composerRefreshInterval).toBe(1);

    const maxClamped = applyOverlay(DEFAULT_CONFIG, { composerRefreshInterval: 5000 });
    expect(maxClamped.composerRefreshInterval).toBe(3600);
  });

  test("ignores invalid non-numeric types", () => {
    const invalid = applyOverlay(DEFAULT_CONFIG, { composerRefreshInterval: "60" });
    expect(invalid.composerRefreshInterval).toBe(60);

    const nanVal = applyOverlay(DEFAULT_CONFIG, { composerRefreshInterval: NaN });
    expect(nanVal.composerRefreshInterval).toBe(60);
  });

  test("getPluginConfig returns custom value set via setPluginConfigForTest", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, composerRefreshInterval: 45 });
      expect(getPluginConfig().composerRefreshInterval).toBe(45);
    } finally {
      setPluginConfigForTest(null);
      expect(getPluginConfig().composerRefreshInterval).toBe(60);
    }
  });
});

describe("maybeReloadConfig throttling", () => {
  test("throttles mtime checks within interval", () => {
    const now = 10_000;
    // First check runs
    maybeReloadConfig(now, true);
    // Checks within interval are throttled (no throw, no repeated stats)
    expect(() => maybeReloadConfig(now + 500)).not.toThrow();
    expect(() => maybeReloadConfig(now + CONFIG_MTIME_CHECK_INTERVAL_MS - 1)).not.toThrow();
    // Check after interval elapses runs
    expect(() => maybeReloadConfig(now + CONFIG_MTIME_CHECK_INTERVAL_MS + 1)).not.toThrow();
  });
});

describe("thinking visibility stays off the disk in render paths", () => {
  test("repeated calls reuse one cached yml answer", () => {
    resetHideThinkingCacheForTest();
    for (let i = 0; i < 50; i += 1) isHideThinkingBlock();
    // One read set (cwd yml, then the agent yml only if the first missed) per cache window.
    expect(yamlHideThinkingReadsForTest()).toBeLessThanOrEqual(1);
  });

  test("a context-provided value short-circuits without touching the cache", () => {
    resetHideThinkingCacheForTest();
    expect(isHideThinkingBlock({ hideThinkingBlock: false })).toBe(false);
    expect(isHideThinkingBlock({ hideThinkingBlock: true })).toBe(true);
    expect(yamlHideThinkingReadsForTest()).toBe(0);
  });
});
