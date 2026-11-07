import crypto from 'node:crypto'

/**
 * The Chat Completions delta reducer (SERVER-ONLY, design §7.1, PROVIDERS
 * §4.3): ONE generic merge for every dialect, keeping the fields it does not
 * know. That is what lets DeepSeek's `reasoning_content`, Ollama's
 * `reasoning`, OpenRouter's `reasoning_details`, Gemini's
 * `extra_content.google.thought_signature` on a tool call and Mistral's
 * ThinkChunk lists all replay with no per-provider code. For every key:
 *
 *   string      concatenated — except `role`, `id`, `type` and a tool call's
 *               `function.name`, where the first non-empty value wins
 *   array       with `index`: merged by index; without: appended
 *   object      merged deeply
 *   null, ""    ignored
 *
 * Two keys have their own rule, because their shape is the replay format:
 *
 *   tool_calls  one slot per call, keyed by `index`, else `id`, else arrival
 *               (a different non-empty id at the same index starts a new
 *               call; fragments may carry `id: ""` and `name: null`; a whole
 *               call may arrive in one chunk). A call with no id gets
 *               `call_<uuid>` once, and that id is what is echoed.
 *   content     a string, or (Mistral) a list of chunks: adjacent chunks of
 *               one type merge into one, so the replay is the list the
 *               provider meant, not one entry per fragment.
 */

const FIRST_WINS = new Set(['role', 'id', 'type'])

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const empty = (v: unknown) => v === null || v === undefined || v === ''

/** Deep copy of plain JSON (deltas are parsed JSON, so this is safe and keeps the result independent of them). */
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

function mergeInto(target: Obj, delta: Obj, firstWins: (key: string) => boolean): void {
  for (const [key, value] of Object.entries(delta)) {
    // Prototype keys can never become fields of the replayed message.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (empty(value)) continue
    const current = target[key]
    if (typeof value === 'string') {
      if (typeof current === 'string' && current !== '') target[key] = firstWins(key) ? current : current + value
      else target[key] = value
    } else if (Array.isArray(value)) {
      target[key] = mergeArray(Array.isArray(current) ? current : [], value)
    } else if (isObj(value)) {
      const into = isObj(current) ? current : {}
      mergeInto(into, value, (k) => FIRST_WINS.has(k))
      target[key] = into
    } else {
      target[key] = value
    }
  }
}

function mergeArray(current: Json[], delta: Json[]): Json[] {
  const out = current
  for (const item of delta) {
    if (isObj(item) && typeof item.index === 'number') {
      const at = out.findIndex((x) => isObj(x) && x.index === item.index)
      if (at >= 0) mergeInto(out[at] as Obj, item, (k) => FIRST_WINS.has(k))
      else out.push(clone(item))
    } else if (!empty(item)) {
      out.push(clone(item))
    }
  }
  return out
}

/** Mistral's chunk lists: adjacent chunks of one type merge (their text concatenated, nested lists likewise). */
function mergeChunkList(current: Json[], delta: Json[]): Json[] {
  for (const item of delta) {
    if (empty(item)) continue
    if (typeof item === 'string') {
      appendText(current, item)
      continue
    }
    const last = current[current.length - 1]
    if (isObj(item) && isObj(last) && typeof item.type === 'string' && item.type === last.type) {
      for (const [k, v] of Object.entries(item)) {
        if (k === 'type' || empty(v)) continue
        const cur = last[k]
        if (typeof v === 'string') last[k] = typeof cur === 'string' ? cur + v : v
        else if (Array.isArray(v)) last[k] = mergeChunkList(Array.isArray(cur) ? cur : [], v)
        else if (isObj(v)) {
          const into = isObj(cur) ? cur : {}
          mergeInto(into, v, (key) => FIRST_WINS.has(key))
          last[k] = into
        } else last[k] = v
      }
    } else {
      current.push(clone(item))
    }
  }
  return current
}

function appendText(list: Json[], text: string): void {
  const last = list[list.length - 1]
  if (isObj(last) && last.type === 'text' && typeof last.text === 'string') last.text += text
  else list.push({ type: 'text', text })
}

type Slot = { call: Obj; index: number | null }

export type ChatReducer = {
  /** Fold one `choices[0].delta`. */
  add(delta: unknown): void
  /** The assistant message to replay, exactly as accumulated (unknown fields kept). */
  message(): Record<string, unknown>
  toolCalls(): Array<{ id: string; name: string; argsText: string }>
  /** Visible text so far (a chunk list's text chunks; a leading <think> block is the display's to strip). */
  text(): string
  /** Reasoning text so far, from whichever field carried it. */
  reasoning(): string
}

