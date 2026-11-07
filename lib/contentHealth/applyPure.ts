import type { ApplySpec, Place } from './analyze'
import { linkKey } from './linkCheck'
import { fixBreaks, rewriteUrls } from './mdxScan'
import { stripTrackingParams } from './tracking'

/**
 * The pure part of applying content health fixes (lib/contentHealth/apply,
 * which re-exports applyToContent): one fix applied to a body and a
 * document held in memory. No store, no network, no writer is reachable
 * from here, so a dry run — an AI content-fix proposal computing exactly
 * the documents a fix would store (lib/ai/plans) — can import it without
 * importing the module that writes.
 */

function getAt(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let cur: any = root
  for (const seg of path) {
    if (cur == null) return undefined
    cur = cur[seg as any]
  }
  return cur
}

function setAt(root: unknown, path: ReadonlyArray<string | number>, value: unknown): void {
  let cur: any = root
  for (const seg of path.slice(0, -1)) cur = cur?.[seg as any]
  if (cur && typeof cur === 'object') cur[path[path.length - 1] as any] = value
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function fragmentOf(raw: string): string {
  const i = raw.indexOf('#')
  return i === -1 ? '' : raw.slice(i)
}

/** The new spelling of a stored or written URL for one fix; null when the fix does not apply to it. */
function rewriteValue(
  spec: ApplySpec,
  raw: string,
  imported: ReadonlyMap<string, string>
): string | null {
  switch (spec.op) {
    case 'strip-tracking':
      return stripTrackingParams(raw)
    case 'use-new-url':
      if (!/^https?:\/\//i.test(raw) || linkKey(raw) !== spec.key) return null
      return fragmentOf(spec.to) ? spec.to : `${spec.to}${fragmentOf(raw)}`
    case 'import-image':
      return imported.get(spec.url) ?? null
    default:
      return null
  }
}

/** Does this URL (as parsed from the body) belong to the fix? */
function matches(spec: ApplySpec, url: string): boolean {
  if (spec.op === 'strip-tracking' || spec.op === 'use-new-url') return linkKey(url) === spec.key
  if (spec.op === 'import-image') return url === spec.url
  return false
}

/**
 * Apply one fix to a body + document in memory. Returns false when there was
 * nothing left to change (the problem is gone).
 */
export function applyToContent(
  spec: ApplySpec,
  state: { body: string; doc: Record<string, any> },
  imported: ReadonlyMap<string, string> = new Map()
): boolean {
  if (spec.op === 'generate-variants') return false
  if (spec.op === 'breaks') {
    const r = fixBreaks(state.body, new Set([spec.fix]))
    state.body = r.body
    return r.changed > 0
  }
  const place: Place = spec.place
  if (place.at === 'body') {
    const r = rewriteUrls(state.body, (url) =>
      matches(spec, url) ? (raw) => rewriteValue(spec, raw, imported) ?? raw : null
    )
    state.body = r.body
    return r.changed > 0
  }
  const current = getAt(state.doc, place.path)
  if (current !== place.value || typeof current !== 'string') return false
  const next = rewriteValue(spec, current, imported)
  if (next === null || next === current) return false
  setAt(state.doc, place.path, next)
  return true
}
