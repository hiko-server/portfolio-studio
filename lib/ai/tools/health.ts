import * as z from 'zod'
import { HEALTH_CHECKS } from '../../contentHealth/types'
import { aiHealthView } from '../healthView'
import { READ_ANNOTATIONS, defineTool, fitItems, ok } from '../toolTypes'

/**
 * get_content_health (design §4.2): the content health report, filtered to
 * what the AI views contain (lib/ai/healthView). Issue ids and item
 * versions are the ones a content-fix proposal names.
 */
export const getContentHealth = defineTool({
  name: 'get_content_health',
  title: 'Check content health',
  description:
    'Problems in the published content: broken or moved links, tracking parameters, images (missing, remote, heavy, without alt text or sizes), ' +
    'heading structure, hard line breaks, descriptions and MDX errors. summary true returns the counts only; check limits it to one rule. ' +
    'Each issue has an id and its item a version, which a fix proposal names. Many issues come in parts: pass next_offset back as offset.',
  scope: 'content:read',
  cost: 'expensive',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: false, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    summary: z.boolean().optional().describe('true: counts only.'),
    check: z.enum(HEALTH_CHECKS).optional().describe('Only this rule, for example broken-link or image-alt.'),
    offset: z.number().int().min(0).max(100_000).optional().describe('Where the issues start, from next_offset. Default 0.'),
  }),
  targetOf: () => null,
  read(args, ctx) {
    // Without draft access, a link to a draft reads exactly like a link to a missing page (lib/ai/healthView).
    const view = aiHealthView(ctx.now, args.check, { drafts: ctx.scopes.has('content:draft') })
    if (args.summary) return ok({ generated_at: view.generated_at, counts: view.counts })
    const from = Math.min(args.offset ?? 0, view.issues.length)
    const issues = fitItems(view.issues.slice(from), 40 * 1024)
    const keys = new Set(issues.map((i) => i.item))
    const items = Object.fromEntries(Object.entries(view.items).filter(([k]) => keys.has(k)))
    const next = from + issues.length < view.issues.length ? from + issues.length : null
    return ok({ generated_at: view.generated_at, counts: view.counts, items, issues, offset: from, next_offset: next, truncated: next !== null })
  },
})
