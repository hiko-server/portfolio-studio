import type { Logger } from '../log'
import { MediaOptimizeBusyError, optimizeUploads, pagesUsingUploads } from '../mediaOptimize'
import type { VariantRun } from './apply'
import { imageInfo } from './images'

/**
 * The responsive sizes a "Generate sizes" fix asks for (lib/contentHealth
 * apply ApplyDeps.generateVariants), through the media-optimize pipeline,
 * with the public pages that embed the new srcsets. Used by the content
 * health route and by an approved AI content-fix proposal. SERVER-ONLY.
 */
export async function generateVariants(names: ReadonlySet<string>, log: Logger): Promise<VariantRun> {
  try {
    const run = await optimizeUploads({ only: names })
    const done = new Set(
      Array.from(names).filter((n) => {
        const info = imageInfo(`/uploads/${encodeURIComponent(n)}`)
        return info.exists === true && info.missingVariants.length === 0
      })
    )
    return { done, errors: run.errors, busy: false, paths: pagesUsingUploads(run.optimized, log) }
  } catch (err) {
    if (err instanceof MediaOptimizeBusyError)
      return { done: new Set(), errors: [], busy: true, paths: [] }
    throw err
  }
}
