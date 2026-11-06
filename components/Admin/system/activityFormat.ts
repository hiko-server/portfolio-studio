/**
 * Pure helpers of the Activity view (unit tested).
 */

export type DayGroup<T> = { key: string; label: string; items: T[] }

const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "Today", "Yesterday", or "Mon 6 Oct" / "6 Oct 2025" (local time; older years carry the year). */
export function dayLabel(ms: number, now: number): string {
  const key = dayKey(ms)
  if (key === dayKey(now)) return 'Today'
  if (key === dayKey(now - 86_400_000)) return 'Yesterday'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat('en-GB', sameYear ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

/** Items (newest first) grouped by local calendar day, order kept. */
export function groupByDay<T extends { ts: number }>(items: readonly T[], now: number): DayGroup<T>[] {
  const out: DayGroup<T>[] = []
  for (const item of items) {
    const key = dayKey(item.ts)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(item)
    else out.push({ key, label: dayLabel(item.ts, now), items: [item] })
  }
  return out
}

/** "14:05" in local time. */
export function clockTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(ms)
}

/** "Chrome on macOS · 203.0.113.x · HK" — whatever is known, never more. */
export function actorLine(a: { device: string | null; ipPrefix: string | null; country: string | null }): string {
  return [a.device, a.ipPrefix && a.ipPrefix !== 'loopback' ? a.ipPrefix : a.ipPrefix === 'loopback' ? 'this server' : null, a.country]
    .filter(Boolean)
    .join(' · ')
}

export type ActivityFilterOption = { value: string; label: string }

/** The select value that keeps only the changes AI made (any area). */
export const AI_ACTOR_FILTER = 'actor:ai'

/** Whether the kept log holds anything for the AI choices (ActivityPage.aiRetained). */
export type AiRetained = { writes: boolean; area: boolean }

/**
 * The Activity view's "Show activity for" choices: every area (sign-ins
 * last), each with its 30-day count. The AI choices — the "AI access" area
 * and "Changes made by AI" — appear whenever the kept log has something for
 * them, however old (or while one is selected), so a site that never turned
 * AI on shows no AI filter at all, and an AI write 300 days old can still be
 * found.
 */
export function activityFilterOptions(
  areas: readonly string[],
  labels: Readonly<Record<string, string>>,
  counts: Readonly<Record<string, number>>,
  aiCount: number,
  selected: string,
  retained: AiRetained = { writes: false, area: false },
): ActivityFilterOption[] {
  const ordered = [...areas.filter((a) => a !== 'session'), ...areas.filter((a) => a === 'session')]
  const out: ActivityFilterOption[] = []
  for (const a of ordered) {
    if (a === 'ai' && !counts.ai && !retained.area && selected !== 'ai') continue
    out.push({ value: a, label: `${labels[a] || a}${counts[a] ? ` (${counts[a]} in 30 days)` : ''}` })
  }
  if (aiCount > 0 || retained.writes || selected === AI_ACTOR_FILTER) {
    out.push({ value: AI_ACTOR_FILTER, label: `Changes made by AI${aiCount ? ` (${aiCount} in 30 days)` : ''}` })
  }
  return out
}

/** The query parameters for a "Show activity for" value. */
export function activityFilterParams(value: string): { area?: string; actor?: 'ai' } {
  if (!value) return {}
  return value === AI_ACTOR_FILTER ? { actor: 'ai' } : { area: value }
}
