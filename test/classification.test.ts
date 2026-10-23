import { describe, expect, it } from "vitest"
import {
  classifyPRs,
  prKey,
  prLabel,
  prRepository,
  sessionChoicesKey,
  type SessionChoices,
} from "../src/classification.js"
import type { PullRequest } from "../src/model.js"

const pr = (
  repository: string,
  number: number,
  state: PullRequest["state"] = "open",
): PullRequest => ({
  number,
  state,
  url: `https://github.com/pluslabs/${repository}/pull/${number}`,
  title: `PR ${number}`,
  updatedAt: "2026-10-24",
})
const main = pr("magic-professional", 5338)
const companion = pr("billing-vcc", 32)
const dependency = pr("magic-professional", 5099, "merged")
const empty: SessionChoices = { pinned: {}, hidden: {} }

describe("working and related PRs", () => {
  it("retains created and pinned PRs when default-branch lookup supplies no automatic matches", () => {
    const result = classifyPRs([], [companion, dependency], [companion.url], {
      pinned: { [prKey(main)]: main },
      hidden: {},
    })
    expect(result.working.active).toEqual([main, companion])
    expect(result.related).toEqual([dependency])
  })
  it("groups current-branch and session-created PRs as working, not just mentions", () => {
    const result = classifyPRs([main], [main, companion, dependency], [companion.url], empty)
    expect(result.working.active).toEqual([main, companion])
    expect(result.related).toEqual([dependency])
  })
  it("identifies PRs by the full repository URL instead of their number", () => {
    const wrong32 = pr("magic-professional", 32, "closed")
    const result = classifyPRs([], [companion, wrong32], [companion.url], empty)
    expect(result.working.active).toEqual([companion])
    expect(result.related).toEqual([wrong32])
    expect(prLabel(companion)).toBe("billing-vcc#32")
    expect(prLabel(wrong32)).toBe("magic-professional#32")
    expect(prRepository(companion)).toBe("pluslabs/billing-vcc")
  })
  it("keeps pinned PRs working after they disappear from current lookup results", () => {
    const choices = { pinned: { [prKey(dependency)]: dependency }, hidden: {} }
    expect(classifyPRs([], [], [], choices).working.previous).toEqual([dependency])
    const refreshed = { ...dependency, state: "open" as const }
    expect(classifyPRs([], [refreshed], [], choices).working.active).toEqual([refreshed])
  })
  it("hides a PR even if it is branch-linked, created here, or pinned", () => {
    const choices = { pinned: { [prKey(main)]: main }, hidden: { [prKey(main)]: main } }
    const result = classifyPRs([main], [main], [main.url], choices)
    expect(result.working.active).toEqual([])
    expect(result.related).toEqual([])
  })
  it("restores a hidden pin and returns an unpinned mention to related PRs", () => {
    const choices: SessionChoices = {
      pinned: { [prKey(dependency)]: dependency },
      hidden: { [prKey(dependency)]: dependency },
    }
    delete choices.hidden[prKey(dependency)]
    expect(classifyPRs([], [dependency], [], choices).working.previous).toEqual([dependency])
    delete choices.pinned[prKey(dependency)]
    expect(classifyPRs([], [dependency], [], choices).related).toEqual([dependency])
  })
  it("uses different durable storage keys for different sessions", () => {
    expect(sessionChoicesKey("ses_one")).not.toBe(sessionChoicesKey("ses_two"))
    expect(sessionChoicesKey("ses_one")).toBe("session-ses_one-choices")
    expect(sessionChoicesKey("ses_one")).not.toMatch(/[\\/]/)
  })
})
