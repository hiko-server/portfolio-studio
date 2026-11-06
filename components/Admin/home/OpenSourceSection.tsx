import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  Flex,
  FormControl,
  FormErrorMessage,
  FormLabel,
  IconButton,
  Input,
  Link,
  List,
  ListItem,
  Spinner,
  Switch,
  Text,
  Textarea,
} from '@chakra-ui/react'
import { DeleteIcon } from '@chakra-ui/icons'
import { HOME_LIMITS, isRepoName } from '../../../lib/homeShape'
import SortableList, { SortableHandle } from '../shell/SortableList'
import { MONO, inputProps, outlineButtonProps, warnTextProps } from '../shell/ui'
import { blurbRemaining, moveItem, newId, type OpenSourceForm } from './homeForm'
import { useUndoableRemove, type SectionProps } from './ImageCards'
import {
  canRecheck,
  featuredNameFor,
  namesListedRepo,
  orgCheckText,
  orgFromInput,
  orgInputProblem,
  parseOrgCheck,
  parseRepos,
  pickerRepos,
  resolveFeatured,
  sourceRepos,
  type OrgCheckState,
  type RepoChoice,
} from './orgCheck'

type LoadState = 'loading' | 'ready' | 'unavailable'

/** "org / name" with the organization muted, or the plain name of a personal repository. */
function RepoLabel({ org, name }: { org: string; name: string }) {
  if (!org) return <>{name}</>
  return (
    <>
      <Text as="span" color="page.fg-secondary" fontWeight={400}>
        {org} /{' '}
      </Text>
      {name}
    </>
  )
}

/** A stored featured name ("org/name" or "name") as RepoLabel parts. */
const splitStored = (stored: string) => {
  const slash = stored.indexOf('/')
  return slash > 0 ? { org: stored.slice(0, slash), name: stored.slice(slash + 1) } : { org: '', name: stored }
}

/**
 * The open-source band's settings:
 *   - Organizations: GitHub organizations whose public repositories are the
 *     owner's work and count with the personal account's. Each one is
 *     checked on GitHub (GET /api/admin/github-org) when it is added and
 *     when the editor opens: display name and repository count, or why it
 *     could not be confirmed.
 *   - Featured repositories: pick from the owner's public repositories —
 *     personal (GET /api/github/top-repos?all=1) and the organizations' —
 *     or type a name when GitHub is unreachable; reorder by dragging;
 *     optional blurb (≤140). An organization's repository is stored as
 *     "org/name".
 *   - The vanity-stats toggle.
 */
