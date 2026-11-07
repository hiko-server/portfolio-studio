/**
 * The public contribution calendar that lib/githubData reads without a
 * GITHUB_TOKEN (fetchContributions → safeFetch) as a host that does not
 * resolve: its lookup fails at once, the calendar is honestly unavailable,
 * and nothing leaves the machine (tests/no-network.mjs refuses any lookup
 * that is not stubbed). For tests of the GitHub loaders whose subject is
 * not the calendar; the GraphQL path is stubbed through fetch instead.
 */
import dns from 'node:dns'

export const PUBLIC_CALENDAR_HOST = 'github-contributions-api.jogruber.de'

/** Install the stub; returns the function that removes it. */
export function offlinePublicCalendar(): () => void {
  const original = dns.promises.lookup
  const stub = (async (host: string, ...rest: unknown[]) => {
    if (host === PUBLIC_CALENDAR_HOST) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
    return (original as (...args: unknown[]) => Promise<unknown>).call(dns.promises, host, ...rest)
  }) as typeof dns.promises.lookup
  dns.promises.lookup = stub
  return () => {
    if (dns.promises.lookup === stub) dns.promises.lookup = original
  }
}
