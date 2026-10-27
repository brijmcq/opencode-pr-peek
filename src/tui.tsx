/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { Effect, Layer, ManagedRuntime } from "effect"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { Commands } from "./command.js"
import { GitHub } from "./github.js"
import { copyPR, linkOpenMode, openPR } from "./actions.js"
import { cleanLabel, initialState, type PeekState, type PullRequest } from "./model.js"
import { monitor } from "./monitor.js"
import { parseOptions, type PeekOptions } from "./options.js"
import { monitorSession, type SessionPRState } from "./history.js"
import {
  classifyPRs,
  prKey,
  prLabel,
  prRepository,
  sessionChoicesKey,
  type SessionChoices,
} from "./classification.js"
import { referenceFromURL } from "./references.js"
import { reviewPresentation } from "./review.js"

function createRuntime() {
  return ManagedRuntime.make(GitHub.layer.pipe(Layer.provideMerge(Commands.layer)))
}
type Runtime = ReturnType<typeof createRuntime>

function Sidebar(props: { sessionID: string; runtime: Runtime; options: PeekOptions }) {
  const ctx = usePlugin()
  const openMode = linkOpenMode()
  const terminalLinkHint =
    openMode === "herdr"
      ? "Use your Herdr client's open-link gesture (Command+click on Mac) to open the PR locally."
      : "Use your terminal's open-link gesture to open the PR on your computer."
  const [state, setState] = createSignal<PeekState>(initialState)
  const [refresh, setRefresh] = createSignal<() => void>(() => {})
  const [sessionRefresh, setSessionRefresh] = createSignal<() => void>(() => {})
  const [sessionState, setSessionState] = createSignal<SessionPRState>({
    prs: [],
    created: [],
    loading: false,
  })
  const [relatedOpen, setRelatedOpen] = createSignal(false)
  const savedChoices = ctx.storage.store<SessionChoices>(sessionChoicesKey(props.sessionID), {
    initial: { pinned: {}, hidden: {} },
  })
  const choices = () => savedChoices
  const directory = createMemo(() => ctx.data.session.get(props.sessionID)?.location.directory)
  const classified = createMemo(() =>
    classifyPRs(state().prs, sessionState().prs, sessionState().created, choices()[0]),
  )
  const groups = () => classified().working
  const related = () => classified().related
  const allVisible = () => [...groups().active, ...groups().previous, ...related()]
  const sessionSource = createMemo(() => {
    const branch = state().branch
    return (props.options.showSessionPRs || Object.keys(choices()[0].pinned).length > 0) && branch
      ? JSON.stringify([props.sessionID, branch.directory, branch.host, branch.repository])
      : undefined
  })
  const refreshAll = () => {
    refresh()()
    sessionRefresh()()
  }
  const isViewed = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" && route.sessionID === props.sessionID
  }

  createEffect(() => {
    const cwd = directory()
    props.sessionID
    setRelatedOpen(false)
    if (!cwd) {
      setState(initialState)
      return
    }
    const controller = new AbortController()
    // runPromise's AbortSignal interrupts the entire Effect scope on unmount.
    const running = props.runtime.runPromise(
      Effect.scoped(monitor(cwd, setState, (fn) => setRefresh(() => fn), props.options)).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            if (!controller.signal.aborted)
              setState({
                phase: "error",
                prs: [],
                message: "PR monitor failed — reload the plugin",
              })
          }),
        ),
      ),
      { signal: controller.signal },
    )
    void running.catch(() => {})
    onCleanup(() => controller.abort())
  })

  createEffect(() => {
    const source = sessionSource()
    setSessionState({ prs: [], created: [], loading: false })
    if (!source) return
    const branch = untrack(() => state().branch)
    if (!branch) return
    const controller = new AbortController()
    const running = props.runtime.runPromise(
      Effect.scoped(
        monitorSession(
          props.sessionID,
          branch,
          (input, request) =>
            props.options.showSessionPRs
              ? ctx.client.message.list(input, request)
              : Promise.resolve({ data: [], cursor: {} }),
          setSessionState,
          (fn) => setSessionRefresh(() => fn),
          props.options.remoteRefreshMs,
          () =>
            Object.values(choices()[0].pinned).flatMap((pr) => {
              const ref = referenceFromURL(pr.url, branch.host)
              return ref ? [ref] : []
            }),
        ),
      ).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            if (!controller.signal.aborted)
              setSessionState({
                prs: [],
                created: [],
                loading: false,
                message: "Could not read this session's PR references",
              })
          }),
        ),
      ),
      { signal: controller.signal },
    )
    void running.catch(() => {})
    onCleanup(() => controller.abort())
  })

  const stop = ctx.data.on("session.execution.succeeded", (event) => {
    if (event.data.sessionID === props.sessionID) refreshAll()
  })
  const stopFailed = ctx.data.on("session.execution.failed", (event) => {
    if (event.data.sessionID === props.sessionID) refreshAll()
  })
  const stopBranch = ctx.data.on("vcs.branch.updated", (event) => {
    if (event.location?.directory === directory()) refresh()()
  })
  onCleanup(() => {
    stop()
    stopFailed()
    stopBranch()
  })

  async function act(pr: PullRequest, action: "open" | "copy") {
    const cwd = directory()
    if (!cwd) return
    await props.runtime
      .runPromise(
        Effect.gen(function* () {
          if (action === "open") return yield* openPR(cwd, pr.url)
          yield* copyPR(cwd, pr.url)
        }).pipe(
          Effect.match({
            onFailure: () =>
              ctx.ui.toast.show({
                variant: "error",
                message:
                  action === "open"
                    ? "Could not open browser"
                    : "Could not copy link — install a clipboard utility",
              }),
            onSuccess: (mode) => {
              if (action === "copy")
                ctx.ui.toast.show({ variant: "success", message: "PR link copied" })
              else if (mode === "herdr" || mode === "terminal") {
                ctx.ui.dialog.set({ size: "large" })
                ctx.ui.dialog.show(() => (
                  <box flexDirection="column" padding={1} gap={1}>
                    <text fg={ctx.theme.text.base}>
                      <b>Open pull request</b>
                    </text>
                    <text fg={ctx.theme.text.muted}>{terminalLinkHint}</text>
                    <text fg={ctx.theme.hue.accent[500]}>
                      <a href={pr.url}>{pr.url}</a>
                    </text>
                    <text fg={ctx.theme.text.muted}>Escape to close</text>
                  </box>
                ))
              }
            },
          }),
        ),
      )
      .catch(() => {})
  }

  async function saveChoice(pr: PullRequest, action: "pin" | "unpin" | "hide" | "restore") {
    try {
      await choices()[1]((draft) => {
        const key = prKey(pr)
        if (action === "pin") {
          draft.pinned[key] = { ...pr }
          delete draft.hidden[key]
        }
        if (action === "unpin") delete draft.pinned[key]
        if (action === "hide") draft.hidden[key] = { ...pr }
        if (action === "restore") delete draft.hidden[key]
      })
      sessionRefresh()()
    } catch {
      ctx.ui.toast.show({ variant: "error", message: "Could not save this session's PR choices" })
    }
  }

  async function choose(action: "open" | "copy" | "pin" | "unpin" | "hide" | "restore") {
    const prs =
      action === "restore"
        ? Object.values(choices()[0].hidden)
        : action === "unpin"
          ? Object.values(choices()[0].pinned)
          : allVisible()
    const pr =
      prs.length === 1
        ? prs[0]
        : await ctx.ui.dialog.select({
            title: {
              open: "Open pull request",
              copy: "Copy PR link",
              pin: "Pin to working PRs",
              unpin: "Unpin PR",
              hide: "Hide PR",
              restore: "Restore hidden PR",
            }[action],
            options: prs.map((pr) => ({
              title: `${prLabel(pr)} ${cleanLabel(pr.title)}`,
              description: [prRepository(pr), pr.state, reviewPresentation(pr)?.label]
                .filter(Boolean)
                .join(" · "),
              value: pr,
            })),
          })
    if (pr) {
      if (action === "open" || action === "copy") await act(pr, action)
      else await saveChoice(pr, action)
    }
  }

  ctx.keymap.layer(() => ({
    mode: "global",
    enabled: isViewed,
    commands: [
      {
        id: "pr-peek.refresh",
        title: "PR Peek: Refresh",
        group: "PR Peek",
        palette: true,
        slash: { name: "pr-refresh" },
        run: refreshAll,
      },
      {
        id: "pr-peek.open",
        title: "PR Peek: Open pull request",
        group: "PR Peek",
        palette: true,
        slash: { name: "pr-open" },
        enabled: () => allVisible().length > 0,
        run: () => choose("open"),
      },
      {
        id: "pr-peek.copy",
        title: "PR Peek: Copy PR link",
        group: "PR Peek",
        palette: true,
        slash: { name: "pr-copy" },
        enabled: () => allVisible().length > 0,
        run: () => choose("copy"),
      },
      ...(["pin", "unpin", "hide", "restore"] as const).map((action) => ({
        id: `pr-peek.${action}`,
        title: {
          pin: "PR Peek: Pin to working PRs",
          unpin: "PR Peek: Unpin PR",
          hide: "PR Peek: Hide PR",
          restore: "PR Peek: Restore hidden PR",
        }[action],
        group: "PR Peek",
        palette: true as const,
        slash: { name: `pr-${action}` },
        enabled: () =>
          action === "restore"
            ? Object.keys(choices()[0].hidden).length > 0
            : action === "unpin"
              ? Object.keys(choices()[0].pinned).length > 0
              : allVisible().length > 0,
        run: () => choose(action),
      })),
    ],
  }))

  function PRList(list: { prs: ReadonlyArray<PullRequest>; related?: boolean }) {
    const [all, setAll] = createSignal(false)
    createEffect(() => {
      props.sessionID
      setAll(false)
    })
    return (
      <box flexDirection="column">
        <For each={all() ? list.prs : list.prs.slice(0, props.options.maxVisiblePRs)}>
          {(pr) => <Row pr={pr} related={list.related} />}
        </For>
        <Show when={list.prs.length > props.options.maxVisiblePRs}>
          <box
            marginTop={props.options.compact ? 0 : 1}
            onMouseUp={(event) => {
              if (event.button === 0) setAll(!all())
            }}
          >
            <text fg={ctx.theme.text.muted}>
              {all() ? "Show fewer" : `Show ${list.prs.length - props.options.maxVisiblePRs} more`}
            </text>
          </box>
        </Show>
      </box>
    )
  }

  function Row(row: { pr: PullRequest; related?: boolean }) {
    const [hovered, setHovered] = createSignal(false)
    const review = () => reviewPresentation(row.pr)
    const reviewColor = () =>
      ({
        positive: ctx.theme.text.feedback.success.base,
        negative: ctx.theme.text.feedback.error.base,
        warning: ctx.theme.text.feedback.warning.base,
        muted: ctx.theme.text.muted,
      })[review()?.tone ?? "muted"]
    const color = () =>
      props.options.colors[row.pr.state] ??
      {
        open: ctx.theme.text.feedback.success.base,
        draft: ctx.theme.text.muted,
        merged: ctx.theme.hue.accent[500],
        closed: ctx.theme.text.feedback.error.base,
      }[row.pr.state]
    return (
      <box flexDirection="column" marginTop={props.options.compact ? 0 : 1}>
        <box
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
          onMouseUp={(event) => {
            if (
              event.button === 0 &&
              !event.modifiers.ctrl &&
              !event.modifiers.alt &&
              !event.modifiers.shift
            )
              void act(row.pr, "open")
          }}
        >
          <text fg={hovered() ? ctx.theme.text.base : color()} wrapMode="none" overflow="hidden">
            <a href={row.pr.url}>
              {`${prLabel(row.pr)} · ${row.pr.state} ↗${props.options.compact && props.options.showTitle ? ` ${cleanLabel(row.pr.title)}` : ""}`}
            </a>
          </text>
          <Show when={props.options.showTitle && !props.options.compact}>
            <text fg={ctx.theme.text.muted} wrapMode="none" overflow="hidden">
              <a href={row.pr.url}>{cleanLabel(row.pr.title)}</a>
            </text>
          </Show>
          <Show when={review()}>
            {(status) => (
              <text fg={reviewColor()} wrapMode="none" overflow="hidden">
                {status().label}
              </text>
            )}
          </Show>
        </box>
        <box flexDirection="row" gap={2}>
          <Show when={props.options.showCopyLink}>
            <box
              onMouseUp={(event) => {
                if (event.button === 0) void act(row.pr, "copy")
              }}
            >
              <text fg={ctx.theme.text.muted}>Copy link</text>
            </box>
          </Show>
          <Show when={row.related || choices()[0].pinned[prKey(row.pr)]}>
            <box
              onMouseUp={(event) => {
                if (event.button === 0)
                  void saveChoice(row.pr, choices()[0].pinned[prKey(row.pr)] ? "unpin" : "pin")
              }}
            >
              <text fg={ctx.theme.text.muted}>
                {choices()[0].pinned[prKey(row.pr)] ? "Unpin" : "Pin"}
              </text>
            </box>
          </Show>
          <box
            onMouseUp={(event) => {
              if (event.button === 0) void saveChoice(row.pr, "hide")
            }}
          >
            <text fg={ctx.theme.text.muted}>Hide</text>
          </box>
        </box>
      </box>
    )
  }

  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={ctx.theme.text.base}>
          <b>Working PRs</b>
        </text>
        <box
          onMouseUp={(event) => {
            if (event.button === 0) refreshAll()
          }}
        >
          <text fg={ctx.theme.text.muted}>↻ Refresh</text>
        </box>
      </box>
      <Show when={props.options.showBranch && state().branch}>
        {(branch) => (
          <text fg={ctx.theme.text.muted} wrapMode="none">
            {cleanLabel(branch().localBranch)}
          </text>
        )}
      </Show>
      <Show when={openMode !== "desktop"}>
        <text fg={ctx.theme.text.muted}>
          {openMode === "herdr"
            ? "Open locally: Command+click on Mac"
            : "Open links via your terminal"}
        </text>
      </Show>
      <Show when={state().phase === "loading"}>
        <text fg={ctx.theme.text.muted}>Looking up PRs…</text>
      </Show>
      <Show when={state().message}>
        <text fg={ctx.theme.text.muted}>{state().message}</text>
      </Show>
      <Show
        when={
          state().phase === "ready" &&
          groups().active.length === 0 &&
          groups().previous.length === 0
        }
      >
        <text fg={ctx.theme.text.muted}>No working PRs</text>
      </Show>
      <PRList prs={[...groups().active, ...groups().previous]} />
      <Show
        when={
          (props.options.showSessionPRs || Object.keys(choices()[0].pinned).length > 0) &&
          (related().length > 0 || sessionState().loading || sessionState().message)
        }
      >
        <box
          marginTop={1}
          onMouseUp={(event) => {
            if (event.button === 0) setRelatedOpen(!relatedOpen())
          }}
        >
          <text
            fg={ctx.theme.text.muted}
          >{`${relatedOpen() ? "▾" : "▸"} Related PRs (${related().length})`}</text>
        </box>
        <Show when={sessionState().loading}>
          <text fg={ctx.theme.text.muted}>Looking up related PRs…</text>
        </Show>
        <Show when={sessionState().message}>
          <text fg={ctx.theme.text.muted}>{sessionState().message}</text>
        </Show>
        <Show when={relatedOpen()}>
          <PRList prs={related()} related />
        </Show>
      </Show>
      <Show when={Object.keys(choices()[0].hidden).length > 0}>
        <box
          marginTop={1}
          onMouseUp={(event) => {
            if (event.button === 0) void choose("restore")
          }}
        >
          <text
            fg={ctx.theme.text.muted}
          >{`Restore hidden PRs (${Object.keys(choices()[0].hidden).length})`}</text>
        </box>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-pr-peek",
  setup(ctx) {
    const { options, warnings } = parseOptions(ctx.options)
    if (warnings.length)
      ctx.ui.toast.show({
        variant: "warning",
        message: `PR Peek used defaults for invalid settings: ${warnings.join(", ")}`,
      })
    const runtime = createRuntime()
    const remove = ctx.ui.slot({
      prepend: "sidebar.content",
      render: (input) => (
        <Show when={input.sessionID} keyed>
          {(sessionID) => <Sidebar sessionID={sessionID} runtime={runtime} options={options} />}
        </Show>
      ),
    })
    return async () => {
      remove()
      await runtime.dispose()
    }
  },
})
