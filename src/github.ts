import { Context, Effect, Layer, Schema } from "effect"
import { Commands, CommandError } from "./command.js"
import { enrichReview } from "./review.js"
import {
  PeekError,
  type Branch,
  type Checkout,
  type PullRequest,
  type PRReference,
} from "./model.js"

const Repo = Schema.Struct({
  nameWithOwner: Schema.String,
  defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  parent: Schema.optionalKey(Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String }))),
})
const ApiPR = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  draft: Schema.Boolean,
  merged_at: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
  head: Schema.Struct({
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
})
const Pages = Schema.Array(Schema.Array(ApiPR))

export const lookupPR = Effect.fn("lookupPR")(function* (
  directory: string,
  reference: PRReference,
) {
  const commands = yield* Commands
  const result = yield* commands
    .run({
      binary: "gh",
      cwd: directory,
      args: [
        "api",
        "--hostname",
        reference.host,
        `repos/${reference.repository}/pulls/${reference.number}`,
      ],
    })
    .pipe(
      Effect.catch((error) =>
        error.kind === "exit" && /(?:HTTP 404|Not Found)/i.test(error.detail)
          ? Effect.succeed(undefined)
          : Effect.fail(githubError(error)),
      ),
    )
  if (result === undefined) return undefined
  const pr = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApiPR))(result).pipe(
    Effect.mapError(
      () =>
        new PeekError({ kind: "invalid-data", message: "Unexpected GitHub pull request response" }),
    ),
  )
  const pullRequest = {
    number: pr.number,
    title: pr.title,
    url: `https://${reference.host}/${reference.repository}/pull/${pr.number}`,
    state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
    updatedAt: pr.updated_at,
  } satisfies PullRequest
  return yield* enrichReview(directory, pullRequest)
})

export function parseRemote(remote: string): { host: string; repository: string } | undefined {
  const match =
    /^(?:https?:\/\/|ssh:\/\/(?:[^/@]+@)?|git:\/\/|[^/@:]+@)([^/:]+)(?::\d+\/|[:/])([^/]+)\/([^/]+?)\/?$/.exec(
      remote,
    )
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  const name = match[3].replace(/\.git$/, "")
  if (!/^[\w.-]+$/.test(match[2]) || !/^[\w.-]+$/.test(name)) return undefined
  return { host: match[1].toLowerCase(), repository: `${match[2]}/${name}` }
}

export function githubError(error: CommandError): PeekError {
  if (error.binary === "gh" && error.kind === "spawn" && /NotFound|ENOENT/.test(error.detail)) {
    return new PeekError({ kind: "missing-gh", message: "GitHub CLI missing — install gh" })
  }
  if (
    error.exitCode === 4 ||
    /auth login|not logged|authentication|HTTP 401|bad credentials/i.test(error.detail)
  ) {
    return new PeekError({ kind: "auth", message: "GitHub sign-in needed — run gh auth login" })
  }
  return new PeekError({
    kind: "lookup",
    message:
      error.kind === "timeout"
        ? "GitHub lookup timed out — refresh to retry"
        : "GitHub lookup failed — refresh to retry",
  })
}

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly checkout: (directory: string) => Effect.Effect<Checkout, PeekError>
    readonly pulls: (branch: Branch) => Effect.Effect<ReadonlyArray<PullRequest>, PeekError>
  }
