import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Commands, CommandError, type CommandInput } from "../src/command.js"
import { PullRequest } from "../src/model.js"
import { enrichReview, reviewPresentation } from "../src/review.js"

const pr: PullRequest = {
  number: 32,
  title: "Companion card API",
  url: "https://github.com/pluslabs/billing-vcc/pull/32",
  state: "open",
  updatedAt: "2026-10-24",
}

function fixture(response: unknown) {
  const calls: CommandInput[] = []
  const service = Commands.of({
    run: (input) => {
      calls.push(input)
      return response instanceof CommandError
        ? Effect.fail(response)
        : Effect.succeed(JSON.stringify(response))
    },
  })
  return {
    calls,
    run: (input = pr) =>
      Effect.runPromise(
        enrichReview("/worktree", input).pipe(Effect.provideService(Commands, service)),
      ),
  }
}

describe("GitHub review status", () => {
  it.each([
    ["APPROVED", "approved", "Approved", "positive"],
    ["CHANGES_REQUESTED", "changes-requested", "Changes requested", "negative"],
    ["REVIEW_REQUIRED", "review-required", "Review required", "warning"],
    ["", "no-decision", "No review decision", "muted"],
    [null, "no-decision", "No review decision", "muted"],
  ] as const)(
    "shows GitHub's aggregate decision %s",
    async (reviewDecision, decision, label, tone) => {
      const { run } = fixture({ reviewDecision, reviewRequests: [] })
      const result = await run()
      expect(result.review).toEqual({ decision, requestedReviews: 0 })
      expect(reviewPresentation(result)).toEqual({ label, tone })
    },
  )

  it("keeps approval and outstanding review requests separate", async () => {
    const { run } = fixture({ reviewDecision: "APPROVED", reviewRequests: [{ login: "reviewer" }] })
    expect(reviewPresentation(await run())).toEqual({
      label: "Approved · 1 requested",
      tone: "positive",
    })
  })

  it("shows awaiting review without claiming a required decision", async () => {
    const { run } = fixture({
      reviewDecision: "",
      reviewRequests: [{ login: "reviewer" }, { name: "team" }],
    })
    expect(reviewPresentation(await run())).toEqual({
      label: "Awaiting review · 2 requested",
      tone: "warning",
    })
  })

  it("queries the PR's own repository, not the checkout repository", async () => {
    const { run, calls } = fixture({ reviewDecision: "APPROVED", reviewRequests: [] })
    await run()
    expect(calls).toEqual([
      {
        binary: "gh",
        cwd: "/worktree",
        args: [
          "pr",
          "view",
          "32",
          "--repo",
          "github.com/pluslabs/billing-vcc",
          "--json",
          "reviewDecision,reviewRequests",
        ],
      },
    ])
  })

  it("supports the PR's GitHub Enterprise host", async () => {
    const { run, calls } = fixture({ reviewDecision: "REVIEW_REQUIRED", reviewRequests: [] })
    await run({ ...pr, url: "https://github.example.com/team/api/pull/32" })
    expect(calls[0]?.args).toContain("github.example.com/team/api")
  })

  it.each(["closed", "merged"] as const)("skips review calls for %s PRs", async (state) => {
    const { run, calls } = fixture({})
    const result = await run({ ...pr, state })
    expect(calls).toEqual([])
    expect(reviewPresentation(result)).toBeUndefined()
  })

  it("includes review status for draft PRs without changing their lifecycle state", async () => {
    const { run } = fixture({ reviewDecision: "REVIEW_REQUIRED", reviewRequests: [] })
    const result = await run({ ...pr, state: "draft" })
    expect(result.state).toBe("draft")
    expect(reviewPresentation(result)?.label).toBe("Review required")
  })

  it.each([
    new CommandError({ binary: "gh", kind: "timeout", detail: "Timed out" }),
    new CommandError({
      binary: "gh",
      kind: "exit",
      exitCode: 4,
      detail: "Authentication required",
    }),
    { reviewDecision: "UNEXPECTED", reviewRequests: [] },
    { reviewDecision: "APPROVED" },
  ])("does not mistake failed review lookups for approval or no decision", async (response) => {
    const { run } = fixture(response)
    const result = await run({ ...pr, review: { decision: "approved", requestedReviews: 0 } })
    expect(result.url).toBe(pr.url)
    expect(result.review).toEqual({ decision: "unavailable" })
    expect(reviewPresentation(result)).toEqual({ label: "Review unavailable", tone: "warning" })
  })

  it("loads a fresh decision on refresh rather than retaining stale approval", async () => {
    let current = "APPROVED"
    const service = Commands.of({
      run: () => Effect.succeed(JSON.stringify({ reviewDecision: current, reviewRequests: [] })),
    })
    const run = (input: PullRequest) =>
      Effect.runPromise(
        enrichReview("/worktree", input).pipe(Effect.provideService(Commands, service)),
      )
    const approved = await run(pr)
    current = "REVIEW_REQUIRED"
    expect(reviewPresentation(await run(approved))?.label).toBe("Review required")
  })

  it("accepts legacy pins with no review fields without implying approval", () => {
    const saved = Schema.decodeUnknownSync(PullRequest)(pr)
    expect(reviewPresentation(saved)).toEqual({ label: "Review not loaded", tone: "muted" })
  })
})
