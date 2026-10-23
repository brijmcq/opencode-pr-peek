import { Effect, Schema } from "effect"
import { Commands } from "./command.js"
import type { PullRequest, ReviewStatus } from "./model.js"

const ReviewResponse = Schema.Struct({
  reviewDecision: Schema.NullOr(
    Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""]),
  ),
  reviewRequests: Schema.Array(Schema.Unknown),
})

export const enrichReview = Effect.fn("enrichReview")(function* (
  directory: string,
  pr: PullRequest,
): Effect.fn.Return<PullRequest, never, Commands> {
  if (pr.state === "merged" || pr.state === "closed") return pr
  const commands = yield* Commands
  const url = new URL(pr.url)
  const repository = `${url.hostname}/${url.pathname.split("/").slice(1, 3).join("/")}`
  const review = yield* commands
    .run({
      binary: "gh",
      cwd: directory,
      args: [
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repository,
        "--json",
        "reviewDecision,reviewRequests",
      ],
    })
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewResponse))),
      Effect.map((response): ReviewStatus => ({
        decision:
          response.reviewDecision === "APPROVED"
            ? "approved"
            : response.reviewDecision === "CHANGES_REQUESTED"
              ? "changes-requested"
              : response.reviewDecision === "REVIEW_REQUIRED"
                ? "review-required"
                : "no-decision",
        requestedReviews: response.reviewRequests.length,
      })),
      Effect.catch(() => Effect.succeed<ReviewStatus>({ decision: "unavailable" })),
    )
  return { ...pr, review }
})

export interface ReviewPresentation {
  readonly label: string
  readonly tone: "positive" | "negative" | "warning" | "muted"
}

export function reviewPresentation(pr: PullRequest): ReviewPresentation | undefined {
  if (pr.state === "merged" || pr.state === "closed") return undefined
  const review = pr.review
  if (!review) return { label: "Review not loaded", tone: "muted" }
  if (review.decision === "unavailable") return { label: "Review unavailable", tone: "warning" }
  const requested = review.requestedReviews ?? 0
  const suffix = requested > 0 ? ` · ${requested} requested` : ""
  switch (review.decision) {
    case "approved":
      return { label: `Approved${suffix}`, tone: "positive" }
    case "changes-requested":
      return { label: `Changes requested${suffix}`, tone: "negative" }
    case "review-required":
      return { label: `Review required${suffix}`, tone: "warning" }
    case "no-decision":
      return {
        label: requested ? `Awaiting review${suffix}` : "No review decision",
        tone: requested ? "warning" : "muted",
      }
  }
}
