/**
 * #2197: a plan's version history is keyed `history/{project}/{slug}`, and
 * `project` comes from the CLI's cwd, which a shell cd moves between submits.
 * Claude Code hands the CLI its session id (the mod on `claude-mod-plan`'s
 * stdin, the classic hook in its payload's `session_id`), and a resubmit of the
 * same plan in the same session continues the chain that session saved it to
 * (`pinPlanProject`, packages/shared/storage.ts). Everything else is as before.
 *
 * Runs the real CLI as a process against a scratch data dir and a workspace
 * repository holding two separate clones.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];

beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | null | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (init.exitCode !== 0) throw new Error(`git init failed in ${dir}`);
}

/** A workspace repository holding two separate clones, and a scratch data dir. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-plan-history-session-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  const serviceA = join(workspace, "service-a");
  const serviceB = join(workspace, "service-b");
  gitInit(workspace);
  gitInit(serviceA);
  gitInit(serviceB);
  return { root, workspace, serviceA, serviceB, data: join(root, "data") };
}

/** The test env: no agent markers, never a browser. */
function baseEnv(data: string, ready: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ["CLAUDE_PROJECT_DIR", "PLANNOTATOR_SESSION_TAG", "PLANNOTATOR_CWD", "CODEX_THREAD_ID", "COPILOT_CLI", "OPENCODE", "GEMINI_CLI", "OMPCODE", "PLANNOTATOR_HOST_RESULT_FILE"]) {
    delete env[key];
  }
  return {
    ...(env as Record<string, string>),
    PLANNOTATOR_DATA_DIR: data,
    PLANNOTATOR_PORT: "0",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_READY_FILE: ready,
    PLANNOTATOR_AI: "disabled",
    PLANNOTATOR_SHARE: "disabled",
    PLANNOTATOR_ORIGIN: "claude-code",
    ...extra,
  };
}

interface PlanView {
  plan: string;
  previousPlan: string | null;
  versionInfo: { version: number; totalVersions: number; project: string };
}

type Kind = "mod" | "classic";
let launchSeq = 0;

/**
 * One plan submit from `cwd` in session `session` (null: none sent): start
 * the CLI, read `/api/plan`, deny, wait for exit. "mod" runs
 * `claude-mod-plan`; "classic" runs the PermissionRequest hook.
 */
async function submit(
  w: ReturnType<typeof world>,
  opts: { kind: Kind; cwd: string; plan: string; session: string | null },
): Promise<PlanView> {
  const launch = join(w.data, "claude-code-mod", "launches", `launch-${++launchSeq}`);
  mkdirSync(launch, { recursive: true });
  const ready = join(launch, "ready");
  const session = opts.session === null ? {} : opts.kind === "mod" ? { sessionId: opts.session } : { session_id: opts.session };
  const stdin =
    opts.kind === "mod"
      ? { plan: opts.plan, ...session }
      : {
          hook_event_name: "PermissionRequest",
          tool_name: "ExitPlanMode",
          permission_mode: "plan",
          tool_input: { plan: opts.plan },
          ...session,
        };
  const proc = Bun.spawn([process.execPath, "run", entry, ...(opts.kind === "mod" ? ["claude-mod-plan"] : [])], {
    cwd: opts.cwd,
    env: baseEnv(w.data, ready, opts.kind === "mod" ? { PLANNOTATOR_HOST_RESULT_FILE: join(launch, "result.json") } : {}),
    stdin: new TextEncoder().encode(JSON.stringify(stdin)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const line = await waitFor(() => (existsSync(ready) ? readFileSync(ready, "utf8").split("\n")[0] : null));
  const base = `http://localhost:${(JSON.parse(line) as { port: number }).port}`;
  const view = (await (await fetch(`${base}/api/plan`)).json()) as PlanView;
  const deny = await fetch(`${base}/api/deny`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedback: "Not yet." }),
  });
  expect(deny.status).toBe(200);
  expect(await proc.exited).toBe(0);
  return view;
}

const V1 = "# Ship it\n\n1. First.\n";
const V2 = "# Ship it\n\n1. First.\n2. Second.\n";

