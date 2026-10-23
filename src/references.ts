import { referenceKey, type Branch, type PRReference } from "./model.js"

type Repository = Pick<Branch, "host" | "repository">
const pullURL = /https?:\/\/([\w.-]+)\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d{0,9})\b[^\s)\]>"']*/g

export function referenceFromURL(url: string, host: string): PRReference | undefined {
  const match = /^https?:\/\/([\w.-]+)\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d{0,9})(?:[/?#].*)?$/.exec(
    url.replace(/[.,;:!]+$/, ""),
  )
  if (
    !match ||
    (match[1]!.toLowerCase() !== "github.com" && match[1]!.toLowerCase() !== host.toLowerCase())
  )
    return undefined
  return { host: match[1]!.toLowerCase(), repository: match[2]!, number: Number(match[3]) }
}

export function extractReferences(
  texts: ReadonlyArray<string>,
  fallback: Repository,
): PRReference[] {
  const refs = new Map<string, PRReference>()
  const explicit = new Map<string, PRReference>()
  const add = (ref: PRReference) => refs.set(referenceKey(ref), ref)
  // Collect explicit identities first, including links on later history pages.
  for (const text of texts) {
    for (const match of text.matchAll(pullURL)) {
      const ref = referenceFromURL(match[0], fallback.host)
      if (ref) {
        explicit.set(referenceKey(ref), ref)
        add(ref)
      }
    }
    for (const match of text.matchAll(/\b([\w.-]+\/[\w.-]+)\s*#([1-9]\d{0,9})\b/g)) {
      const ref = { host: fallback.host, repository: match[1]!, number: Number(match[2]) }
      explicit.set(referenceKey(ref), ref)
    }
  }
  for (const text of texts) {
    let remaining = text
      // A linked label must not be scanned a second time as a bare number.
      .replace(/\[[^\]]*\]\(https?:\/\/[^\s)]+\/(?:pull|issues)\/\d+[^\s)]*\)/g, "")
      .replace(/https?:\/\/[^\s)\]>"']+/g, "")
    remaining = remaining.replace(
      /\b([\w.-]+\/[\w.-]+)\s*#([1-9]\d{0,9})\b/g,
      (_, repository: string, number: string) => {
        add({ host: fallback.host, repository, number: Number(number) })
        return ""
      },
    )
    remaining = remaining.replace(
      /\b([\w.-]+)\s+#([1-9]\d{0,9})\b/g,
      (whole, alias: string, number: string) => {
        const candidates = [...explicit.values()].filter(
          (ref) =>
            ref.number === Number(number) &&
            ref.repository.split("/").at(-1)?.toLowerCase() === alias.toLowerCase(),
        )
        if (candidates.length === 1) {
          add(candidates[0]!)
          return ""
        }
        return whole
      },
    )
    for (const match of remaining.matchAll(/(?:\bPR\s*#?|(?<![\w/])#)([1-9]\d{0,9})\b/gi)) {
      const number = Number(match[1])
      const candidates = [...explicit.values()].filter((ref) => ref.number === number)
      if (candidates.length === 1) add(candidates[0]!)
      else if (candidates.length === 0) {
        const start = match.index
        const before = remaining.slice(Math.max(0, start - 90), start)
        const after = remaining.slice(start + match[0].length, start + match[0].length + 90)
        const explicitPR = /^PR/i.test(match[0])
        const prContext =
          /\b(?:merged?|merges|merging|conflicts?|pull requests?)\b/i.test(`${before} ${after}`) ||
          /\b(?:review|checkout|check out)\s*$/i.test(before)
        if (explicitPR || prContext)
          add({ host: fallback.host, repository: fallback.repository, number })
      }
      // Ambiguous bare numbers are not evidence for either repository.
    }
  }
  return [...refs.values()]
}
