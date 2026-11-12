import { useCallback, useEffect, useRef, useState } from 'react'
import { MEDIA_COPY } from './copy'

/**
 * The assistant's voice, in the browser only:
 *
 *   useDictation  speech to text with the Web Speech API. On-device where
 *                 the browser offers it (Chrome's `processLocally`), else the
 *                 browser's own speech service — which, in Chrome, is
 *                 Google's: the message box says which one is used. The
 *                 site's server never hears the audio.
 *   useSpeech     text to speech with speechSynthesis, sentence by sentence
 *                 (long utterances stall in Chrome), in a voice of the
 *                 reply's language.
 *   useRecorder   a voice message: MediaRecorder with a live level, at most
 *                 5 minutes, handed over as a Blob (attached as audio).
 */

const D = MEDIA_COPY.dictation

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  processLocally?: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}
type RecognitionCtor = {
  new (): Recognition
  available?: (opts: { langs: string[]; processLocally: boolean }) => Promise<string>
}

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const dictationSupported = (): boolean => !!recognitionCtor()

const CJK = /[㐀-鿿豈-﫿぀-ヿ]/

/** Join a dictated phrase to what is typed: a space between Latin words, none around CJK. */
export function joinDictated(before: string, phrase: string): string {
  const p = phrase.trim()
  if (!p) return before
  if (!before) return p
  const last = before.slice(-1)
  if (/\s/.test(last) || CJK.test(last) || CJK.test(p[0])) return before + p
  return `${before} ${p}`
}

/** The dictation language to start with: the one chosen before, else the browser's. */
export function defaultDictationLang(): string {
  try {
    const saved = window.localStorage.getItem('ai:dictation-lang')
    if (saved && D.langs[saved]) return saved
  } catch {
    // Storage blocked: the browser's language.
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en-US'
  if (/^zh-(tw|hant)/i.test(nav)) return 'zh-TW'
  if (/^zh-hk/i.test(nav)) return 'zh-HK'
  if (/^zh/i.test(nav)) return 'zh-CN'
  if (/^ja/i.test(nav)) return 'ja-JP'
  if (/^en-gb/i.test(nav)) return 'en-GB'
  return 'en-US'
}

export function saveDictationLang(lang: string): void {
  try {
    window.localStorage.setItem('ai:dictation-lang', lang)
  } catch {
    // Not remembered: fine.
  }
}

export type DictationState = 'idle' | 'starting' | 'listening'

/**
 * Dictation. `onFinal` gets each finished phrase; `interim` is the phrase
 * being heard. It keeps listening across the browser's own pauses until
 * `stop`. `local` says whether recognition runs on this device.
 */
export function useDictation({ lang, onFinal }: { lang: string; onFinal: (phrase: string) => void }) {
  const [state, setState] = useState<DictationState>('idle')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<boolean | null>(null)
  const rec = useRef<Recognition | null>(null)
  const wanted = useRef(false)
  /** Stopped with discard (the message was sent): phrases the browser still delivers are dropped. */
  const discard = useRef(false)
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal
  const supported = dictationSupported()

  /** Stop listening. `discard`: drop what the browser still delivers (the words already went with a message). */
  const stop = useCallback((opts: { discard?: boolean } = {}) => {
    wanted.current = false
    if (opts.discard) discard.current = true
    setInterim('')
    try {
      rec.current?.stop()
    } catch {
      // Already stopped.
    }
    setState('idle')
  }, [])

  const begin = useCallback(async () => {
    const Ctor = recognitionCtor()
    if (!Ctor) {
      setError(D.unsupported)
      return
    }
    setError(null)
    setState('starting')
    wanted.current = true
    discard.current = false
    const r = new Ctor()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    r.maxAlternatives = 1
    // On-device recognition where the browser has it for this language (nothing leaves the device).
    let onDevice = false
    if ('processLocally' in r && typeof Ctor.available === 'function') {
      try {
        onDevice = (await Ctor.available({ langs: [lang], processLocally: true })) === 'available'
      } catch {
        onDevice = false
      }
      if (onDevice) r.processLocally = true
    }
    if (!wanted.current) return
    setLocal(onDevice)
    r.onstart = () => setState('listening')
    r.onresult = (e) => {
      if (discard.current) return
      let live = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        const text = res[0]?.transcript ?? ''
        if (res.isFinal) onFinalRef.current(text)
        else live += text
      }
      setInterim(live)
    }
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      wanted.current = false
      setError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? D.denied : e.error === 'network' ? D.network : e.error === 'audio-capture' ? D.noMic : D.failed)
    }
    r.onend = () => {
      setInterim('')
      // The browser ends a session on its own after a pause: go on while the owner still dictates.
      if (wanted.current && rec.current === r) {
        try {
          r.start()
          return
        } catch {
          // Could not restart: end.
        }
      }
      if (rec.current === r) rec.current = null
      setState('idle')
    }
    rec.current = r
    try {
      r.start()
    } catch {
      wanted.current = false
      setState('idle')
      setError(D.failed)
    }
  }, [lang])

  const start = useCallback(() => {
    if (wanted.current) return
    void begin()
  }, [begin])

  useEffect(
    () => () => {
      wanted.current = false
      try {
        rec.current?.abort()
      } catch {
        // Gone.
      }
    },
    [],
  )

  return { supported, state, listening: state !== 'idle', interim, error, clearError: () => setError(null), local, start, stop }
}

