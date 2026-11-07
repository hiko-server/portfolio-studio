import type { Quirks } from '../presets'
import { localProviderOrigins } from '../settings'
import { createAnthropicAdapter } from './anthropic'
import { createChatAdapter } from './chat'
import { createResponsesAdapter } from './responses'
import type { ModelAdapter, Wire } from './types'

/**
 * One adapter for one call site (SERVER-ONLY): the wire, the base URL the
 * key was sealed to (or, for a typed key, the URL the owner just entered),
 * the key opened for this use and the preset's quirks. Nothing is cached:
 * the next call opens the key again.
 *
 * Claude goes to its fixed host; `anthropicBaseURL` is the one parameter
 * only tests pass (design §12.2: the factory takes it, no test branch).
 */
export type AdapterSpec = {
  wire: Wire
  baseUrl: string
  apiKey: string | null
  quirks: Quirks
  anthropicBaseURL?: string
  /** Claude: stream idle limit (tests shorten it). */
  idleTimeoutMs?: number
}

export function createAdapter(spec: AdapterSpec): ModelAdapter {
  if (spec.wire === 'anthropic') {
    if (!spec.apiKey) throw new Error('Claude needs a key')
    return createAnthropicAdapter({ apiKey: spec.apiKey, baseURL: spec.anthropicBaseURL, idleTimeoutMs: spec.idleTimeoutMs })
  }
  const endpoint = {
    baseUrl: spec.baseUrl,
    apiKey: spec.apiKey,
    connectTimeoutMs: spec.quirks.connectTimeoutMs,
    idleTimeoutMs: spec.idleTimeoutMs ?? spec.quirks.idleTimeoutMs,
    localOrigins: localProviderOrigins(),
    quirks: spec.quirks,
  }
  return spec.wire === 'responses' ? createResponsesAdapter(endpoint) : createChatAdapter(endpoint)
}