>()("opencode-pr-peek/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const commands = yield* Commands
      const checkout = Effect.fn("GitHub.checkout")(
        function* (directory: string) {
          const git = (...args: string[]) => commands.run({ binary: "git", args, cwd: directory })
          const optional = (...args: string[]) =>
            git(...args).pipe(
              Effect.catch((error) =>
                error.kind === "exit" && error.exitCode === 1
                  ? Effect.succeed("")
                  : Effect.fail(error),
              ),
            )
          const inside = yield* git("rev-parse", "--is-inside-work-tree").pipe(
            Effect.catch((error) =>
              /not a git repository/i.test(error.detail)
                ? Effect.succeed("false")
                : Effect.fail(error),
            ),
          )
          if (inside !== "true") return { kind: "none", message: "Not a Git checkout" } as const
          const localBranch = yield* optional("symbolic-ref", "--quiet", "--short", "HEAD")
          if (!localBranch)
            return { kind: "none", message: "Detached HEAD — check out a branch" } as const
          const [pushRemote, pushDefault, trackingRemote, merge] = yield* Effect.all(
            [
              optional("config", "--get", `branch.${localBranch}.pushRemote`),
              optional("config", "--get", "remote.pushDefault"),
              optional("config", "--get", `branch.${localBranch}.remote`),
              optional("config", "--get", `branch.${localBranch}.merge`),
            ],
            { concurrency: "unbounded" },
          )
          const remotes = (yield* git("remote")).split("\n").filter(Boolean)
          const remote =
            pushRemote ||
            pushDefault ||
            (trackingRemote !== "." ? trackingRemote : "") ||
            (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined)
          if (!remote)
            return yield* new PeekError({
              kind: "unsupported",
              message: "No unambiguous GitHub remote",
            })
          const remoteUrl = yield* git("remote", "get-url", "--push", remote)
          const parsed = parseRemote(remoteUrl)
          if (!parsed)
            return yield* new PeekError({
              kind: "unsupported",
              message: "Remote is not a supported GitHub URL",
            })
          const headBranch =
            remote === trackingRemote && merge.startsWith("refs/heads/")
              ? merge.slice(11)
              : localBranch
          return {
            kind: "branch",
            branch: { directory, localBranch, headBranch, remote, ...parsed },
          } as const
        },
        Effect.mapError((error) =>
          error instanceof PeekError
            ? error
            : new PeekError({
                kind: "git",
                message: "Git checkout unavailable — check its directory and Git installation",
              }),
        ),
      )

      const pulls = Effect.fn("GitHub.pulls")(function* (branch: Branch) {
        const gh = (...args: string[]) =>
          commands
            .run({ binary: "gh", args, cwd: branch.directory })
            .pipe(Effect.mapError(githubError))
        const repo = yield* gh(
          "repo",
          "view",
          `${branch.host}/${branch.repository}`,
          "--json",
          "nameWithOwner,parent,defaultBranchRef",
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Repo))),
          Effect.mapError((error) =>
            error instanceof PeekError
              ? error
              : new PeekError({
                  kind: "invalid-data",
                  message: "Unexpected GitHub repository response",
                }),
          ),
        )
        // Shared default branches can have years of unrelated PR history.
        if (repo.defaultBranchRef?.name === branch.headBranch) return []
        const base = repo.parent?.nameWithOwner ?? repo.nameWithOwner
        const owner = branch.repository.split("/")[0]!
        const endpoint = `repos/${base}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch.headBranch}`)}&per_page=100&sort=updated&direction=desc`
        const pages = yield* gh(
          "api",
          "--hostname",
          branch.host,
          endpoint,
          "--paginate",
          "--slurp",
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Pages))),
          Effect.mapError((error) =>
            error instanceof PeekError
              ? error
              : new PeekError({
                  kind: "invalid-data",
                  message: "Unexpected GitHub pull request response",
                }),
          ),
        )
        const pullRequests = pages
          .flat()
          .filter(
            (pr) =>
              pr.head.ref === branch.headBranch &&
              pr.head.repo?.full_name.toLowerCase() === branch.repository.toLowerCase(),
          )
          .map((pr): PullRequest => ({
            number: pr.number,
            title: pr.title,
            url: `https://${branch.host}/${base}/pull/${pr.number}`,
            state: pr.merged_at
              ? "merged"
              : pr.state === "closed"
                ? "closed"
                : pr.draft
                  ? "draft"
                  : "open",
            updatedAt: pr.updated_at,
          }))
        return yield* Effect.forEach(
          pullRequests,
          (pr) =>
            enrichReview(branch.directory, pr).pipe(Effect.provideService(Commands, commands)),
          { concurrency: 4 },
        )
      })
      return GitHub.of({ checkout, pulls })
    }),
  )
}
