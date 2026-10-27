import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { linkOpenMode, opener, openPR } from "../src/actions.js"
import { Commands, type CommandInput } from "../src/command.js"

const directory = "/work/repo"
const url = "https://github.com/team/app/pull/1"

describe("browser opening location", () => {
  it.each([
    [{ HERDR_ENV: "1" }, "herdr"],
    [{ TERM_PROGRAM: "herdr" }, "herdr"],
    [{ HERDR_ENV: "1", SSH_CONNECTION: "remote connection" }, "herdr"],
    [{ SSH_CONNECTION: "remote connection", DISPLAY: ":0" }, "terminal"],
    [{ SSH_CLIENT: "remote client" }, "terminal"],
    [{ SSH_TTY: "/dev/pts/1" }, "terminal"],
    [{}, "desktop"],
    [{ TERM_PROGRAM: "ghostty", DISPLAY: ":0" }, "desktop"],
  ] as const)("selects the opening mode for %j", (env, mode) => {
    expect(linkOpenMode(env)).toBe(mode)
  })

  it.each([
    { HERDR_ENV: "1" },
    { TERM_PROGRAM: "herdr" },
    { SSH_CONNECTION: "remote connection", DISPLAY: ":0" },
    { SSH_CLIENT: "remote client" },
    { SSH_TTY: "/dev/pts/1" },
  ])("does not launch a host browser in SSH or Herdr: %j", async (env) => {
    const calls: CommandInput[] = []
    const result = await Effect.runPromise(
      openPR(directory, url, env).pipe(
        Effect.provideService(
          Commands,
          Commands.of({
            run: (input) => {
              calls.push(input)
              return Effect.succeed("")
            },
          }),
        ),
      ),
    )
    expect(result).toBe(linkOpenMode(env))
    expect(calls).toEqual([])
  })

  it("preserves ordinary local browser opening", async () => {
    const calls: CommandInput[] = []
    const result = await Effect.runPromise(
      openPR(directory, url, {}).pipe(
        Effect.provideService(
          Commands,
          Commands.of({
            run: (input) => {
              calls.push(input)
              return Effect.succeed("")
            },
          }),
        ),
      ),
    )
    expect(result).toBe("desktop")
    expect(calls).toEqual([{ ...opener(process.platform, url), cwd: directory }])
  })
})