describe("a session's resubmit continues its plan's chain after a shell cd (#2197)", () => {
  const moves = [
    ["workspace", "service-a", "workspace"],
    ["service-a", "workspace", "service-a"],
    ["service-a", "service-b", "service-a"],
  ] as const;
  const dirOf = (w: ReturnType<typeof world>, name: string) =>
    name === "workspace" ? w.workspace : name === "service-a" ? w.serviceA : w.serviceB;

  for (const kind of ["mod", "classic"] as const) {
    for (const [from, to, project] of moves) {
      test(`${kind}: ${from} → ${to} is version 2 of the chain under ${project}`, async () => {
        const w = world();
        const first = await submit(w, { kind, cwd: dirOf(w, from), plan: V1, session: "session-1" });
        expect(first.versionInfo).toMatchObject({ version: 1, project });

        const second = await submit(w, { kind, cwd: dirOf(w, to), plan: V2, session: "session-1" });
        expect(second.versionInfo).toMatchObject({ version: 2, totalVersions: 2, project });
        expect(second.previousPlan).toBe(V1);
      }, 60_000);
    }
  }

  test("the mod and the classic hook share one session's pins", async () => {
    const w = world();
    await submit(w, { kind: "mod", cwd: w.workspace, plan: V1, session: "session-1" });
    const second = await submit(w, { kind: "classic", cwd: w.serviceA, plan: V2, session: "session-1" });
    expect(second.versionInfo).toMatchObject({ version: 2, project: "workspace" });
  }, 60_000);
});

describe("everything else is as on main", () => {
  test("another session's same-heading plan at the root does not pull a new plan in a clone", async () => {
    const w = world();
    const other = await submit(w, { kind: "mod", cwd: w.workspace, plan: "# Implementation Plan\n\nThe API.\n", session: "session-1" });
    expect(other.versionInfo).toMatchObject({ version: 1, project: "workspace" });

    const fresh = await submit(w, { kind: "mod", cwd: w.serviceA, plan: "# Implementation Plan\n\nThe worker.\n", session: "session-2" });
    expect(fresh.versionInfo).toMatchObject({ version: 1, totalVersions: 1, project: "service-a" });
    expect(fresh.previousPlan).toBeNull();
  }, 60_000);

  test("a new plan from a nested clone lands under the clone, even after the session saved another plan at the root", async () => {
    const w = world();
    await submit(w, { kind: "mod", cwd: w.workspace, plan: V1, session: "session-1" });
    const other = await submit(w, { kind: "classic", cwd: w.serviceA, plan: "# Fix the worker\n\n1. Retry.\n", session: "session-1" });
    expect(other.versionInfo).toMatchObject({ version: 1, project: "service-a" });
    expect(other.previousPlan).toBeNull();
  }, 60_000);

  test("two sessions with the same heading in one project share the chain, as on main", async () => {
    const w = world();
    await submit(w, { kind: "mod", cwd: w.serviceA, plan: V1, session: "session-1" });
    const second = await submit(w, { kind: "mod", cwd: w.serviceA, plan: V2, session: "session-2" });
    expect(second.versionInfo).toMatchObject({ version: 2, project: "service-a" });
  }, 60_000);

  test("a corrupt pin file is ignored: the cwd's project decides", async () => {
    const w = world();
    await submit(w, { kind: "mod", cwd: w.workspace, plan: V1, session: "session-1" });
    const pinFile = join(w.data, "plan-projects", "claude-code", "session-1.json");
    expect(existsSync(pinFile)).toBe(true);
    writeFileSync(pinFile, "{ not json");

    const second = await submit(w, { kind: "mod", cwd: w.serviceA, plan: V2, session: "session-1" });
    expect(second.versionInfo).toMatchObject({ version: 1, project: "service-a" });
  }, 60_000);

  for (const kind of ["mod", "classic"] as const) {
    test(`${kind}: no session id splits by cwd exactly as before, and writes no pin`, async () => {
      const w = world();
      const first = await submit(w, { kind, cwd: w.workspace, plan: V1, session: null });
      const second = await submit(w, { kind, cwd: w.serviceA, plan: V2, session: null });
      expect(first.versionInfo).toMatchObject({ version: 1, project: "workspace" });
      expect(second.versionInfo).toMatchObject({ version: 1, project: "service-a" });

      const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(w.data, "history"), dot: true }))).sort();
      expect(files.map((path) => path.replace(/-\d{4}-\d{2}-\d{2}\//, "-<date>/"))).toEqual([
        "service-a/ship-it-<date>/001.md",
        "workspace/ship-it-<date>/001.md",
      ]);
      expect(existsSync(join(w.data, "plan-projects"))).toBe(false);
    }, 60_000);
  }
});
