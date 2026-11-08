import type { GetServerSideProps } from 'next'
import { robotsTxt } from '../lib/robotsTxt'

/**
 * /robots.txt (lib/robotsTxt). Built per request like the sitemap, so its
 * Sitemap line carries the configured origin; kept five minutes at the edge.
 */

const RobotsTxt = () => null

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  res.end(robotsTxt())
  return { props: {} }
}

export default RobotsTxt
