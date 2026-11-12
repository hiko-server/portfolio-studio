#!/usr/bin/env node
/**
 * Remove the build-time copies of every ISR page from a standalone build, so
 * the server can never serve them.
 *
 *   node scripts/forget-build-seeds.mjs [.next/standalone/.next]
 *
 * The Docker build runs `next build` without the content store (runtime state
 * never belongs in an image), so the pages it prerenders — /, /about, /cv,
 * /contact, /now, … — are rendered from the git seeds in data/*.json, a
 * FICTIONAL demo person. Next.js 16.4 keeps regenerated pages in
 * .next/server/route-cache/ and leaves those build copies in
 * .next/server/pages/ as the "seed" of that cache: the first request to a page
 * after every start was answered with the demo copy (STALE), and a seed read
 * can be promoted into the route cache as if it were fresh. Behind an edge
 * cache that one answer is kept for minutes (seen on 2026-11-12: the home page
 * showed the demo name after a container restart).
 *
 * Without the build copy, Next renders the page on its first request from the
 * live content store (a blocking render) and caches that — the same path a
 * page whose copy lib/isrCache removed has always taken. scripts/warm-isr.mjs
 * still renders every page right after start, so visitors rarely wait.
 *
 * Only pages with a revalidate window are touched (prerender-manifest routes
 * whose initialRevalidateSeconds is a number); fully static pages (/colophon,
 * the error pages) keep their copies. Exit codes: 0 done, 1 no manifest.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The .next/server/pages base name of a route ('/' is stored as index). */
export function seedBase(route) {
  return route === '/' ? 'index' : route.replace(/^\/+/, '')
}

/** Remove the build copies of the ISR routes in `nextDir`; returns the removed paths (relative to nextDir). */
export function forgetBuildSeeds(nextDir) {
  const manifestPath = path.join(nextDir, 'prerender-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const pagesDir = path.join(nextDir, 'server', 'pages')
  const removed = []
  for (const [route, info] of Object.entries(manifest.routes || {})) {
    if (typeof info?.initialRevalidateSeconds !== 'number') continue
    const base = seedBase(route)
    if (!base || base.split('/').includes('..')) continue
    for (const ext of ['.html', '.json', '.meta']) {
      const file = path.join(pagesDir, `${base}${ext}`)
      if (!path.resolve(file).startsWith(path.resolve(pagesDir) + path.sep)) continue
      try {
        fs.unlinkSync(file)
        removed.push(path.relative(nextDir, file))
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err
      }
    }
  }
  return removed
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const nextDir = path.resolve(process.argv[2] || '.next/standalone/.next')
  if (!fs.existsSync(path.join(nextDir, 'prerender-manifest.json'))) {
    console.error(`[forget-build-seeds] no prerender-manifest.json in ${nextDir}`)
    process.exit(1)
  }
  const removed = forgetBuildSeeds(nextDir)
  const pages = new Set(removed.map((f) => f.replace(/\.(html|json|meta)$/, '')))
  console.log(`[forget-build-seeds] removed the build copies of ${pages.size} ISR page(s) (${removed.length} files); they render from the content store on first request`)
}
