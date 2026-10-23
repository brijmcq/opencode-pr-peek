import { Exit, Schema } from "effect"
import type { PullRequest } from "./model.js"
import { defaults as refreshDefaults } from "./monitor.js"

const RecordOptions = Schema.Record(Schema.String, Schema.Unknown)
const HexColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))
const Count = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 20 }))
const LocalInterval = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1_000, maximum: 3_600_000 }),
)
const RemoteInterval = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 5_000, maximum: 3_600_000 }),
)

export interface PeekOptions {
  readonly compact: boolean
  readonly showBranch: boolean
  readonly showTitle: boolean
  readonly showCopyLink: boolean
  readonly showSessionPRs: boolean
  readonly maxVisiblePRs: number
  readonly localRefreshMs: number
  readonly remoteRefreshMs: number
  readonly colors: Readonly<Partial<Record<PullRequest["state"], string>>>
}

export function parseOptions(input: unknown): { options: PeekOptions; warnings: string[] } {
  const warnings: string[] = []
  function read<S extends Schema.ConstraintDecoder<unknown>>(
    value: unknown,
    schema: S,
    fallback: S["Type"],
    name: string,
  ): S["Type"] {
    if (value === undefined) return fallback
    const decoded = Schema.decodeUnknownExit(schema)(value)
    if (Exit.isSuccess(decoded)) return decoded.value
    warnings.push(name)
    return fallback
  }
  const raw = read(input, RecordOptions, {}, "options")
  const colors = read(raw.colors, RecordOptions, {}, "colors")
  const parsedColors: Partial<Record<PullRequest["state"], string>> = {}
  for (const state of ["open", "draft", "merged", "closed"] as const) {
    const color = read(
      colors[state],
      Schema.Union([HexColor, Schema.Undefined]),
      undefined,
      `colors.${state}`,
    )
    if (color !== undefined) parsedColors[state] = color
  }
  return {
    options: {
      compact: read(raw.compact, Schema.Boolean, false, "compact"),
      showBranch: read(raw.showBranch, Schema.Boolean, true, "showBranch"),
      showTitle: read(raw.showTitle, Schema.Boolean, true, "showTitle"),
      showCopyLink: read(raw.showCopyLink, Schema.Boolean, true, "showCopyLink"),
      showSessionPRs: read(raw.showSessionPRs, Schema.Boolean, true, "showSessionPRs"),
      maxVisiblePRs: read(raw.maxVisiblePRs, Count, 3, "maxVisiblePRs"),
      localRefreshMs: read(
        raw.localRefreshMs,
        LocalInterval,
        refreshDefaults.localRefreshMs,
        "localRefreshMs",
      ),
      remoteRefreshMs: read(
        raw.remoteRefreshMs,
        RemoteInterval,
        refreshDefaults.remoteRefreshMs,
        "remoteRefreshMs",
      ),
      colors: parsedColors,
    },
    warnings,
  }
}
