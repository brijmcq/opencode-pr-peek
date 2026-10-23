import { describe, expect, it } from "vitest"
import { parseOptions } from "../src/options.js"

describe("plugin options", () => {
  it("uses theme colors and the existing layout by default", () => {
    expect(parseOptions({})).toEqual({
      options: {
        compact: false,
        showBranch: true,
        showTitle: true,
        showCopyLink: true,
        showSessionPRs: true,
        maxVisiblePRs: 3,
        localRefreshMs: 5000,
        remoteRefreshMs: 30000,
        colors: {},
      },
      warnings: [],
    })
  })
  it("accepts display settings, intervals, and per-status hex overrides", () => {
    const raw = {
      compact: true,
      showBranch: false,
      showTitle: false,
      showCopyLink: false,
      showSessionPRs: false,
      maxVisiblePRs: 5,
      localRefreshMs: 1000,
      remoteRefreshMs: 60000,
      colors: { open: "#12AbEF", merged: "#a78bfa" },
    }
    expect(parseOptions(raw)).toEqual({ options: raw, warnings: [] })
  })
  it("falls back per setting without discarding valid settings", () => {
    const { options, warnings } = parseOptions({
      compact: "yes",
      showTitle: false,
      maxVisiblePRs: 0,
      localRefreshMs: 0,
      remoteRefreshMs: Infinity,
      colors: { open: "red", draft: "#123456" },
    })
    expect(options).toMatchObject({
      compact: false,
      showTitle: false,
      maxVisiblePRs: 3,
      localRefreshMs: 5000,
      remoteRefreshMs: 30000,
      colors: { draft: "#123456" },
    })
    expect(warnings).toEqual(
      expect.arrayContaining([
        "compact",
        "maxVisiblePRs",
        "localRefreshMs",
        "remoteRefreshMs",
        "colors.open",
      ]),
    )
  })
  it.each([-1, 0, 1.5, 21, NaN, Infinity, "3"])(
    "rejects an invalid visible limit %s",
    (maxVisiblePRs) => {
      expect(parseOptions({ maxVisiblePRs }).options.maxVisiblePRs).toBe(3)
    },
  )
  it.each([null, [], "invalid", 42])("handles malformed options %s", (raw) => {
    expect(parseOptions(raw).warnings).toEqual(["options"])
  })
})
