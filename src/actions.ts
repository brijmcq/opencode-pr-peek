import { Effect } from "effect"
import { Commands } from "./command.js"

export function opener(platform: NodeJS.Platform, url: string): { binary: string; args: string[] } {
  if (platform === "darwin") return { binary: "open", args: [url] }
  if (platform === "win32")
    return { binary: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
  return { binary: "xdg-open", args: [url] }
}

export const openPR = Effect.fn("openPR")(function* (directory: string, url: string) {
  const commands = yield* Commands
  yield* commands.run({ ...opener(process.platform, url), cwd: directory })
})

export const copyPR = Effect.fn("copyPR")(function* (directory: string, url: string) {
  const commands = yield* Commands
  if (process.platform === "darwin") {
    yield* commands.run({ binary: "pbcopy", args: [], cwd: directory, input: url })
  } else if (process.platform === "win32") {
    yield* commands.run({ binary: "clip.exe", args: [], cwd: directory, input: url })
  } else {
    yield* commands.run({ binary: "wl-copy", args: [], cwd: directory, input: url }).pipe(
      Effect.catch(() =>
        commands.run({
          binary: "xclip",
          args: ["-selection", "clipboard"],
          cwd: directory,
          input: url,
        }),
      ),
    )
  }
})
