import { detectContentLang } from '../../../lib/toc'
import { isImeComposing } from '../../../lib/keyboardShortcuts'
import { groupByDay, type DayGroup } from '../system/activityFormat'
import { ASSISTANT_COPY, MODELS_COPY, PROMPT_COPY } from './copy'
import type { RunUsage } from './runState'
import type { AssistantSummary, ConversationListItem, ModelStatus, ProviderView, RunEnd, UsageRow } from './types'

/**
 * Pure helpers of the assistant view and Models (unit tested in
 * tests/ai-assistant-ui): what a run's end means for the owner, the usage
 * line, the language of a message, the suggestions, the composer's keys.
 */

// ── How a run ended ───────────────────────────────────────────────────────

export type EndAction = 'retry' | 'continue' | 'new-chat' | 'models' | 'replace-key' | 'change-limit'

export type EndView = {
  tone: 'info' | 'warning' | 'error'
  /** What it means, in the admin's words. */
  line: string
  /** The server's own words under it (plain text), when they add something. */
  detail: string | null
  /** The provider's own words (scrubbed by the server, plain text), for provider failures. */
  providerSaid: string | null
  action: EndAction | null
}

const detailNum = (d: Record<string, unknown> | undefined, k: string): number | null => (d && typeof d[k] === 'number' ? (d[k] as number) : null)
const detailStr = (d: Record<string, unknown> | undefined, k: string): string | null => (d && typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string) : null)

/**
 * What a run's end means and the one action it offers (PRODUCT §4.12).
 * Null when there is nothing to say (an answer that simply finished).
 */
export function endView(end: RunEnd | null, provider: string): EndView | null {
  if (!end) return null
  const e = ASSISTANT_COPY.end
  const reason = end.reason ?? ''
  const message = end.message
  if (end.state === 'finished' && (reason === 'end' || reason === '')) return null
  if (end.state === 'finished' && reason === 'refusal') return null // the declined turn says it
  if (reason === 'connection') return { tone: 'warning', line: e.connection, detail: null, providerSaid: null, action: null }
  if (end.stored && end.state === 'interrupted') return { tone: 'warning', line: e.interrupted, detail: null, providerSaid: null, action: 'continue' }
  if (end.state === 'interrupted') return { tone: 'warning', line: e.interrupted, detail: null, providerSaid: null, action: 'continue' }
  if (end.state === 'stopped') {
    return { tone: 'info', line: message ?? ASSISTANT_COPY.status.stopped, detail: null, providerSaid: null, action: reason === 'stopped' ? 'retry' : null }
  }
  if (reason === 'max_tokens' || reason === 'steps' || reason === 'paused' || reason === 'time-limit' || reason === 'budget-run') {
    return { tone: 'info', line: message ?? e.unknown, detail: null, providerSaid: null, action: 'continue' }
  }
  if (reason === 'context' || reason === 'budget-conversation' || reason === 'budget-floor') {
    return { tone: 'warning', line: message ?? e.unknown, detail: null, providerSaid: null, action: 'new-chat' }
  }
  if (reason === 'budget-day') return { tone: 'warning', line: message ?? e.unknown, detail: null, providerSaid: null, action: 'change-limit' }
  if (reason === 'loop') return { tone: 'warning', line: message ?? e.unknown, detail: null, providerSaid: null, action: null }
  if (reason === 'provider') {
    const d = end.detail
    const kind = detailStr(d, 'kind') ?? 'unknown'
    const said = detailStr(d, 'providerMessage')
    const retryAfter = detailNum(d, 'retryAfterMs')
    const output = d?.output === true
    const base = { tone: 'error' as const, detail: message, providerSaid: said }
    switch (kind) {
      case 'auth':
      case 'permission':
        return { ...base, line: e.keyRefused(provider), action: 'replace-key' }
      case 'billing':
        return { ...base, line: e.billing(provider), action: 'models' }
      case 'rate_limit':
        return { ...base, tone: 'warning', line: retryAfter ? `${e.rateLimited(provider)} ${e.retryIn(Math.ceil(retryAfter / 1000))}` : e.rateLimited(provider), action: 'retry' }
      case 'overloaded':
        return { ...base, tone: 'warning', line: e.overloaded(provider), action: 'retry' }
      case 'network':
      case 'timeout':
        return { ...base, line: output ? e.dropped : e.noAnswer(provider), action: 'retry' }
      case 'not_found':
        return { ...base, line: e.notFound(provider), action: 'models' }
      case 'blocked':
      case 'config':
        return { ...base, line: e.blocked(provider), action: 'models' }
      case 'bad_request':
      case 'too_large':
        return { ...base, line: e.refused(provider), action: 'retry' }
      default:
        return { ...base, line: output ? e.dropped : e.failed(provider), action: 'retry' }
    }
  }
  if (end.state === 'failed') return { tone: 'error', line: message ?? e.unknown, detail: null, providerSaid: null, action: 'retry' }
  if (end.state === 'limit') return { tone: 'info', line: message ?? e.unknown, detail: null, providerSaid: null, action: 'continue' }
  return message ? { tone: 'info', line: message, detail: null, providerSaid: null, action: null } : null
}

