import { useCallback, useRef } from 'react'
import { Box, Grid, Link, Text, Flex, Skeleton } from '@chakra-ui/react'
import { m, useReducedMotion, type Variants } from 'framer-motion'
import { GitForkIcon, StarIcon } from '../Icons/ui/content'
import { motionTransition } from '../../theme/tokens'

import { safeHref } from '../../lib/cvFormat'
import { revealVariant } from '../../lib/reveal'
import { useFetchJson, useRenderNow } from '../Common/useFetchJson'
import WidgetNotice from '../Common/WidgetNotice'
import { useScrollReveal } from '../General-UI/useScrollReveal'
import { useSpotlight } from '../General-UI/useSpotlight'
import { plainRepoText, relativeTime, repoCard, type GhRepoCard, type GhRepoCards, type GhTopRepos } from '../Common/githubEvents'
import { fillUi } from '../../lib/uiStrings'
import type { HomeStrings } from '../../lib/uiStrings/home'
import { langWithin } from '../../lib/toc'
import { useHomeUi } from '../LandingPage/homeUi'

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Go: '#00ADD8',
  Rust: '#dea584',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Shell: '#89e051',
  Java: '#b07219',
  'C++': '#f34b7d',
  Vue: '#41B883',
  Dart: '#00B4AB',
  Swift: '#ffac45',
  Kotlin: '#A97BFF',
}

const monoFont = 'var(--font-geist-mono), ui-monospace, monospace'
const COLUMNS = { base: '1fr', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' }
const CARD_H = '132px'

const MotionGrid = m(Grid)
const MotionLi = m(Box)
/**
 * One parent stagger, played only when the grid scrolls up from below the
 * fold (lib/reveal.ts): the server, the first frame and a grid already on
 * screen show the tiles; reduced motion never hides them.
 */
const staggerVariants = (reduce: boolean | null): { list: Variants; item: Variants } => ({
  list: { hidden: {}, show: { transition: { staggerChildren: reduce ? 0 : 0.03 } } },
  item: {
    hidden: { opacity: 0, y: 6 },
    show: { opacity: 1, y: 0, transition: motionTransition('base', !!reduce) },
  },
})

/** Card body: the owner's blurb, else GitHub's description (as plain text), else what we do know. */
function repoSummary(r: GhRepoCard, now: number, t: HomeStrings): string {
  const text = plainRepoText(r.blurb) || plainRepoText(r.description)
  if (text) return text
  const when = relativeTime(r.pushed_at, now, t.github)
  return [r.language, when ? fillUi(t.repos.updated, { when }) : ''].filter(Boolean).join(' · ')
}

/**
 * Repositories: the owner's pinned ones first, then the rest of their own
 * work (personal and their organizations', which are named "org / name") —
 * flat tiles in a 1 / 2 / 3-up grid with a cursor-lit border, at most
 * `limit`. Server-rendered when `initialData` is passed (card fields only);
 * skeleton tiles otherwise keep the loaded height. Outages and an empty
 * account get an in-place notice.
 */
export default function TopRepos({ initialData, limit = 6 }: { initialData?: GhRepoCards | null; limit?: number }) {
  const { t } = useHomeUi()
  const { data, error, retry } = useFetchJson<GhRepoCards | GhTopRepos>('/api/github/top-repos', { initialData })

  if (error || data?.available === false) {
    return (
      <WidgetNotice kind="error" onRetry={retry} retryLabel={t.tryAgain} minH={CARD_H}>
        {t.repos.unavailable}
      </WidgetNotice>
    )
  }

  if (!data) {
    return (
      <Grid templateColumns={COLUMNS} gap={4} w="100%" aria-busy="true" aria-label={t.repos.loading}>
        {Array.from({ length: limit }).map((_, i) => (
          <Skeleton key={i} h={CARD_H} borderRadius="lg" startColor="page.bg-elevated" endColor="page.bg-overlay" />
        ))}
      </Grid>
    )
  }

  const repos = (data.repos || [])
    .filter((r) => safeHref(r.html_url))
    .slice(0, limit)
    .map(repoCard)
  if (!repos.length) {
    return <WidgetNotice kind="empty">{t.repos.empty}</WidgetNotice>
  }

  return <RepoGrid repos={repos} asOf={data.asOf} />
}

const clip = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minW: 0, maxW: '100%' } as const

/**
 * An organization's repository: "org / name", the organization muted (as
 * GitHub writes it), so a visitor sees whose account it is under. When the
 * card is too narrow for both on one line, the repository name — the
 * card's main label — wraps to a line of its own under "org /" and keeps
 * the card's full width; only a part longer than a whole line is cut. The
 * separator belongs to the organization's part, so a wrapped name leaves no
 * gap, and the text (the link's accessible name) stays "org / name".
 */
