import { groupPullRequests, type PullRequest } from "./model.js"

export interface SessionChoices {
  pinned: Record<string, PullRequest>
  hidden: Record<string, PullRequest>
}

export function sessionChoicesKey(sessionID: string): string {
  return `session-${sessionID}-choices`
}

export function prKey(pr: PullRequest): string {
  return pr.url.toLowerCase()
}

export function prLabel(pr: PullRequest): string {
  const repository = new URL(pr.url).pathname.split("/")[2]
  return `${repository}#${pr.number}`
}

export function prRepository(pr: PullRequest): string {
  return new URL(pr.url).pathname.split("/").slice(1, 3).join("/")
}

export function classifyPRs(
  branchPRs: ReadonlyArray<PullRequest>,
  sessionPRs: ReadonlyArray<PullRequest>,
  created: ReadonlyArray<string>,
  choices: SessionChoices,
) {
  const primary = new Set([
    ...branchPRs.map(prKey),
    ...created.map((url) => url.toLowerCase()),
    ...Object.keys(choices.pinned),
  ])
  // Fresh GitHub results take precedence over saved pin snapshots.
  const all = new Map(Object.values(choices.pinned).map((pr) => [prKey(pr), pr]))
  for (const pr of [...sessionPRs, ...branchPRs]) all.set(prKey(pr), pr)
  const working: PullRequest[] = []
  const related: PullRequest[] = []
  for (const [key, pr] of all) {
    if (choices.hidden[key]) continue
    if (primary.has(key)) working.push(pr)
    else related.push(pr)
  }
  const workingGroups = groupPullRequests(working)
  const relatedGroups = groupPullRequests(related)
  return { working: workingGroups, related: [...relatedGroups.active, ...relatedGroups.previous] }
}