// ── Reading aloud ─────────────────────────────────────────────────────────

/** A reply as it is read: code, links and markup reduced to what a listener needs. */
export function toSpeakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ', ')
    .replace(/^[\s,:-]+$/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Sentences of at most ~220 characters (Chrome stalls on long utterances). */
export function speechChunks(text: string, max = 220): string[] {
  const parts = text.split(/(?<=[。！？!?；;.…\n])\s*/).map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    if (p.length <= max) {
      const last = out[out.length - 1]
      if (last && last.length + p.length + 1 <= max) out[out.length - 1] = `${last} ${p}`
      else out.push(p)
      continue
    }
    for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max))
  }
  return out
}

/** The language a text is read in. */
export function speechLang(text: string): string {
  const sample = text.slice(0, 400)
  const cjk = (sample.match(/[㐀-鿿豈-﫿]/g) ?? []).length
  const kana = (sample.match(/[぀-ヿ]/g) ?? []).length
  if (kana > 4) return 'ja-JP'
  if (cjk > sample.replace(/\s/g, '').length * 0.2) return 'zh-CN'
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en-US'
  return /^en/i.test(nav) ? nav : 'en-US'
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  const base = lang.split('-')[0].toLowerCase()
  const matching = voices.filter((v) => v.lang.toLowerCase().replace('_', '-') === lang.toLowerCase())
  const family = matching.length ? matching : voices.filter((v) => v.lang.toLowerCase().startsWith(base))
  if (!family.length) return null
  // A voice on this device first: an online voice sends the reply's text to the browser vendor's speech service.
  const score = (v: SpeechSynthesisVoice) => (v.localService ? 8 : 0) + (/natural|neural|premium|enhanced|siri/i.test(v.name) ? 4 : 0) + (v.default ? 1 : 0)
  return [...family].sort((a, b) => score(b) - score(a))[0]
}

export const speechSupported = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'

export function useSpeech() {
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [rate, setRateState] = useState(() => {
    try {
      const r = Number(window.localStorage.getItem('ai:speech-rate'))
      return r >= 0.6 && r <= 2 ? r : 1
    } catch {
      return 1
    }
  })
  const token = useRef(0)
  const supported = speechSupported()

  useEffect(() => {
    if (!supported) return
    // Voices load late in Chrome: asking once makes them arrive.
    window.speechSynthesis.getVoices()
    return () => window.speechSynthesis.cancel()
  }, [supported])

  const stop = useCallback(() => {
    token.current++
    if (supported) window.speechSynthesis.cancel()
    setSpeakingId(null)
    setPaused(false)
  }, [supported])

  /** Read `text` (markdown) aloud as message `id`. Resolves when it was read to its end (false: stopped). */
  const speak = useCallback(
    (id: string, markdown: string): Promise<boolean> => {
      if (!supported) return Promise.resolve(false)
      window.speechSynthesis.cancel()
      const mine = ++token.current
      const text = toSpeakable(markdown)
      const lang = speechLang(text)
      const voice = pickVoice(lang)
      const chunks = speechChunks(text)
      setSpeakingId(id)
      setPaused(false)
      return new Promise<boolean>((resolve) => {
        if (!chunks.length) {
          setSpeakingId(null)
          return resolve(true)
        }
        let i = 0
        const next = () => {
          if (token.current !== mine) return resolve(false)
          if (i >= chunks.length) {
            setSpeakingId(null)
            return resolve(true)
          }
          const u = new SpeechSynthesisUtterance(chunks[i++])
          u.lang = voice?.lang ?? lang
          if (voice) u.voice = voice
          u.rate = rate
          u.onend = next
          u.onerror = (e) => {
            if (token.current !== mine) return resolve(false)
            if (e.error === 'interrupted' || e.error === 'canceled') return resolve(false)
            next()
          }
          window.speechSynthesis.speak(u)
        }
        next()
      })
    },
    [rate, supported],
  )

  const pause = useCallback(() => {
    if (!supported) return
    window.speechSynthesis.pause()
    setPaused(true)
  }, [supported])
  const resume = useCallback(() => {
    if (!supported) return
    window.speechSynthesis.resume()
    setPaused(false)
  }, [supported])
  const setRate = useCallback((r: number) => {
    setRateState(r)
    try {
      window.localStorage.setItem('ai:speech-rate', String(r))
    } catch {
      // Not remembered.
    }
  }, [])

  return { supported, speakingId, paused, speak, stop, pause, resume, rate, setRate }
}

