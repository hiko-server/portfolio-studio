/**
 * What the server's environment does to the Claude SDK (SERVER-ONLY, design
 * §7.2). An explicit `apiKey` and `baseURL` skip the SDK's credential and URL
 * variables; `logLevel: 'off'` beats ANTHROPIC_LOG; a scrubbing logger
 * replaces the default `console`; `openTelemetry` given explicitly means the
 * ANTHROPIC_OPEN_TELEMETRY_* variables are not read (an option that is given
 * is complete), so prompts can never land in a span. One variable is still
 * read whatever the options say: ANTHROPIC_CUSTOM_HEADERS (SDK 1.1.0
 * client.js:170) adds headers to every request — so while it is set, no
 * Claude client is built, and System health says why.
 */

export const ANTHROPIC_CUSTOM_HEADERS_PROBLEM =
  'ANTHROPIC_CUSTOM_HEADERS is set in the server’s environment: the Claude SDK would add those headers to every request, so the Claude provider is refused until it is removed.'

/** Why no Claude client may be built in this environment, or null. */
export function anthropicEnvProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  return (env.ANTHROPIC_CUSTOM_HEADERS ?? '') !== '' ? ANTHROPIC_CUSTOM_HEADERS_PROBLEM : null
}
