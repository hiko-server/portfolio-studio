import { SITE_URL } from './schema'

/**
 * The robots.txt body, served by pages/robots.txt.tsx. A route rather than a
 * file in public/: the Sitemap line must be an absolute URL, and the site's
 * origin (NEXT_PUBLIC_SITE_HOST, lib/schema SITE_URL — the same origin the
 * sitemap lists) is configuration, never part of the repository.
 */
export function robotsTxt(origin: string = SITE_URL): string {
  return [
    'User-agent: *',
    'Allow: /',
    '# Social-card images must stay fetchable for link previews and search.',
    'Allow: /api/og',
    '# The IndexNow key file (/<key>.txt) and /.well-known/security.txt live at',
    '# the root, outside /api/, so they stay fetchable too.',
    'Disallow: /admin',
    'Disallow: /api/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}
