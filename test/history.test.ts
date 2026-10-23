import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { Commands, CommandError } from "../src/command.js"
import {
  createdReferences,
  extractReferences,
  messageTexts,
  monitorSession,
  type SessionPRState,
} from "../src/history.js"
import { lookupPR } from "../src/github.js"

const branch = {
  directory: "/worktree",
  host: "github.com",
  repository: "pluslabs/magic-professional",
  localBranch: "feature/one",
  headBranch: "feature/one",
  remote: "origin",
}
const apiPR = (number: number) =>
  JSON.stringify({
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/pluslabs/magic-professional/pull/${number}`,
    state: "open",
    draft: false,
    merged_at: null,
    updated_at: "2026-10-23",
    head: { ref: "different-branch", repo: { full_name: branch.repository } },
  })

type Message = Parameters<typeof messageTexts>[0]
const creationMessage = (
  command = "gh pr create --draft --body-file /work/body.md",
  exit: number | null = 0,
  output = "https://github.com/pluslabs/billing-vcc/pull/32\n",
): Message => ({
  id: "msg_create_companion",
  type: "assistant",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "test", id: "test" },
  content: [
    {
      type: "tool",
      id: "call_create",
      name: "shell",
      time: { created: 1 },
      state: {
        status: "completed",
        input: { command },
        metadata: exit === null ? {} : { exit },
        content: [{ type: "text", text: output }],
      },
    },
  ],
})
const reviewConversation: Message[] = [
  {
    id: "msg_review_request",
    type: "user",
    time: { created: 0 },
    text: "Review https://github.com/pluslabs/magic-professional/pull/5354",
    files: [],
    agents: [],
  },
  {
    id: "msg_review_results",
    type: "assistant",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [
      {
        type: "tool",
        id: "call_commit_history",
        name: "shell",
        time: { created: 1 },
        state: {
          status: "completed",
          input: { command: "git log --format=%s" },
          content: [
            {
              type: "text",
              text: [
                "Training email backend (#5393)",
                "Improve Assistants page loading (#5418)",
                "Keep ChatGPT connected when users log out (#5419)",
                "feat(billing): unrelated merged billing change (#5376)",
                "https://github.com/pluslabs/magic-professional/pull/5243",
              ].join("\n"),
            },
          ],
        },
      },
      { type: "reasoning", text: "Inspect unrelated PR #5400 from the merge log." },
      {
        type: "text",
        text: "Merge #5067 first. Reconcile the billing policy with #5403. Recovery is tracked in [#5416](https://github.com/pluslabs/magic-professional/issues/5416).",
      },
    ],
  },
]

describe("session PR references", () => {
  it("does not interpret numbered review points as PRs", () => {
    expect(
      extractReferences(
        [
          "so does this mean we only do #1 and push back on #2?",
          "I recommend fixing **#1** and accepting **#2 as a narrow exception** for the HubSpot extension.",
        ],
        branch,
      ),
    ).toEqual([])
    expect(extractReferences(["Review PR #1."], branch).map((ref) => ref.number)).toEqual([1])
  })
  it("recognizes a successful creation in another repository without scanning arbitrary tool output", () => {
    const message = creationMessage()
    expect(messageTexts(message)).toEqual([])
    expect(createdReferences(message, branch.host)).toEqual([
      { host: "github.com", repository: "pluslabs/billing-vcc", number: 32 },
    ])
    expect(createdReferences(reviewConversation[1]!, branch.host)).toEqual([])
  })
  it.each([
    ["gh pr create", 1],
    ["gh pr create", null],
    ["echo gh pr create", 0],
    ["gh pr view 32", 0],
    ["gh pr create; gh pr view 32", 0],
  ] as const)(
    "does not infer creation from an unsuccessful or ambiguous command %s",
    (command, exit) => {
      expect(createdReferences(creationMessage(command, exit), branch.host)).toEqual([])
    },
  )
  it("does not infer creation from output containing multiple unrelated links", () => {
    expect(
      createdReferences(
        creationMessage(
          "gh pr create",
          0,
          "https://github.com/pluslabs/billing-vcc/pull/32\nhttps://github.com/pluslabs/magic-professional/pull/5099",
        ),
        branch.host,
      ),
    ).toEqual([])
  })
  it("recovers successful creation evidence when reopening the session", async () => {
    const states: SessionPRState[] = []
    const readPage: Parameters<typeof monitorSession>[2] = async ({ cursor }) => ({
      data: cursor ? [] : [creationMessage()],
      cursor: { next: cursor ? null : "after-create" },
    })
    const commands = Commands.of({ run: () => Effect.succeed(apiPR(32)) })
    const controller = new AbortController()
    const running = Effect.runPromise(
      Effect.scoped(
        monitorSession(
          "ses_created",
          branch,
          readPage,
          (state) => states.push(state),
          () => {},
          60000,
        ),
      ).pipe(Effect.provideService(Commands, commands)),
      { signal: controller.signal },
    ).catch(() => {})
    try {
      await vi.waitFor(() =>
        expect(states.at(-1)?.created).toEqual(["https://github.com/pluslabs/billing-vcc/pull/32"]),
      )
      expect(states.at(-1)?.prs[0]?.url).toBe("https://github.com/pluslabs/billing-vcc/pull/32")
    } finally {
      controller.abort()
      await running
    }
  })

  it("does not reinterpret a cross-repository Markdown label as a PR in the checkout", () => {
    expect(
      extractReferences(
        ["[billing-vcc #32](https://github.com/pluslabs/billing-vcc/pull/32)"],
        branch,
      ),
    ).toEqual([{ host: "github.com", repository: "pluslabs/billing-vcc", number: 32 }])
  })
  it("resolves earlier shorthand from an explicit link on a later history page", () => {
    expect(
      extractReferences(
        ["Address #32 next.", "[billing-vcc #32](https://github.com/pluslabs/billing-vcc/pull/32)"],
        branch,
      ),
    ).toEqual([{ host: "github.com", repository: "pluslabs/billing-vcc", number: 32 }])
  })
  it("does not invent a default-repository PR when a bare number is ambiguous", () => {
    const refs = extractReferences(
      [
        "PR #32",
        "https://github.com/pluslabs/billing-vcc/pull/32",
        "https://github.com/other/api/pull/32",
      ],
      branch,
    )
    expect(refs).toHaveLength(2)
    expect(refs.some((ref) => ref.repository === branch.repository)).toBe(false)
  })
  it("supports qualified repository names separated from the number by whitespace", () => {
    expect(extractReferences(["pluslabs/billing-vcc #32"], branch)).toEqual([
      { host: "github.com", repository: "pluslabs/billing-vcc", number: 32 },
    ])
  })
  it("recognizes URLs followed by sentence punctuation", () => {
    expect(
      extractReferences(["Review https://github.com/pluslabs/billing-vcc/pull/32."], branch).map(
        (ref) => ref.repository,
      ),
    ).toEqual(["pluslabs/billing-vcc"])
  })

  it("ignores PRs from commit logs and reasoning while keeping explicitly discussed dependencies", () => {
    const refs = extractReferences(reviewConversation.flatMap(messageTexts), branch)
    expect(refs.map((ref) => ref.number)).toEqual([5354, 5067, 5403])
  })

  it("does not filter an explicitly discussed PR by its title or topic", () => {
    const message: Message = {
      id: "msg_other_topic",
      type: "user",
      time: { created: 0 },
      text: "Also review the authentication dependency in PR #5419.",
      files: [],
      agents: [],
    }
    expect(extractReferences(messageTexts(message), branch).map((ref) => ref.number)).toEqual([
      5419,
    ])
  })

  it("does not request or display incidental PRs when reopening an existing review session", async () => {
    const states: SessionPRState[] = []
    const lookedUp: number[] = []
    const readPage: Parameters<typeof monitorSession>[2] = async ({ cursor }) => ({
      data: cursor ? [] : reviewConversation,
      cursor: { next: cursor ? null : "after-review" },
    })
    const commands = Commands.of({
      run: ({ args }) => {
        if (args[0] === "pr")
          return Effect.succeed(JSON.stringify({ reviewDecision: "", reviewRequests: [] }))
        const number = Number(args.at(-1)?.split("/").at(-1))
        lookedUp.push(number)
        return Effect.succeed(apiPR(number))
      },
    })
    const controller = new AbortController()
    const running = Effect.runPromise(
      Effect.scoped(
        monitorSession(
          "ses_review",
          branch,
          readPage,
          (state) => states.push(state),
          () => {},
          60000,
        ),
      ).pipe(Effect.provideService(Commands, commands)),
      { signal: controller.signal },
    ).catch(() => {})
    try {
      await vi.waitFor(() =>
        expect(states.at(-1)?.prs.map((pr) => pr.number)).toEqual([5354, 5067, 5403]),
      )
      expect(lookedUp).toEqual([5354, 5067, 5403])
    } finally {
      controller.abort()
      await running
    }
  })

  it("finds references added to the last message after the initial scan", async () => {
    let text = "PR #5354"
    let refresh = () => {}
    const states: SessionPRState[] = []
    const readPage: Parameters<typeof monitorSession>[2] = async ({ cursor }) => ({
      data: cursor
        ? []
        : [{ type: "user", id: "msg_streamed", time: { created: 0 }, text, files: [], agents: [] }],
      cursor: { next: cursor ? null : "after-last" },
    })
    const commands = Commands.of({
      run: ({ args }) => Effect.succeed(apiPR(Number(args.at(-1)?.split("/").at(-1)))),
    })
    const controller = new AbortController()
    const running = Effect.runPromise(
      Effect.scoped(
        monitorSession(
          "ses_test",
          branch,
          readPage,
          (state) => states.push(state),
          (fn) => {
            refresh = fn
          },
          60000,
        ),
      ).pipe(Effect.provideService(Commands, commands)),
      { signal: controller.signal },
    ).catch(() => {})
    try {
      await vi.waitFor(() => expect(states.at(-1)?.prs.map((p) => p.number)).toEqual([5354]))
      text = "PR #5354. Merge #5067 first."
      refresh()
      await vi.waitFor(() => expect(states.at(-1)?.prs.map((p) => p.number)).toEqual([5354, 5067]))
    } finally {
      controller.abort()
      await running
    }
  })

  it("finds the reviewed PR and a merge dependency, without turning the recovery issue into a PR", () => {
    const refs = extractReferences(
      [
        "Review https://github.com/pluslabs/magic-professional/pull/5354",
        "Heads up, this conflicts with #5067. I'd land #5067 first.",
        "Recovery is tracked in [#5416](https://github.com/pluslabs/magic-professional/issues/5416).",
      ],
      branch,
    )
    expect(refs.map((r) => r.number)).toEqual([5354, 5067])
  })
  it("deduplicates full URLs, shorthand, comment links, and case differences", () => {
    expect(
      extractReferences(
        [
          "https://github.com/pluslabs/magic-professional/pull/5354#discussion_r123",
          "PR #5354 and pluslabs/magic-professional#5354",
          "https://github.com/PLUSLABS/MAGIC-PROFESSIONAL/pull/5354/files",
        ],
        branch,
      ),
    ).toHaveLength(1)
  })
  it("keeps repository-qualified references separate and ignores unrelated URL fragments", () => {
    const refs = extractReferences(
      ["other/repo#123, PR 456, https://example.com/docs#789, https://example.com/a/b/pull/999"],
      branch,
    )
    expect(refs).toEqual([
      { host: "github.com", repository: "other/repo", number: 123 },
      { host: "github.com", repository: branch.repository, number: 456 },
    ])
  })
  it("confirms references through the pulls endpoint, so bare issue numbers are not shown", async () => {
    const commands = Commands.of({
      run: () =>
        Effect.fail(
          new CommandError({
            binary: "gh",
            kind: "exit",
            detail: "gh: Not Found (HTTP 404)",
            exitCode: 1,
          }),
        ),
    })
    const result = await Effect.runPromise(
      lookupPR(branch.directory, { ...branch, number: 5416 }).pipe(
        Effect.provideService(Commands, commands),
      ),
    )
    expect(result).toBeUndefined()
  })
  it("reads all pages on reopen and rechecks the latest page for completed messages", async () => {
    const states: SessionPRState[] = []
    const calls: Array<string | undefined> = []
    let refresh = () => {}
    const readPage: Parameters<typeof monitorSession>[2] = async (input) => {
      calls.push(input.cursor)
      const text =
        input.cursor === undefined
          ? "PR #5354"
          : input.cursor === "page-2"
            ? "Merge #5067 first. Issue #5416 is separate."
            : undefined
      return {
        data: text
          ? [
              {
                type: "user",
                id: `msg_${input.cursor ?? "first"}`,
                time: { created: 0 },
                text,
                files: [],
                agents: [],
              },
            ]
          : [],
        cursor: {
          previous: null,
          next: input.cursor === undefined ? "page-2" : input.cursor === "page-2" ? "tail" : null,
        },
      }
    }
    const commands = Commands.of({
      run: ({ args }) =>
        args.at(-1)?.endsWith("/5416")
          ? Effect.fail(
              new CommandError({ binary: "gh", kind: "exit", detail: "HTTP 404", exitCode: 1 }),
            )
          : Effect.succeed(apiPR(Number(args.at(-1)?.split("/").at(-1)))),
    })
    const controller = new AbortController()
    const running = Effect.runPromise(
      Effect.scoped(
        monitorSession(
          "ses_test",
          branch,
          readPage,
          (state) => states.push(state),
          (fn) => {
            refresh = fn
          },
          60000,
        ),
      ).pipe(Effect.provideService(Commands, commands)),
      { signal: controller.signal },
    ).catch(() => {})
    try {
      await vi.waitFor(() => expect(states.at(-1)?.prs.map((p) => p.number)).toEqual([5354, 5067]))
      expect(calls).toEqual([undefined, "page-2", "tail"])
      refresh()
      await vi.waitFor(() => expect(calls).toHaveLength(5))
      expect(calls[3]).toBe("page-2")
      expect(calls.at(-1)).toBe("tail")
    } finally {
      controller.abort()
      await running
    }
  })
})
