/**
 * The Changes view's lists as data (pure, unit-tested): which list a
 * segment and its filters show, the address of each page of it, and how an
 * answer from the server lands. Every page is tagged with the list it
 * answers, so a late answer for another segment, filter or page can never
 * replace or extend the list on screen, and a list is only shown under the
 * segment and filters it was loaded for (never for a frame under a tab just
 * chosen).
 */

export type ChangesSegment = 'waiting' | 'done' | 'calls'

export type ListQuery = { segment: ChangesSegment; app: string; area: string }

/** One loaded list: the key of the query it answers, its rows so far, and the cursor of its next page. */
export type ListPage<T> = { key: string; rows: T[]; cursor: string | null }

/** An answer from the server: the key of the query it was asked for, and the cursor it was asked from (null: the first page). */
export type ListAnswer<T> = { key: string; from: string | null; rows: T[]; cursor: string | null }

/** Two queries with the same key show the same list. All calls has no area filter. */
export function listKey(q: ListQuery): string {
  return JSON.stringify(q.segment === 'calls' ? ['calls', q.app] : [q.segment, q.app, q.area])
}

/** The address of one page of a list (first page: `from` null). */
export function listUrl(q: ListQuery, from: string | null): string {
  const params = new URLSearchParams()
  if (q.segment !== 'calls') params.set('state', q.segment)
  if (q.app) params.set('app', q.app)
  if (q.segment !== 'calls' && q.area) params.set('area', q.area)
  if (from) params.set('cursor', from)
  const s = params.toString()
  return `${q.segment === 'calls' ? '/api/admin/ai/calls' : '/api/admin/ai/changes'}${s ? `?${s}` : ''}`
}

/**
 * The list after an answer arrives, while `current` is the key of the list
 * on screen. An answer for another list is dropped. A first page replaces
 * the list. A next page extends it only when it continues exactly the list
 * shown (same key, asked from its cursor); anything else is dropped.
 */
export function receivePage<T>(shown: ListPage<T> | null, current: string, answer: ListAnswer<T>): ListPage<T> | null {
  if (answer.key !== current) return shown
  if (answer.from === null) return { key: answer.key, rows: answer.rows, cursor: answer.cursor }
  if (!shown || shown.key !== current || shown.cursor !== answer.from) return shown
  return { key: current, rows: [...shown.rows, ...answer.rows], cursor: answer.cursor }
}

/** The rows to show for the list `key`: null (still loading) unless the loaded list is that one. */
export function shownRows<T>(page: ListPage<T> | null, key: string): T[] | null {
  return page && page.key === key ? page.rows : null
}

/** The cursor of the next page of the list `key`, if that list is the one loaded. */
export function shownCursor<T>(page: ListPage<T> | null, key: string): string | null {
  return page && page.key === key ? page.cursor : null
}
