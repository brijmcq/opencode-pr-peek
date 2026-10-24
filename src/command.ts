import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  binary: Schema.String,
  kind: Schema.Literals(["spawn", "exit", "timeout"]),
  detail: Schema.String,
  exitCode: Schema.optionalKey(Schema.Number),
}) {}

export interface CommandInput {
  readonly binary: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly input?: string
  readonly env?: Readonly<Record<string, string>>
}

export class Commands extends Context.Service<
  Commands,
  {
    readonly run: (input: CommandInput) => Effect.Effect<string, CommandError>
  }
>()("opencode-pr-peek/Commands") {
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const run = Effect.fn("Commands.run")(function* (input: CommandInput) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(input.binary, input.args, {
                cwd: input.cwd,
                env: {
                  GH_PROMPT_DISABLED: "1",
                  GIT_TERMINAL_PROMPT: "0",
                  NO_COLOR: "1",
                  ...input.env,
                },
                extendEnv: true,
                stdin:
                  input.input === undefined
                    ? "ignore"
                    : Stream.make(new TextEncoder().encode(input.input)),
                forceKillAfter: "1 second",
              }),
            )
            const [stdout, stderr, code] = yield* Effect.all(
              [
                Stream.runFold(
                  Stream.decodeText(child.stdout),
                  () => "",
                  (a, b) => a + b,
                ),
                Stream.runFold(
                  Stream.decodeText(child.stderr),
                  () => "",
                  (a, b) => a + b,
                ),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            )
            if (code !== 0) {
              return yield* new CommandError({
                binary: input.binary,
                kind: "exit",
                detail: stderr.trim(),
                exitCode: code,
              })
            }
            return stdout.trim()
          }),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof CommandError
              ? cause
              : new CommandError({
                  binary: input.binary,
                  kind: "spawn",
                  detail: String(cause),
                }),
          ),
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () =>
              Effect.fail(
                new CommandError({
                  binary: input.binary,
                  kind: "timeout",
                  detail: "Command timed out",
                }),
              ),
          }),
        )
      })
      return Commands.of({ run })
    }),
  ).pipe(
    Layer.provide(
      NodeChildProcessSpawner.layer.pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      ),
    ),
  )
}
