/**
 * What every stored post or case study must carry, whichever path writes it
 * (lib/contentOps/items for the admin and approved changes,
 * lib/contentOps/drafts for draft-safe writes), and the noun messages use.
 * Pure.
 */

export type Collection = 'blog' | 'work'

export const ITEM_RULES: Readonly<Record<Collection, { noun: string; requireDate: boolean }>> = {
  blog: { noun: 'post', requireDate: true },
  work: { noun: 'case study', requireDate: false },
}