export default function OpenSourceSection({ value, onChange, githubUser = null }: SectionProps<OpenSourceForm> & { githubUser?: string | null }) {
  const [state, setState] = useState<LoadState>('loading')
  const [baseRepos, setBaseRepos] = useState<RepoChoice[]>([])
  const [query, setQuery] = useState('')
  const [orgInput, setOrgInput] = useState('')
  const [orgProblem, setOrgProblem] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, OrgCheckState>>({})
  const [announce, setAnnounce] = useState('')
  const started = useRef(new Set<string>())
  const announceFor = useRef<string | null>(null)
  const alive = useRef(true)
  const searchId = useId()
  const listId = useId()
  const statsId = useId()
  const orgFieldId = useId()
  const orgHintId = useId()

  const orgs = useMemo(() => (Array.isArray(value.orgs) ? value.orgs : []), [value.orgs])

  useEffect(() => {
    alive.current = true
    fetch('/api/github/top-repos?all=1', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (!alive.current) return
        const parsed = parseRepos(body)
        setBaseRepos(parsed.repos)
        setState(parsed.available ? 'ready' : 'unavailable')
      })
      .catch(() => alive.current && setState('unavailable'))
    return () => {
      alive.current = false
    }
  }, [])

  const runCheck = useCallback((login: string) => {
    const key = login.toLowerCase()
    started.current.add(key)
    setChecks((prev) => ({ ...prev, [key]: { status: 'checking' } }))
    fetch(`/api/admin/github-org?login=${encodeURIComponent(login)}`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (r) => parseOrgCheck(r.status, await r.json().catch(() => null)))
      .catch((): OrgCheckState => ({ status: 'error' }))
      .then((result) => {
        if (!alive.current) return
        setChecks((prev) => ({ ...prev, [key]: result }))
        // Say the result of an organization just added (the rows themselves stay quiet).
        if (announceFor.current === key) {
          announceFor.current = null
          setAnnounce(`${login}: ${orgCheckText(result).text}`)
        }
      })
  }, [])

  // Every organization of the form is checked once: the saved ones when the editor opens, a new one when it is added.
  useEffect(() => {
    for (const org of orgs) if (!started.current.has(org.toLowerCase())) runCheck(org)
  }, [orgs, runCheck])

  const addOrg = () => {
    const problem = orgInputProblem(orgInput, orgs, githubUser)
    setOrgProblem(problem)
    if (problem) return
    const login = orgFromInput(orgInput)
    announceFor.current = login.toLowerCase()
    started.current.delete(login.toLowerCase()) // added again after a removal: check it afresh
    onChange((prev) => ({ ...prev, orgs: [...(Array.isArray(prev.orgs) ? prev.orgs : []), login] }))
    setOrgInput('')
  }
  const removeOrg = (login: string) => {
    onChange((prev) => ({ ...prev, orgs: (Array.isArray(prev.orgs) ? prev.orgs : []).filter((o) => o !== login) }))
    setAnnounce(`Removed ${login}.`)
  }

  const setFeatured = (update: (prev: OpenSourceForm['featured']) => OpenSourceForm['featured']) =>
    onChange((prev) => ({ ...prev, featured: update(prev.featured) }))
  const removeFeatured = useUndoableRemove<OpenSourceForm['featured'][number]>(
    (next) => onChange((prev) => ({ ...prev, featured: typeof next === 'function' ? next(prev.featured) : next })),
    'repo',
  )

  // Every repository of the form's sources in the home page's order (forks too: a featured name may mean one), and what the picker offers of them.
  const sources = useMemo(() => sourceRepos(baseRepos, orgs, checks), [baseRepos, orgs, checks])
  const repos = useMemo(() => pickerRepos(sources), [sources])
  const resolved = useMemo(() => resolveFeatured(sources, value.featured), [sources, value.featured])
  const taken = useMemo(() => new Set(Array.from(resolved.values()).map((r) => r.fullName.toLowerCase())), [resolved])
  const chosenNames = useMemo(() => new Set(value.featured.map((f) => f.name.toLowerCase())), [value.featured])
  const fromOrgs = repos.filter((r) => r.org).length
  const checking = orgs.some((o) => checks[o.toLowerCase()]?.status === 'checking')
  const q = query.trim().toLowerCase()
  const matches = repos
    .filter((r) => !taken.has(r.fullName.toLowerCase()))
    .filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.language.toLowerCase().includes(q))
    .slice(0, 8)
  const typed = query.trim()
  const canAddTyped = isRepoName(typed) && !chosenNames.has(typed.toLowerCase()) && !namesListedRepo(sources, typed)
  const full = value.featured.length >= HOME_LIMITS.featuredMax
  // The search controls the list of matches only while there is one (aria-controls must name an element on the page).
  const listShown = (matches.length > 0 || canAddTyped) && !full

  const add = (name: string) => {
    if (full || chosenNames.has(name.toLowerCase())) return
    setFeatured((prev) => [...prev, { _id: newId(), name, blurb: '' }])
    setQuery('')
  }

  return (
    <Box>
      <Box mb={6} p={3} border="1px solid" borderColor="page.border" borderRadius="lg" data-testid="open-source-orgs">
        <Text as="h3" fontSize="sm" fontWeight={600}>
          Organizations
        </Text>
        <Text id={orgHintId} mt={1} fontSize="xs" color="page.fg-secondary">
          Public repositories of these GitHub organizations count as yours across the band — stats, repositories, languages and activity — and
          appear in the picker below. Add only organizations whose work is your own: being a member is not enough.
          {githubUser ? null : ' Link your GitHub profile under Socials first; organizations add to its repositories.'}
        </Text>
        <FormControl mt={3} isInvalid={!!orgProblem}>
          <FormLabel htmlFor={orgFieldId} fontSize="xs" color="page.fg-secondary" mb={1}>
            Add an organization
          </FormLabel>
          <Flex gap={2}>
            <Input
              id={orgFieldId}
              size="sm"
              {...inputProps}
              fontFamily={MONO}
              value={orgInput}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="example-org"
              aria-describedby={orgHintId}
              isDisabled={orgs.length >= HOME_LIMITS.orgsMax}
              onChange={(e) => {
                setOrgInput(e.target.value)
                if (orgProblem) setOrgProblem(null)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                e.preventDefault()
                addOrg()
              }}
            />
            <Button size="sm" {...outlineButtonProps} flexShrink={0} onClick={addOrg} isDisabled={orgs.length >= HOME_LIMITS.orgsMax}>
              Add
            </Button>
          </Flex>
          {orgProblem ? <FormErrorMessage fontSize="xs">{orgProblem}</FormErrorMessage> : null}
        </FormControl>
        <Box srOnly role="status" aria-live="polite">
          {announce}
        </Box>
        {orgs.length === 0 ? (
          <Text mt={3} fontSize="sm" color="page.fg-secondary">
            No organizations — the band shows your personal repositories only.
          </Text>
        ) : (
          <List mt={3} spacing={2} aria-label="Organizations whose repositories count as yours">
            {orgs.map((login) => {
              const check = checks[login.toLowerCase()]
              const said = orgCheckText(check)
              return (
                <ListItem key={login.toLowerCase()} data-org={login}>
                  <Flex gap={2} align="flex-start" p={2.5} border="1px solid" borderColor="page.border" borderRadius="lg" bg="page.bg">
                    <Box flex={1} minW={0}>
                      <Link
                        href={`https://github.com/${login}`}
                        isExternal
                        fontFamily={MONO}
                        fontSize="sm"
                        fontWeight={600}
                        color="page.fg"
                        _hover={{ color: 'accent.text' }}
                        wordBreak="break-all"
                      >
                        {login}
                        <Text as="span" srOnly>
                          {' '}
                          (opens GitHub in a new tab)
                        </Text>
                      </Link>
                      <Flex mt={0.5} gap={2} align="center" wrap="wrap">
                        {check?.status === 'checking' ? <Spinner size="xs" aria-hidden /> : null}
                        <Text fontSize="xs" {...(said.warn ? warnTextProps : { color: 'page.fg-secondary' })} data-org-status={check?.status || 'checking'}>
                          {said.text}
                        </Text>
                        {canRecheck(check) ? (
                          <Button size="xs" variant="link" color="accent.text" onClick={() => runCheck(login)} aria-label={`Check again: ${login}`}>
                            Check again
                          </Button>
                        ) : null}
                      </Flex>
                    </Box>
                    <IconButton
                      aria-label={`Remove ${login}`}
                      size="sm"
                      variant="ghost"
                      color="page.fg-secondary"
                      _hover={{ color: 'red.500', bg: 'page.bg-overlay' }}
                      icon={<DeleteIcon />}
                      onClick={() => removeOrg(login)}
                    />
                  </Flex>
                </ListItem>
              )
            })}
          </List>
        )}
      </Box>

      <FormControl>
        <FormLabel htmlFor={searchId} fontSize="xs" color="page.fg-secondary" mb={1}>
          Add a repository
        </FormLabel>
        <Input
          id={searchId}
          size="sm"
          {...inputProps}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            e.preventDefault()
            if (matches[0]) add(featuredNameFor(matches[0]))
            else if (canAddTyped) add(typed)
          }}
          placeholder={state === 'unavailable' ? 'GitHub is unreachable — type a repository name' : 'Search your repositories'}
          aria-controls={listShown ? listId : undefined}
          isDisabled={full}
        />
      </FormControl>
      <Text mt={1} fontSize="xs" color="page.fg-secondary" role="status">
        {full
          ? `Up to ${HOME_LIMITS.featuredMax} featured repositories.`
          : state === 'loading'
            ? 'Loading your repositories…'
            : state === 'unavailable'
              ? 'Couldn’t reach GitHub. Type the exact repository name (owner/name for an organization’s) and press Enter.'
              : `${repos.length} public repositories${fromOrgs ? ` (${fromOrgs} from your organizations)` : ''}. Featured ones come first on the home page, then the rest by stars and recency.`}
      </Text>
      {state === 'loading' ? <Spinner size="sm" mt={2} /> : null}
      {listShown ? (
        <List id={listId} mt={2} border="1px solid" borderColor="page.border" borderRadius="md" maxH="260px" overflowY="auto" aria-label="Matching repositories">
          {matches.map((r) => (
            <ListItem key={r.fullName} borderBottom="1px solid" borderColor="page.border" _last={{ borderBottom: 'none' }}>
              <Button
                variant="ghost"
                w="100%"
                h="auto"
                py={2}
                px={3}
                justifyContent="flex-start"
                textAlign="left"
                borderRadius={0}
                onClick={() => add(featuredNameFor(r))}
                _hover={{ bg: 'page.bg-overlay' }}
              >
                <Box minW={0}>
                  <Text fontSize="sm" fontWeight={600} noOfLines={1}>
                    <RepoLabel org={r.org} name={r.name} />
                    <Text as="span" ml={2} fontFamily={MONO} fontSize="10px" color="page.fg-secondary" fontWeight={400} className="tnum">
                      {[r.language, `★ ${r.stars}`, r.archived ? 'archived' : ''].filter(Boolean).join(' · ')}
                    </Text>
                  </Text>
                  {r.description ? (
                    <Text fontSize="xs" color="page.fg-secondary" noOfLines={1} fontWeight={400} whiteSpace="normal">
                      {r.description}
                    </Text>
                  ) : null}
                </Box>
              </Button>
            </ListItem>
          ))}
          {canAddTyped ? (
            <ListItem>
              <Button variant="ghost" w="100%" justifyContent="flex-start" borderRadius={0} size="sm" onClick={() => add(typed)}>
                Add “{typed}”
              </Button>
            </ListItem>
          ) : null}
        </List>
      ) : null}

      <Box mt={4}>
        {value.featured.length === 0 ? (
          <Text fontSize="sm" color="page.fg-secondary">
            Nothing featured — the home page shows your repositories by stars and recency.
          </Text>
        ) : (
          <SortableList
            items={value.featured}
            getId={(f) => f._id}
            itemNoun="repository"
            ariaLabel="Featured repositories, in display order"
            spacing={2}
            onReorder={(from, to) => setFeatured((prev) => moveItem(prev, from, to))}
            renderItem={(f, { index }) => {
              const left = blurbRemaining(f.blurb)
              const label = splitStored(f.name)
              // Said only once everything is loaded: a repository of an organization still being checked is not "missing".
              const missing = state === 'ready' && !checking && !resolved.has(f._id)
              return (
                <Flex gap={2} p={2.5} border="1px solid" borderColor="page.border" borderRadius="lg" bg="page.bg" align="flex-start">
                  <SortableHandle label={`Reorder ${f.name}`} />
                  <Box flex={1} minW={0}>
                    <Text fontSize="sm" fontWeight={600} noOfLines={1} pt={1}>
                      <RepoLabel org={label.org} name={label.name} />
                    </Text>
                    {missing ? (
                      <Text mt={0.5} fontSize="xs" {...warnTextProps}>
                        Not among your repositories on GitHub, so the home page doesn’t show it.
                      </Text>
                    ) : null}
                    <FormControl mt={1.5} isInvalid={left < 0}>
                      <FormLabel srOnly>Blurb for {f.name}</FormLabel>
                      <Textarea
                        size="sm"
                        rows={2}
                        {...inputProps}
                        value={f.blurb}
                        placeholder="Optional one-liner shown instead of the GitHub description"
                        onChange={(e) => setFeatured((prev) => prev.map((x) => (x._id === f._id ? { ...x, blurb: e.target.value } : x)))}
                      />
                      <Text mt={1} fontSize="10px" fontFamily={MONO} color={left < 0 ? 'red.600' : 'page.fg-secondary'} _dark={left < 0 ? { color: 'red.300' } : undefined} className="tnum" textAlign="right">
                        {left} characters left
                      </Text>
                    </FormControl>
                  </Box>
                  <IconButton
                    aria-label={`Remove ${f.name}`}
                    size="sm"
                    variant="ghost"
                    color="page.fg-secondary"
                    _hover={{ color: 'red.500', bg: 'page.bg-overlay' }}
                    icon={<DeleteIcon />}
                    onClick={() => removeFeatured(value.featured, index)}
                  />
                </Flex>
              )
            }}
          />
        )}
      </Box>

      <Flex align="center" justify="space-between" gap={4} mt={5} p={3} border="1px solid" borderColor="page.border" borderRadius="lg">
        <Box>
          <Text as="label" htmlFor={statsId} fontSize="sm" fontWeight={600}>
            Show star and fork totals
          </Text>
          <Text fontSize="xs" color="page.fg-secondary">
            Off: the section leads with what the projects do, not popularity counts.
          </Text>
        </Box>
        <Switch
          id={statsId}
          colorScheme="purple"
          isChecked={value.showVanityStats}
          onChange={(e) => onChange((prev) => ({ ...prev, showVanityStats: e.target.checked }))}
        />
      </Flex>
    </Box>
  )
}
