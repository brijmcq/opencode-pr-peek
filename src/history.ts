import type { Context as PluginContext } from "@opencode/plugin/tui/context"
import { Effect, Queue } from "effect"
import { lookupPR } from "./github.js"
import { referenceKey, type Branch, type PRReference, type PullRequest } from "./model.js"
import { extractReferences, referenceFromURL } from "./references.js"
export { extractReferences } from "./references.js"

type ReadPage = PluginContext["client"]["message"]["list"]
type Message = Awaited<ReturnType<ReadPage>>["data"][number]

export function messageTexts(message: Message): string[] {
  if (message.type === "user") return [message.text]
  if (message.type === "assistant")
    return message.content.flatMap((part) => {
      if (part.type === "text") return [part.text]
      return []
    })
  return []
}

export function createdReferences(message: Message, host: string): PRReference[] {
  if (message.type !== "assistant") return []
  return message.content.flatMap((part) => {
    if (
      part.type !== "tool" ||
      part.name !== "shell" ||
      part.state.status !== "completed" ||
      part.state.metadata?.exit !== 0
    )
      return []
    const command = part.state.input.command
    if (
      typeof command !== "string" ||
      !/^\s*gh\s+pr\s+create(?:\s|$)/.test(command) ||
      /[;&|\n]/.test(command)
    )
      return []
    const output = part.state.content
      .flatMap((content) => (content.type === "text" ? [content.text] : []))
      .join("\n")
      .trim()
    if (!/^https?:\/\/[^\s]+\/pull\/\d+\/?$/.test(output)) return []
    const ref = referenceFromURL(output, host)
    return ref ? [ref] : []
  })
}

export interface SessionPRState {
  readonly prs: ReadonlyArray<PullRequest>
  readonly loading: boolean
  readonly created: ReadonlyArray<string>
  readonly message?: string
}

// Re-read the latest page to catch streamed messages that finish after the scan.
export const monitorSession = Effect.fn("monitorSession")(function* (
  sessionID: string,
  branch: Branch,
  readPage: ReadPage,
  publish: (state: SessionPRState) => void,
  onRefresh: (refresh: () => void) => void,
  intervalMs: number,
  pinned: () => ReadonlyArray<PRReference> = () => [],
) {
  const queue = yield* Queue.sliding<void>(1)
  let cursor: string | undefined
  const evidence = new Map<string, { texts: string[]; created: PRReference[] }>()
  let created: string[] = []
  const resolved = new Map<string, PullRequest>()
  const notPRs = new Set<string>()
  const request = () => {
    Queue.offerUnsafe(queue, undefined)
  }
  yield* Effect.sync(() => {
    onRefresh(request)
    publish({ prs: [], created: [], loading: true })
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => onRefresh(() => {})))
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(intervalMs)
        yield* Queue.offer(queue, undefined)
      }),
    ),
  )
  yield* Queue.offer(queue, undefined)
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* Queue.take(queue)
      yield* Effect.gen(function* () {
        let scanCursor = cursor
        const seenCursors = new Set<string>()
        while (true) {
          const page = yield* Effect.tryPromise({
            try: (signal) =>
              readPage(
                {
                  sessionID,
                  limit: 100,
                  ...(scanCursor ? { cursor: scanCursor } : { order: "asc" }),
                },
                { signal },
              ),
            catch: () => new Error("Could not read this session's PR references"),
          })
          for (const message of page.data)
            evidence.set(message.id, {
              texts: messageTexts(message),
              created: createdReferences(message, branch.host),
            })
          if (page.data.length === 0) break
          cursor = scanCursor
          const next = page.cursor.next ?? undefined
          if (!next || seenCursors.has(next)) break
          seenCursors.add(next)
          scanCursor = next
        }
        const entries = [...evidence.values()]
        const references = new Map(
          extractReferences(
            entries.flatMap((item) => item.texts),
            branch,
          ).map((ref) => [referenceKey(ref), ref]),
        )
        const creationRefs = entries.flatMap((item) => item.created)
        created = [...new Set(creationRefs.map(referenceKey))]
        for (const ref of [...creationRefs, ...pinned()]) references.set(referenceKey(ref), ref)
        for (const key of resolved.keys()) if (!references.has(key)) resolved.delete(key)
        yield* Effect.forEach(
          [...references],
          ([key, ref]) =>
            Effect.gen(function* () {
              if (notPRs.has(key)) return
              const pr = yield* lookupPR(branch.directory, ref)
              if (pr) resolved.set(key, pr)
              else {
                notPRs.add(key)
                resolved.delete(key)
              }
            }),
          { concurrency: 4 },
        )
        publish({ prs: [...resolved.values()], created, loading: false })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            publish({
              prs: [...resolved.values()],
              created,
              loading: false,
              message: resolved.size ? `${error.message}. Showing last results.` : error.message,
            }),
          ),
        ),
      )
    }),
  )
})