function OrgRepoName({ org, name }: { org: string; name: string }) {
  return (
    <Text as="span" display="flex" flexWrap="wrap" minW={0} fontSize="14px" fontFamily={monoFont} data-repo-org={org}>
      <Box as="span" {...clip} color="page.fg-secondary">
        {org}
        <Box as="span" whiteSpace="pre">
          {' / '}
        </Box>
      </Box>
      <Box as="span" {...clip} color="page.fg" fontWeight={500}>
        {name}
      </Box>
    </Text>
  )
}

/** The loaded grid (its own component so the spotlight attaches once the list exists). */
function RepoGrid({ repos, asOf }: { repos: GhRepoCard[]; asOf?: number }) {
  const { t, lang } = useHomeUi()
  const reduce = useReducedMotion()
  const listRef = useRef<HTMLElement | null>(null)
  const reveal = useScrollReveal<HTMLElement>({ afterMotionFeatures: true })
  const revealRef = reveal.ref
  const setListRef = useCallback(
    (el: HTMLElement | null) => {
      listRef.current = el
      revealRef(el)
    },
    [revealRef],
  )
  useSpotlight(listRef)
  const now = useRenderNow(asOf)
  const variants = staggerVariants(reduce)

  return (
    <MotionGrid
      as="ul"
      ref={setListRef}
      data-reveal-list=""
      className="hover-list"
      listStyleType="none"
      templateColumns={COLUMNS}
      gap={4}
      w="100%"
      aria-label={t.repos.label}
      variants={variants.list}
      initial={false}
      animate={revealVariant(reveal.phase)}
    >
      {repos.map((r) => {
        const langColor = r.language ? LANG_COLORS[r.language] || 'var(--accent)' : 'var(--accent)'
        const summary = repoSummary(r, now, t)
        const fromText = !!(plainRepoText(r.blurb) || plainRepoText(r.description))
        return (
          <MotionLi as="li" key={r.id} variants={variants.item} data-reveal-item="" display="flex" minW={0}>
            <Link
              href={safeHref(r.html_url)}
              isExternal
              className="spotlight hover-item"
              data-spotlight=""
              display="flex"
              flexDirection="column"
              w="100%"
              minW={0}
              minH={CARD_H}
              border="1px solid"
              borderColor="page.border"
              borderRadius="lg"
              p={4}
              sx={{
                transitionProperty: 'border-color, opacity',
                transitionDuration: '200ms',
                transitionTimingFunction: 'var(--ease-out-quart)',
                '&:hover': { borderColor: 'page.border-strong', textDecoration: 'none' },
                '&:focus-visible': { borderColor: 'var(--accent)', outline: 'none', boxShadow: '0 0 0 1px var(--accent)' },
              }}
            >
              <Flex justify="space-between" align="baseline" gap={2} mb={2}>
                {r.org ? (
                  <OrgRepoName org={r.org} name={r.name} />
                ) : (
                  <Text as="span" fontWeight={500} fontSize="14px" color="page.fg" noOfLines={1} fontFamily={monoFont}>
                    {r.name}
                  </Text>
                )}
                <Text as="span" className="nudge-ne" fontFamily={monoFont} fontSize="11px" color="page.fg-secondary" aria-hidden>
                  ↗
                </Text>
                <span className="sr-only">{t.repos.newTab}</span>
              </Flex>
              <Text
                fontSize="13px"
                color="page.fg-secondary"
                fontFamily={fromText ? undefined : monoFont}
                // The owner's blurb or GitHub's description, in their own language.
                lang={fromText ? langWithin(summary, lang) : undefined}
                noOfLines={2}
                lineHeight="1.55"
                mb={3}
                minH="40px"
              >
                {summary}
              </Text>
              <Box flex="1" />
              <Flex align="center" justify="space-between" gap={3} fontFamily={monoFont} fontSize="11px" color="page.fg-secondary">
                <Flex align="center" gap={3} className="tnum">
                  {/* A count is shown once there is one: a row of zeros says nothing about the work. */}
                  {r.stargazers_count > 0 && (
                    <Flex align="center" gap={1} data-repo-count="stars">
                      <StarIcon size="xs" />
                      <Text as="span">
                        {r.stargazers_count}
                        <span className="sr-only">{t.repos.stars}</span>
                      </Text>
                    </Flex>
                  )}
                  {r.forks_count > 0 && (
                    <Flex align="center" gap={1} data-repo-count="forks">
                      <GitForkIcon size="xs" />
                      <Text as="span">
                        {r.forks_count}
                        <span className="sr-only">{t.repos.forks}</span>
                      </Text>
                    </Flex>
                  )}
                  {r.featured ? (
                    <Text as="span" letterSpacing="0.08em" textTransform="uppercase" color="accent.text">
                      {t.repos.featured}
                    </Text>
                  ) : null}
                </Flex>
                {r.language && (
                  <Flex align="center" gap={1.5} minW={0}>
                    <Box as="span" aria-hidden w="6px" h="6px" borderRadius="full" bg={langColor} flexShrink={0} />
                    <Text as="span" noOfLines={1}>
                      {r.language}
                    </Text>
                  </Flex>
                )}
              </Flex>
            </Link>
          </MotionLi>
        )
      })}
    </MotionGrid>
  )
}