export function createChatReducer(): ChatReducer {
  const message: Obj = {}
  const slots: Slot[] = []
  const minted = new Map<Slot, string>()

  const slotFor = (frag: Obj): Slot => {
    const id = typeof frag.id === 'string' && frag.id ? frag.id : null
    const index = typeof frag.index === 'number' ? frag.index : null
    if (index !== null) {
      // The newest slot with this index; a different non-empty id there is a new call.
      for (let i = slots.length - 1; i >= 0; i--) {
        const s = slots[i]
        if (s.index !== index) continue
        const sid = typeof s.call.id === 'string' && s.call.id ? s.call.id : null
        if (id && sid && id !== sid) break
        return s
      }
    } else if (id) {
      const byId = slots.find((s) => s.call.id === id)
      if (byId) return byId
    } else if (slots.length) {
      // No index and no id: a continuation of the call that arrived last.
      const fn = isObj(frag.function) ? frag.function : null
      const startsNew = fn && typeof fn.name === 'string' && fn.name !== ''
      if (!startsNew) return slots[slots.length - 1]
    }
    const slot: Slot = { call: {}, index }
    slots.push(slot)
    return slot
  }

  const addToolCalls = (frags: unknown[]) => {
    for (const frag of frags) {
      if (!isObj(frag)) continue
      const slot = slotFor(frag)
      // `index` is a streaming artefact, never part of the replayed call.
      const { index: _index, function: fn, ...rest } = frag
      void _index
      mergeInto(slot.call, rest, (k) => FIRST_WINS.has(k))
      if (isObj(fn)) {
        // `function.name`: the first non-empty one wins; `arguments` concatenate.
        const into = isObj(slot.call.function) ? slot.call.function : {}
        mergeInto(into, fn, (k) => k === 'name' || FIRST_WINS.has(k))
        slot.call.function = into
      }
    }
  }

  const addContent = (value: unknown) => {
    if (empty(value)) return
    const current = message.content
    if (Array.isArray(value)) {
      const list: Json[] = Array.isArray(current) ? current : typeof current === 'string' && current ? [{ type: 'text', text: current }] : []
      message.content = mergeChunkList(list, value as Json[])
    } else if (typeof value === 'string') {
      if (Array.isArray(current)) appendText(current, value)
      else message.content = (typeof current === 'string' ? current : '') + value
    }
  }

  return {
    add(delta) {
      if (!isObj(delta)) return
      for (const [key, value] of Object.entries(delta)) {
        if (key === 'tool_calls') {
          if (Array.isArray(value)) addToolCalls(value)
        } else if (key === 'content') {
          addContent(value)
        } else if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue
        } else {
          mergeInto(message, { [key]: value as Json }, (k) => k === 'role' || k === 'id' || k === 'type')
        }
      }
    },
    message() {
      const out: Record<string, unknown> = { ...clone(message), role: 'assistant' }
      if (!('content' in out)) out.content = null
      const calls = this.toolCalls()
      if (calls.length) {
        out.tool_calls = slots.map((s, i) => {
          const call = clone(s.call)
          const fn = isObj(call.function) ? call.function : {}
          return { ...call, id: calls[i].id, type: typeof call.type === 'string' && call.type ? call.type : 'function', function: { ...fn, name: calls[i].name, arguments: calls[i].argsText } }
        })
      } else delete out.tool_calls
      return out
    },
    toolCalls() {
      return slots.map((s) => {
        let id = typeof s.call.id === 'string' && s.call.id ? s.call.id : minted.get(s)
        if (!id) {
          id = `call_${crypto.randomUUID().replace(/-/g, '')}`
          minted.set(s, id)
        }
        const fn = isObj(s.call.function) ? s.call.function : {}
        return { id, name: typeof fn.name === 'string' ? fn.name : '', argsText: typeof fn.arguments === 'string' ? fn.arguments : '' }
      })
    },
    text() {
      const c = message.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map((x) => (isObj(x) && x.type === 'text' && typeof x.text === 'string' ? x.text : '')).join('')
      return ''
    },
    reasoning() {
      for (const key of ['reasoning_content', 'reasoning']) if (typeof message[key] === 'string') return message[key] as string
      const c = message.content
      if (Array.isArray(c)) {
        const thinking = c.filter((x) => isObj(x) && x.type === 'thinking')
        const texts: string[] = []
        const walk = (v: Json) => {
          if (typeof v === 'string') return
          if (Array.isArray(v)) v.forEach(walk)
          else if (isObj(v)) {
            if (v.type === 'text' && typeof v.text === 'string') texts.push(v.text)
            else for (const x of Object.values(v)) walk(x)
          }
        }
        thinking.forEach((t) => walk((t as Obj).thinking ?? null))
        if (texts.length) return texts.join('')
      }
      return ''
    },
  }
}

/** A leading `<think>…</think>` block (older MiniMax, LM Studio or vLLM without a parser): stripped for display only. */
export function stripLeadingThink(text: string): { display: string; thinking: string | null } {
  const m = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(text)
  if (!m) return { display: text, thinking: null }
  return { display: text.slice(m[0].length), thinking: m[1] }
}
