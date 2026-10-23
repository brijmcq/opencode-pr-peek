import { Schema } from "effect"

export const ReviewStatus = Schema.Struct({
  decision: Schema.Literals([
    "approved",
    "changes-requested",
    "review-required",
    "no-decision",
    "unavailable",
  ]),
  requestedReviews: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
})
export type ReviewStatus = typeof ReviewStatus.Type

export const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["open", "draft", "merged", "closed"]),
  updatedAt: Schema.String,
  review: Schema.optionalKey(ReviewStatus),
})
export type PullRequest = typeof PullRequest.Type

export interface PRReference {
  readonly host: string
  readonly repository: string
  readonly number: number
}

export function referenceKey(reference: PRReference): string {
  return `https://${reference.host}/${reference.repository}/pull/${reference.number}`.toLowerCase()
}

export interface Branch {
  readonly directory: string
  readonly localBranch: string
  readonly headBranch: string
  readonly remote: string
  readonly host: string
  readonly repository: string
}

export type Checkout =
  | { readonly kind: "branch"; readonly branch: Branch }
  | { readonly kind: "none"; readonly message: string }

export class PeekError extends Schema.TaggedError<PeekError>()("PeekError", {
  kind: Schema.Literals(["git", "missing-gh", "auth", "unsupported", "lookup", "invalid-data"]),
  message: Schema.String,
}) {}

export type PeekState = {
  readonly phase: "loading" | "ready" | "error" | "none"
  readonly branch?: Branch
  readonly prs: ReadonlyArray<PullRequest>
  readonly message?: string
}

export const initialState: PeekState = { phase: "loading", prs: [] }

export function branchKey(branch: Branch): string {
  return JSON.stringify([
    branch.directory,
    branch.localBranch,
    branch.headBranch,
    branch.remote,
    branch.host,
    branch.repository,
  ])
}

export function groupPullRequests(prs: ReadonlyArray<PullRequest>) {
  const sorted = [...prs].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number,
  )
  return {
    active: sorted.filter((pr) => pr.state === "open" || pr.state === "draft"),
    previous: sorted.filter((pr) => pr.state === "merged" || pr.state === "closed"),
  }
}

export function cleanLabel(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
}
