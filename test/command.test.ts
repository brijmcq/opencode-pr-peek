import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Commands } from "../src/command.js"
import { opener } from "../src/actions.js"

const cwd = process.cwd()
const run = (args: string[], input?: string) =>
  Effect.runPromise(
    Effect.flatMap(Commands, (commands) =>
      commands.run({ binary: process.execPath, args, cwd, input }),
    ).pipe(Effect.provide(Commands.layer)),
  )

describe("scoped process runner", () => {
  it("collects stdout without leaking stderr into the TUI", async () => {
    expect(await run(["-e", "console.log('hello'); console.error('diagnostic')"])).toBe("hello")
  })
  it("retains the exit code and stderr for classification", async () => {
    await expect(
      run(["-e", "console.error('auth needed'); process.exit(4)"]),
    ).rejects.toMatchObject({ exitCode: 4, kind: "exit", detail: "auth needed" })
  })
  it("passes clipboard content through stdin, not a shell", async () => {
    const input = "https://github.com/team/app/pull/1?x=$(touch unwanted)"
    expect(await run(["-e", "process.stdin.pipe(process.stdout)"], input)).toBe(input)
  })
  it("distinguishes missing executables", async () => {
    const result = Effect.flatMap(Commands, (commands) =>
      commands.run({ binary: "pr-peek-nonexistent-command", args: [], cwd }),
    ).pipe(
      Effect.provide(Commands.layer),
      Effect.catch((error) => Effect.succeed(error)),
    )
    expect(await Effect.runPromise(result)).toMatchObject({ kind: "spawn" })
  })
  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
    ["win32", "rundll32.exe"],
  ] as const)("opens links on %s without shell interpolation", (platform, binary) => {
    const url = "https://github.com/team/app/pull/1"
    expect(opener(platform, url)).toMatchObject({ binary, args: expect.arrayContaining([url]) })
  })
})
