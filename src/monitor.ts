import { Clock, Effect, Fiber, Queue } from "effect"
import { GitHub } from "./github.js"
import { branchKey, initialState, type PeekState } from "./model.js"

export interface MonitorOptions {
  readonly localRefreshMs: number
  readonly remoteRefreshMs: number
}
export const defaults: MonitorOptions = { localRefreshMs: 5_000, remoteRefreshMs: 30_000 }

// The caller owns the Scope: closing a sidebar or reloading the plugin interrupts
// the ticker, worker, and any child process still doing a lookup.
export const monitor = Effect.fn("monitor")(function* (
  directory: string,
  publish: (state: PeekState) => void,
  onRefresh: (refresh: () => void) => void,
  options: MonitorOptions = defaults,
) {
  const github = yield* GitHub
  const queue = yield* Queue.sliding<void>(1)
  let forced = false
  let currentKey = ""
  let lastLookup = -Infinity
  let generation = 0
  let inFlight = false
  let query: Fiber.Fiber<void> | undefined
  const request = () => {
    forced = true
    Queue.offerUnsafe(queue, undefined)
  }
  yield* Effect.sync(() => {
    publish(initialState)
    onRefresh(request)
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => onRefresh(() => {})))

  const tick = Effect.gen(function* () {
    yield* Queue.take(queue)
    const force = forced
    forced = false
    const checkout = yield* github.checkout(directory).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (query) yield* Fiber.interrupt(query)
          currentKey = ""
          publish({ phase: "error", prs: [], message: error.message })
          return undefined
        }),
      ),
    )
    if (!checkout) return
    if (checkout.kind === "none") {
      if (query) yield* Fiber.interrupt(query)
      currentKey = ""
      publish({ phase: "none", prs: [], message: checkout.message })
      return
    }
    const branch = checkout.branch
    const key = branchKey(branch)
    const changed = key !== currentKey
    const now = yield* Clock.currentTimeMillis
    if (!changed && !force && (inFlight || now - lastLookup < options.remoteRefreshMs)) return
    if (query) yield* Fiber.interrupt(query)
    currentKey = key
    lastLookup = now
    const version = ++generation
    inFlight = true
    if (changed) publish({ phase: "loading", branch, prs: [] })
    query = yield* Effect.forkScoped(
      Effect.gen(function* () {
        const prs = yield* github.pulls(branch)
        const latest = yield* github.checkout(directory)
        if (latest.kind !== "branch" || branchKey(latest.branch) !== key) {
          Queue.offerUnsafe(queue, undefined)
          return
        }
        if (currentKey === key && generation === version) publish({ phase: "ready", branch, prs })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (currentKey === key && generation === version)
              publish({ phase: "error", branch, prs: [], message: error.message })
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (generation === version) inFlight = false
          }),
        ),
      ),
    )
  })
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(options.localRefreshMs)
        yield* Queue.offer(queue, undefined)
      }),
    ),
  )
  yield* Queue.offer(queue, undefined)
  yield* Effect.forever(tick)
})
