import type { HomeData } from './homeShape'

/**
 * Is `body` shaped like a whole home document — `hero` and `socials`
 * objects and a `brands` array — before normalizeHomeWrite reads it? Pure.
 *
 * Moved out of pages/api/home.ts (whose PUT refuses anything else with 400
 * "Invalid payload") so every writer of the home document checks the same
 * shape: the admin route and an approved AI proposal (lib/contentOps/home),
 * and a proposal's plan before it offers the owner a card (lib/ai/plans).
 */
export function isHomePayload(body: unknown): body is HomeData {
  const b = body as Partial<HomeData> | null
  return (
    !!b &&
    typeof b === 'object' &&
    !Array.isArray(b) &&
    !!b.hero &&
    typeof b.hero === 'object' &&
    !!b.socials &&
    typeof b.socials === 'object' &&
    Array.isArray(b.brands)
  )
}
