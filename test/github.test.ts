import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { Commands, CommandError, type CommandInput } from "../src/command.js"
import { GitHub, githubError, parseRemote } from "../src/github.js"
import { groupPullRequests, type Branch } from "../src/model.js"

const branch: Branch = {
  directory: "/worktrees/one",
  localBranch: "local-name",
  headBranch: "feature/login",
  remote: "origin",
  host: "github.com",
  repository: "alice/app",
}

function fixture(overrides: Record<string, string | CommandError> = {}) {
  const calls: CommandInput[] = []
  const answers: Record<string, string | CommandError> = {
    "rev-parse --is-inside-work-tree": "true",
    "symbolic-ref --quiet --short HEAD": "local-name",
    "config --get branch.local-name.remote": "origin",
    "config --get branch.local-name.merge": "refs/heads/feature/login",
    remote: "origin\nupstream",
    "remote get-url --push origin": "git@github.com:alice/app.git",
    ...overrides,
  }
  const commands = Commands.of({
    run: (input) => {
      calls.push(input)
      const answer =
        answers[input.args.join(" ")] ??
        new CommandError({ binary: input.binary, kind: "exit", detail: "", exitCode: 1 })
      return answer instanceof CommandError ? Effect.fail(answer) : Effect.succeed(answer)
    },
  })
  const run = <A, E>(program: Effect.Effect<A, E, GitHub>) =>
    Effect.runPromise(
      program.pipe(Effect.provide(GitHub.layer), Effect.provideService(Commands, commands)),
    )
  return { run, calls }
}

