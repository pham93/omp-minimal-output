import { describe, expect, test } from "bun:test";
import { applyOverlay, DEFAULT_CONFIG, getPluginConfig, setPluginConfigForTest } from "./core/config.ts";

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