export type Speech = ReturnType<typeof useSpeech>

// ── Voice messages ────────────────────────────────────────────────────────

const R = MEDIA_COPY.recorder
/** A recording stops a little before the 3½-minute clip limit (prepare.ts), so what was recorded is always accepted. */
export const MAX_RECORDING_MS = 205_000

export const recorderSupported = (): boolean => typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

function recorderType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t
    } catch {
      // Try the next.
    }
  }
  return ''
}

export function useRecorder({ onDone }: { onDone: (blob: Blob) => void }) {
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const live = useRef<{ stream: MediaStream; rec: MediaRecorder; ctx: AudioContext | null; frame: number; timer: number; started: number; keep: boolean } | null>(null)
  /** A start waiting on the microphone prompt: no second start, and a stream that arrives after unmount is stopped. */
  const starting = useRef(false)
  const mounted = useRef(true)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const teardown = useCallback(() => {
    const l = live.current
    if (!l) return
    cancelAnimationFrame(l.frame)
    window.clearInterval(l.timer)
    for (const t of l.stream.getTracks()) t.stop()
    void l.ctx?.close()
    live.current = null
    setRecording(false)
    setLevel(0)
  }, [])

  const finish = useCallback((keep: boolean) => {
    const l = live.current
    if (!l) return
    l.keep = keep
    if (l.rec.state !== 'inactive') l.rec.stop()
    else teardown()
  }, [teardown])

  const start = useCallback(async () => {
    if (live.current || starting.current) return
    setError(null)
    if (!recorderSupported()) {
      setError(R.unsupported)
      return
    }
    let stream: MediaStream
    starting.current = true
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (err) {
      if (mounted.current) setError(err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? R.denied : err instanceof DOMException && err.name === 'NotFoundError' ? MEDIA_COPY.dictation.noMic : R.failed)
      return
    } finally {
      starting.current = false
    }
    if (!mounted.current) {
      for (const t of stream.getTracks()) t.stop()
      return
    }
    const type = recorderType()
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    } catch {
      for (const t of stream.getTracks()) t.stop()
      setError(R.failed)
      return
    }
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    rec.onstop = () => {
      const keep = live.current?.keep ?? false
      teardown()
      if (keep && chunks.length) onDoneRef.current(new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' }))
    }
    // A live level, so the owner sees the microphone hears them.
    let ctx: AudioContext | null = null
    let frame = 0
    try {
      ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      let shown = 0
      let at = 0
      const tick = (t: number) => {
        // About 12 updates a second, and only when the level visibly moved: the page does not redraw every frame.
        if (t - at >= 80) {
          analyser.getByteTimeDomainData(data)
          let sum = 0
          for (const v of data) sum += ((v - 128) / 128) ** 2
          const next = Math.min(1, Math.sqrt(sum / data.length) * 4)
          if (Math.abs(next - shown) > 0.03) {
            shown = next
            setLevel(next)
          }
          at = t
        }
        if (live.current) live.current.frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    } catch {
      ctx = null
    }
    const started = Date.now()
    const timer = window.setInterval(() => {
      const ms = Date.now() - started
      setElapsed(ms)
      if (ms >= MAX_RECORDING_MS) finish(true)
    }, 250)
    live.current = { stream, rec, ctx, frame, timer, started, keep: false }
    setElapsed(0)
    setRecording(true)
    rec.start(1000)
  }, [finish, teardown])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (live.current) {
        live.current.keep = false
        try {
          live.current.rec.stop()
        } catch {
          // Gone.
        }
        teardown()
      }
    }
  }, [teardown])

  return { supported: recorderSupported(), recording, elapsed, level, error, clearError: () => setError(null), start, stop: () => finish(true), cancel: () => finish(false) }
}
