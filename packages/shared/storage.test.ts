import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

// Imported statically and BEFORE any PLANNOTATOR_DATA_DIR is set: this module's
// import-time side effects used to freeze the data directory, so a later env
// change was silently ignored while every other consumer resolved it live.
import { getHistoryDir, pinPlanProject, PLAN_PIN_MAX_ENTRIES, saveToHistory } from "./storage";

import { createTestEnvironment } from "../../tests/helpers/environment";

const env = createTestEnvironment(["PLANNOTATOR_DATA_DIR"], "plannotator-storage-");

afterEach(() => env.restore());

describe("storage data directory", () => {
  test("resolves PLANNOTATOR_DATA_DIR set after import", () => {
    env.reset();
    const dataDir = env.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = dataDir;

    expect(getHistoryDir("proj", "slug")).toBe(`${dataDir}/history/proj/slug`);

    const saved = saveToHistory("proj", "slug", "# Plan\n");
    expect(saved.path).toBe(`${dataDir}/history/proj/slug/001.md`);
    expect(readFileSync(saved.path, "utf-8")).toBe("# Plan\n");
  });

  test("follows a later change to PLANNOTATOR_DATA_DIR", () => {
    env.reset();
    const first = env.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = first;
    expect(getHistoryDir("proj", "slug")).toBe(`${first}/history/proj/slug`);

    const second = env.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = second;
    expect(getHistoryDir("proj", "slug")).toBe(`${second}/history/proj/slug`);
  });
});

describe("pinPlanProject", () => {
  const HOUR = 60 * 60 * 1000;

  /** A fresh data dir; the first save of plan-x under meta-repo in session s1. */
  function seeded(): string {
    env.reset();
    const dataDir = env.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    expect(pinPlanProject("claude-code:s1", "plan-x-2026-10-26", "meta-repo")).toBe("meta-repo");
    saveToHistory("meta-repo", "plan-x-2026-10-26", "# Plan x\n");
    return dataDir;
  }

  test("keeps a session's plan in the project it was first saved under, and nothing else", () => {
    seeded();
    expect(pinPlanProject("claude-code:s1", "plan-x-2026-10-27", "nested-repo")).toBe("meta-repo");
    // Another session, another plan, or no session: the detected project, as without pins.
    expect(pinPlanProject("claude-code:s2", "plan-x-2026-10-26", "nested-repo")).toBe("nested-repo");
    expect(pinPlanProject("claude-code:s1", "plan-y-2026-10-26", "nested-repo")).toBe("nested-repo");
    expect(pinPlanProject(undefined, "plan-x-2026-10-26", "nested-repo")).toBe("nested-repo");
  });

  test("the pin file is owner-only", () => {
    const dataDir = seeded();
    const file = `${dataDir}/plan-projects/claude-code/s1.json`;
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a pin whose chain is gone is not followed", () => {
    const dataDir = seeded();
    rmSync(`${dataDir}/history/meta-repo`, { recursive: true });
    expect(pinPlanProject("claude-code:s1", "plan-x-2026-10-26", "nested-repo")).toBe("nested-repo");
  });

  test("a pin older than the continue window is not followed", () => {
    seeded();
    expect(pinPlanProject("claude-code:s1", "plan-x-2026-10-29", "nested-repo", Date.now() + 49 * HOUR)).toBe("nested-repo");
  });

  test("a corrupt pin file is ignored", () => {
    const dataDir = seeded();
    writeFileSync(`${dataDir}/plan-projects/claude-code/s1.json`, "{ not json");
    expect(pinPlanProject("claude-code:s1", "plan-x-2026-10-26", "nested-repo")).toBe("nested-repo");
    writeFileSync(`${dataDir}/plan-projects/claude-code/s1.json`, JSON.stringify({ v: 1, pins: { "plan-x": { project: "../../etc", at: Date.now() } } }));
    expect(pinPlanProject("claude-code:s1", "plan-x-2026-10-26", "nested-repo")).toBe("nested-repo");
  });

  test("a session tag that could name another path writes nothing", () => {
    const dataDir = seeded();
    for (const tag of ["claude-code:../evil", "claude-code:a/b", "Claude Code:s1", "claude-code:", ":s1", "no-colon"]) {
      expect(pinPlanProject(tag, "plan-x-2026-10-26", "nested-repo")).toBe("nested-repo");
    }
    expect(readdirSync(`${dataDir}/plan-projects`)).toEqual(["claude-code"]);
    expect(readdirSync(`${dataDir}/plan-projects/claude-code`)).toEqual(["s1.json"]);
  });

  test("keeps at most PLAN_PIN_MAX_ENTRIES plans per session, the most recent", () => {
    const dataDir = seeded();
    const now = Date.now();
    for (let i = 0; i <= PLAN_PIN_MAX_ENTRIES; i++) pinPlanProject("claude-code:s1", `plan-${i}-2026-10-26`, "p", now + i);
    const pins = JSON.parse(readFileSync(`${dataDir}/plan-projects/claude-code/s1.json`, "utf-8")).pins;
    expect(Object.keys(pins)).toHaveLength(PLAN_PIN_MAX_ENTRIES);
    expect(pins["plan-x"]).toBeUndefined();
    expect(pins[`plan-${PLAN_PIN_MAX_ENTRIES}`]).toBeDefined();
  });
});
