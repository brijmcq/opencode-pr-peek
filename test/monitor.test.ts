import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { GitHub } from "../src/github.js"
import { monitor } from "../src/monitor.js"
import { PeekError, type Branch, type PeekState, type PullRequest } from "../src/model.js"

const branch: Branch = {
  directory: "/worktrees/one",
  localBranch: "one",
  headBranch: "one",
  remote: "origin",
  host: "github.com",
  repository: "team/app",
}
const pr: PullRequest = {
  number: 1,
  title: "One",
  url: "https://github.com/team/app/pull/1",
  state: "open",
  updatedAt: "2026-10-23",
}

describe("monitor lifecycle", () => {
  it("looks up the branch again when a session is reopened", async () => {
    let lookups = 0
    const github = GitHub.of({
      checkout: () => Effect.succeed({ kind: "branch", branch }),
      pulls: () =>
        Effect.sync(() => {
          lookups++
          return [pr]
        }),
    })
    for (let opening = 0; opening < 2; opening++) {
      const states: PeekState[] = []
      const controller = new AbortController()
      const running = Effect.runPromise(
        Effect.scoped(
          monitor(
            branch.directory,
            (s) => states.push(s),
            () => {},
          ),
        ).pipe(Effect.provideService(GitHub, github)),
        { signal: controller.signal },
      ).catch(() => {})
      try {
        await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ phase: "ready", prs: [pr] }))
      } finally {
        controller.abort()
        await running
      }
    }
    expect(lookups).toBe(2)
  })

  it("does not publish a completed lookup if the branch changed before the next tick", async () => {
    let checkouts = 0
    const states: PeekState[] = []
    const github = GitHub.of({
      checkout: () =>
        Effect.sync(() => ({
          kind: "branch" as const,
          branch: ++checkouts === 1 ? branch : { ...branch, localBranch: "two", headBranch: "two" },
        })),
      pulls: (b) => Effect.succeed([{ ...pr, number: b.localBranch === "one" ? 1 : 2 }]),
    })
    const controller = new AbortController()
    const running = Effect.runPromise(
      Effect.scoped(
        monitor(
          branch.directory,
          (s) => states.push(s),
          () => {},
        ),
      ).pipe(Effect.provideService(GitHub, github)),
      { signal: controller.signal },
    ).catch(() => {})
    try {
      await vi.waitFor(() =>
        expect(states.at(-1)).toMatchObject({ phase: "ready", prs: [{ number: 2 }] }),
      )
      expect(states.some((s) => s.phase === "ready" && s.prs.some((p) => p.number === 1))).toBe(
        false,
      )
    } finally {
      controller.abort()
      await running
    }
  })

  it("clears the previous branch immediately and interrupts its outstanding lookup", async () => {
    let current = branch
    let oldInterrupted = false
    const states: PeekState[] = []
    const github = GitHub.of({
      checkout: () => Effect.sync(() => ({ kind: "branch" as const, branch: current })),
      pulls: (b) =>
        b.localBranch === "one"
          ? Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  oldInterrupted = true
                }),
              ),
            )
          : Effect.succeed([{ ...pr, number: 2 }]),
    })
    const controller = new AbortController()
    const running = Effect.runPromise(
      Effect.scoped(
        monitor(
          branch.directory,
          (state) => states.push(state),
          () => {},
          {
            localRefreshMs: 10,
            remoteRefreshMs: 60_000,
          },
        ),
      ).pipe(Effect.provideService(GitHub, github)),
      { signal: controller.signal },
    ).catch(() => {})
    try {
      await vi.waitFor(() => expect(states.some((s) => s.branch?.localBranch === "one")).toBe(true))
      current = { ...branch, localBranch: "two", headBranch: "two" }
      await vi.waitFor(() =>
        expect(states.at(-1)).toMatchObject({ phase: "ready", prs: [{ number: 2 }] }),
      )
      expect(oldInterrupted).toBe(true)
      expect(states.find((s) => s.branch?.localBranch === "two")).toMatchObject({
        phase: "loading",
        prs: [],
      })
    } finally {
      controller.abort()
      await running
    }
  })

  it("throttles remote polling, supports manual refresh, and stops after disposal", async () => {
    let lookups = 0
    let refresh = () => {}
    const states: PeekState[] = []
    const github = GitHub.of({
      checkout: () => Effect.succeed({ kind: "branch", branch }),
      pulls: () =>
        Effect.sync(() => {
          lookups++
          return [pr]
        }),
    })
    const controller = new AbortController()
    const running = Effect.runPromise(
      Effect.scoped(
        monitor(
          branch.directory,
          (s) => states.push(s),
          (fn) => {
            refresh = fn
          },
          {
            localRefreshMs: 10,
            remoteRefreshMs: 60_000,
          },
        ),
      ).pipe(Effect.provideService(GitHub, github)),
      { signal: controller.signal },
    ).catch(() => {})
    try {
      await vi.waitFor(() => expect(states.at(-1)?.phase).toBe("ready"))
      expect(lookups).toBe(1)
      refresh()
      await vi.waitFor(() => expect(lookups).toBe(2))
    } finally {
      controller.abort()
      await running
    }
    refresh()
    expect(lookups).toBe(2)
  })

  it("does not confuse failed lookups with no PR", async () => {
    const states: PeekState[] = []
    const controller = new AbortController()
    const running = Effect.runPromise(
      Effect.scoped(
        monitor(
          branch.directory,
          (s) => states.push(s),
          () => {},
        ),
      ).pipe(
        Effect.provideService(
          GitHub,
          GitHub.of({
            checkout: () => Effect.succeed({ kind: "branch", branch }),
            pulls: () => Effect.fail(new PeekError({ kind: "auth", message: "Sign in" })),
          }),
        ),
      ),
      { signal: controller.signal },
    ).catch(() => {})
    try {
      await vi.waitFor(() =>
        expect(states.at(-1)).toMatchObject({ phase: "error", message: "Sign in" }),
      )
    } finally {
      controller.abort()
      await running
    }
  })
})