function apiPR(number: number, extra = {}) {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/team/app/pull/${number}`,
    state: "open",
    draft: false,
    merged_at: null,
    updated_at: "2026-10-23T12:00:00Z",
    head: { ref: "feature/login", repo: { full_name: "alice/app" } },
    ...extra,
  }
}

describe("remote parsing", () => {
  it.each([
    ["git@github.com:alice/app.git", "github.com"],
    ["https://github.com/alice/app.git", "github.com"],
    ["ssh://git@github.example.com:2222/alice/app.git", "github.example.com"],
    ["https://github.com/alice/app/", "github.com"],
  ])("parses %s", (url, host) =>
    expect(parseRemote(url)).toEqual({ host, repository: "alice/app" }),
  )
  it.each([
    "/local/repo",
    "file:///repo",
    "https://github.com/alice/app/extra",
    "https://user:secret@github.com/alice/app",
  ])("rejects unsupported URL %s", (url) => expect(parseRemote(url)).toBeUndefined())
})

describe("checkout discovery", () => {
  it("uses the viewed worktree and tracked branch name", async () => {
    const { run, calls } = fixture()
    expect(await run(Effect.flatMap(GitHub, (gh) => gh.checkout(branch.directory)))).toEqual({
      kind: "branch",
      branch,
    })
    expect(calls.every((call) => call.cwd === "/worktrees/one")).toBe(true)
    expect(calls.every((call) => call.binary === "git")).toBe(true)
  })
  it("honors pushRemote instead of mistaking upstream for the head repo", async () => {
    const { run } = fixture({
      "config --get branch.local-name.pushRemote": "fork",
      "remote get-url --push fork": "https://github.com/bob/app.git",
    })
    const result = await run(Effect.flatMap(GitHub, (gh) => gh.checkout(branch.directory)))
    expect(result).toMatchObject({
      kind: "branch",
      branch: { repository: "bob/app", remote: "fork", headBranch: "local-name" },
    })
  })
  it("distinguishes a detached checkout", async () => {
    const { run } = fixture({
      "symbolic-ref --quiet --short HEAD": new CommandError({
        binary: "git",
        kind: "exit",
        detail: "",
        exitCode: 1,
      }),
    })
    expect(await run(Effect.flatMap(GitHub, (gh) => gh.checkout(branch.directory)))).toMatchObject({
      kind: "none",
      message: expect.stringContaining("Detached"),
    })
  })
  it("distinguishes a non-Git directory", async () => {
    const { run } = fixture({
      "rev-parse --is-inside-work-tree": new CommandError({
        binary: "git",
        kind: "exit",
        detail: "fatal: not a git repository",
        exitCode: 128,
      }),
    })
    expect(await run(Effect.flatMap(GitHub, (gh) => gh.checkout("/not-git")))).toEqual({
      kind: "none",
      message: "Not a Git checkout",
    })
  })
  it("does not hide missing directories as an empty PR list", async () => {
    const { run } = fixture({
      "rev-parse --is-inside-work-tree": new CommandError({
        binary: "git",
        kind: "spawn",
        detail: "cwd NotFound",
      }),
    })
    const result = await run(Effect.exit(Effect.flatMap(GitHub, (gh) => gh.checkout("/deleted"))))
    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe("PR lookup", () => {
  const repoCommand = "repo view github.com/alice/app --json nameWithOwner,parent,defaultBranchRef"
  const apiCommand =
    "api --hostname github.com repos/team/app/pulls?state=all&head=alice%3Afeature%2Flogin&per_page=100&sort=updated&direction=desc --paginate --slurp"
  it("loads review decisions from the base repository for fork PRs", async () => {
    const { run, calls } = fixture({
      [repoCommand]: JSON.stringify({
        nameWithOwner: "alice/app",
        parent: { nameWithOwner: "team/app" },
        defaultBranchRef: { name: "main" },
      }),
      [apiCommand]: JSON.stringify([[apiPR(1)]]),
      "pr view 1 --repo github.com/team/app --json reviewDecision,reviewRequests": JSON.stringify({
        reviewDecision: "APPROVED",
        reviewRequests: [{ login: "reviewer" }],
      }),
    })
    const prs = await run(Effect.flatMap(GitHub, (gh) => gh.pulls(branch)))
    expect(prs[0]?.review).toEqual({ decision: "approved", requestedReviews: 1 })
    expect(calls.at(-1)?.args).toContain("github.com/team/app")
  })
  it.each(["main", "master", "trunk"])(
    "does not associate historical PRs from default branch %s",
    async (name) => {
      const { run, calls } = fixture({
        [repoCommand]: JSON.stringify({
          nameWithOwner: "alice/app",
          parent: null,
          defaultBranchRef: { name },
        }),
      })
      expect(
        await run(
          Effect.flatMap(GitHub, (gh) =>
            gh.pulls({ ...branch, localBranch: "local-alias", headBranch: name }),
          ),
        ),
      ).toEqual([])
      expect(calls).toHaveLength(1)
      expect(calls.some((call) => call.args[0] === "api")).toBe(false)
    },
  )
  it("still resolves main when it is a feature branch rather than the repository default", async () => {
    const endpoint = apiCommand.replace("feature%2Flogin", "main")
    const { run } = fixture({
      [repoCommand]: JSON.stringify({
        nameWithOwner: "alice/app",
        parent: { nameWithOwner: "team/app" },
        defaultBranchRef: { name: "trunk" },
      }),
      [endpoint]: JSON.stringify([
        [apiPR(42, { head: { ref: "main", repo: { full_name: "alice/app" } } })],
      ]),
    })
    expect(
      await run(Effect.flatMap(GitHub, (gh) => gh.pulls({ ...branch, headBranch: "main" }))),
    ).toMatchObject([{ number: 42 }])
  })
  it("paginates, handles multiple PRs, and rejects other forks with the same branch name", async () => {
    const { run, calls } = fixture({
      [repoCommand]: JSON.stringify({
        nameWithOwner: "alice/app",
        defaultBranchRef: { name: "main" },
        parent: { nameWithOwner: "team/app" },
      }),
      [apiCommand]: JSON.stringify([
        [
          apiPR(1),
          apiPR(2, { draft: true }),
          apiPR(3, { head: { ref: "feature/login", repo: { full_name: "bob/app" } } }),
        ],
        [
          apiPR(4, { state: "closed", merged_at: "2026-10-22T12:00:00Z" }),
          apiPR(5, { state: "closed" }),
        ],
      ]),
    })
    const prs = await run(Effect.flatMap(GitHub, (gh) => gh.pulls(branch)))
    expect(prs.map((pr) => [pr.number, pr.state])).toEqual([
      [1, "open"],
      [2, "draft"],
      [4, "merged"],
      [5, "closed"],
    ])
    expect(groupPullRequests(prs).active.map((pr) => pr.number)).toEqual([2, 1])
    expect(groupPullRequests(prs).previous.map((pr) => pr.number)).toEqual([5, 4])
    expect(calls[1]?.args).toContain("--paginate")
  })
  it("represents a successful empty lookup as an empty list", async () => {
    const { run } = fixture({
      [repoCommand]: JSON.stringify({
        nameWithOwner: "alice/app",
        defaultBranchRef: { name: "main" },
        parent: { nameWithOwner: "team/app" },
      }),
      [apiCommand]: "[[]]",
    })
    expect(await run(Effect.flatMap(GitHub, (gh) => gh.pulls(branch)))).toEqual([])
  })
  it("retries an inaccessible repository with another authenticated account", async () => {
    const calls: CommandInput[] = []
    const commands = Commands.of({
      run: (input: CommandInput) => {
        calls.push(input)
        const command = input.args.join(" ")
        if (command === repoCommand && input.env?.GH_TOKEN !== "alice-token") {
          return Effect.fail(
            new CommandError({
              binary: "gh",
              kind: "exit",
              detail: "GraphQL: Could not resolve to a Repository with the name 'alice/app'.",
              exitCode: 1,
            }),
          )
        }
        if (command === "auth status --hostname github.com --json hosts") {
          return Effect.succeed(
            JSON.stringify({
              hosts: {
                "github.com": [
                  { login: "other", active: true, state: "success" },
                  { login: "alice", active: false, state: "success" },
                ],
              },
            }),
          )
        }
        if (command === "auth token --hostname github.com --user alice") {
          return Effect.succeed("alice-token")
        }
        if (command === repoCommand) {
          return Effect.succeed(
            JSON.stringify({
              nameWithOwner: "alice/app",
              parent: { nameWithOwner: "team/app" },
              defaultBranchRef: { name: "main" },
            }),
          )
        }
        if (command === apiCommand) return Effect.succeed(JSON.stringify([[apiPR(1)]]))
        if (
          command === "pr view 1 --repo github.com/team/app --json reviewDecision,reviewRequests"
        ) {
          return Effect.succeed(JSON.stringify({ reviewDecision: "", reviewRequests: [] }))
        }
        return Effect.fail(
          new CommandError({
            binary: input.binary,
            kind: "exit",
            detail: "unexpected",
            exitCode: 1,
          }),
        )
      },
    })
    const result = await Effect.runPromise(
      Effect.flatMap(GitHub, (github) => github.pulls(branch)).pipe(
        Effect.provide(GitHub.layer),
        Effect.provideService(Commands, commands),
      ),
    )

    expect(result).toMatchObject([{ number: 1 }])
    expect(calls.filter((call) => call.args.join(" ") === repoCommand)).toHaveLength(2)
    expect(
      calls
        .filter((call) => call.args[0] === "api" || call.args[0] === "pr")
        .every((call) => call.env?.GH_TOKEN === "alice-token"),
    ).toBe(true)
  })
  it("rejects malformed API data rather than treating it as no PR", async () => {
    const { run } = fixture({ [repoCommand]: "not JSON" })
    const result = await run(
      Effect.flatMap(GitHub, (gh) => gh.pulls(branch)).pipe(
        Effect.catch((error) => Effect.succeed(error)),
      ),
    )
    expect(result).toMatchObject({ kind: "invalid-data" })
  })
  it("classifies missing gh and unauthenticated gh separately", () => {
    expect(
      githubError(new CommandError({ binary: "gh", kind: "spawn", detail: "NotFound: gh" })).kind,
    ).toBe("missing-gh")
    expect(
      githubError(
        new CommandError({ binary: "gh", kind: "exit", detail: "run gh auth login", exitCode: 4 }),
      ).kind,
    ).toBe("auth")
    expect(
      githubError(new CommandError({ binary: "gh", kind: "timeout", detail: "timeout" })).kind,
    ).toBe("lookup")
  })
})