// ── Usage ─────────────────────────────────────────────────────────────────

/** 950 → "950", 2140 → "2.1k", 1_250_000 → "1.3M". */
export function compactCount(n: number): string {
  const v = Math.max(0, Math.round(n))
  if (v < 1000) return String(v)
  if (v < 999_500) return `${(v / 1000).toFixed(v < 9_950 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(v / 1_000_000).toFixed(v < 9_950_000 ? 1 : 0).replace(/\.0$/, '')}M`
}

/**
 * The per-answer line (PRODUCT §8.1 [03]): "↑ 2.1k ↓ 340 · cached 1.8k", in
 * = uncached + cache writes, fields the provider did not return left out,
 * "~" when any call of the answer was estimated.
 */
export function usageLine(u: RunUsage | null): string | null {
  if (!u || u.calls === 0) return null
  const est = u.estimated ? '~' : ''
  const parts = [`↑ ${est}${compactCount(u.usageIn + u.cacheWrite)}`, `↓ ${est}${compactCount(u.usageOut)}`]
  const line = parts.join(' ')
  return u.cachedRead > 0 ? `${line} · ${ASSISTANT_COPY.log.usage.cached} ${compactCount(u.cachedRead)}` : line
}

// ── Language ──────────────────────────────────────────────────────────────

/** The `lang` of a message that is mostly CJK ("zh-Hans", "ja", "ko"); undefined for the admin's English. */
export function messageLang(text: string | null | undefined): string | undefined {
  if (!text || !text.trim()) return undefined
  const lang = detectContentLang({ body: text.slice(0, 4000) })
  return lang === 'en' ? undefined : lang
}

// ── Suggestions ───────────────────────────────────────────────────────────

/** The true facts the suggestions rest on (admin overview and content health); null = unknown, so not shown. */
export type SiteFacts = { drafts: number | null; published: number | null; aboutEmpty: boolean | null; missingAlt: number | null; healthIssues: number | null }

/** The browser's language, as the suggestions use it: Chinese or English. */
export function promptLang(languages: readonly string[] | null | undefined): 'zh' | 'en' {
  const first = (languages ?? []).find((l) => typeof l === 'string' && l.trim())
  return first && /^zh\b/i.test(first) ? 'zh' : 'en'
}

/** Up to four prompts, each only while its fact is true (design §8.4). */
export function suggestedPrompts(facts: SiteFacts, lang: 'zh' | 'en'): string[] {
  const p = PROMPT_COPY[lang]
  const out: string[] = []
  if (facts.drafts !== null && facts.drafts > 0) out.push(p.drafts(facts.drafts))
  if (facts.healthIssues !== null && facts.healthIssues > 0) out.push(p.health(facts.healthIssues))
  if (facts.missingAlt !== null && facts.missingAlt > 0) out.push(p.alt(facts.missingAlt))
  if (facts.aboutEmpty === true) out.push(p.about)
  if (facts.published !== null && facts.published > 0) out.push(p.latest)
  out.push(p.changed)
  return out.slice(0, 4)
}

// ── The conversation rail ─────────────────────────────────────────────────

export function groupConversations(list: readonly ConversationListItem[], now: number): Array<DayGroup<ConversationListItem & { ts: number }>> {
  return groupByDay(
    list.map((c) => ({ ...c, ts: c.updatedAt })),
    now,
  )
}

// ── Models ────────────────────────────────────────────────────────────────

/** A model's status in one or two words ("Ready", "Chat only", "Untested"). */
export function statusLabel(status: ModelStatus | string): string {
  return MODELS_COPY.status[status] ?? MODELS_COPY.status.untested
}

/** The tone of a status chip. */
export function statusTone(status: ModelStatus | string): 'ok' | 'warn' | 'bad' | 'none' {
  if (status === 'ready') return 'ok'
  if (status === 'chat-only' || status === 'untested') return status === 'untested' ? 'none' : 'warn'
  return 'bad'
}

/** What a new chat would use: the default provider, else the only one, else the first. */
export function defaultProvider(providers: readonly ProviderView[], defaultId: string | null): ProviderView | null {
  return providers.find((p) => p.id === defaultId) ?? providers.find((p) => p.isDefault) ?? providers[0] ?? null
}

/** The status of a provider's chosen model (its last Test on this site). */
export function modelStatusOf(p: ProviderView | null): ModelStatus {
  if (!p || !p.defaultModel) return 'untested'
  return p.tests[p.defaultModel]?.status ?? 'untested'
}

// ── The composer's keys ───────────────────────────────────────────────────

export type KeyAction = 'send' | 'stop' | 'recall' | 'none'

/**
 * What a key in the composer does (design §8.4): Enter sends; Shift+Enter is
 * a new line; a key that belongs to an input method's composition never
 * sends (the owner writes Chinese: that Enter confirms the composition); on a
 * touch device Enter is a new line and the button sends; Esc stops a run; ↑
 * in an empty composer recalls the last message. A modifier with Enter
 * (⌘/Ctrl) also sends, as in most chat inputs.
 */
export function composerKey(
  e: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean; keyCode?: number },
  state: { composing: boolean; touch: boolean; running: boolean; empty: boolean },
): KeyAction {
  if (state.composing || isImeComposing(e)) return 'none'
  if (e.key === 'Escape') return state.running ? 'stop' : 'none'
  if (e.key === 'ArrowUp' && state.empty && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) return 'recall'
  if (e.key !== 'Enter') return 'none'
  if (e.shiftKey || e.altKey) return 'none'
  if (state.touch && !e.metaKey && !e.ctrlKey) return 'none'
  return 'send'
}

// ── Usage, per model ──────────────────────────────────────────────────────

export type UsageTotals = {
  key: string
  providerId: string
  providerLabel: string | null
  model: string
  calls: number
  usageIn: number
  cachedRead: number
  cacheWrite: number
  usageOut: number
  reasoning: number
  weighted: number
  /** Null unless every call of every day summed here reported a cost. */
  reportedMicroUsd: number | null
  estimatedCalls: number
}

/** The UTC day of `now` ("2026-11-07"). */
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)

/**
 * Usage rows (one per UTC day, provider and model) summed per provider and
 * model over this UTC month or today, most used first. A cost stays only when
 * every row summed reported one: a partial sum would read as the bill.
 */
export function usageByModel(rows: readonly UsageRow[], period: 'month' | 'today', now: number): UsageTotals[] {
  const day = utcDay(now)
  const month = day.slice(0, 7)
  const out = new Map<string, UsageTotals>()
  for (const r of rows) {
    if (period === 'today' ? r.day !== day : r.day.slice(0, 7) !== month) continue
    const key = JSON.stringify([r.providerId, r.model])
    const t: UsageTotals = out.get(key) ?? {
      key,
      providerId: r.providerId,
      providerLabel: r.providerLabel,
      model: r.model,
      calls: 0,
      usageIn: 0,
      cachedRead: 0,
      cacheWrite: 0,
      usageOut: 0,
      reasoning: 0,
      weighted: 0,
      reportedMicroUsd: 0,
      estimatedCalls: 0,
    }
    t.calls += r.calls
    t.usageIn += r.usageIn
    t.cachedRead += r.cachedRead
    t.cacheWrite += r.cacheWrite
    t.usageOut += r.usageOut
    t.reasoning += r.reasoning
    t.weighted += r.weighted
    t.estimatedCalls += r.estimatedCalls
    t.reportedMicroUsd = t.reportedMicroUsd === null || r.reportedMicroUsd === null ? null : t.reportedMicroUsd + r.reportedMicroUsd
    t.providerLabel = t.providerLabel ?? r.providerLabel
    out.set(key, t)
  }
  return Array.from(out.values()).sort((a, b) => b.weighted - a.weighted || a.model.localeCompare(b.model))
}

/** A reported cost in dollars ("$0.42", "<$0.01"). */
export function formatCost(microUsd: number): string {
  const usd = microUsd / 1_000_000
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

// ── The status strip's Assistant tile ─────────────────────────────────────

/** The Assistant tile (PRODUCT §3): the model new chats use and its state, or that none is set up. */
export function assistantTile(a: AssistantSummary | null): { label: string; value: string; sub: string } {
  const label = MODELS_COPY.strip.assistant
  if (!a) return { label, value: '—', sub: MODELS_COPY.strip.unreadable }
  if (!a.defaultModel) return { label, value: MODELS_COPY.strip.notSetUp, sub: MODELS_COPY.strip.addModel }
  const sub = a.running ? MODELS_COPY.strip.writing : statusLabel(a.defaultModel.status).toLowerCase()
  return { label, value: a.defaultModel.label, sub: a.defaultModel.model ? `${a.defaultModel.model} · ${sub}` : sub }
}
