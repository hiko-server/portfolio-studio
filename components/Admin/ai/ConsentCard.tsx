import { useId, useState } from 'react'
import { Alert, AlertDescription, AlertIcon, Box, Button, Flex, FormControl, FormErrorMessage, FormHelperText, FormLabel, Input, Stack, Text } from '@chakra-ui/react'
import { MONO, inputProps, outlineButtonProps, primaryButtonProps, warnTextProps } from '../shell/ui'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { useStepUp } from '../security/useStepUp'
import { wasStepUpCancelled } from '../security/stepUpClient'
import { AI_COPY, levelName, levelSummary } from './copy'
import { isWebRedirect, sameHost } from './format'
import { useArmedAction } from './useArmedAction'
import type { AccessLevel, CatalogueTool, ConsentFacts } from './types'

/** A consent needs a verification within this long (requireFreshAuth on the server, §5.2). */
const FRESH_MS = 120_000

type Outcome = { kind: 'allowed'; host: string } | { kind: 'cancelled' } | null

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex gap={3} py={2} borderBottom="1px solid" borderColor="page.border" _last={{ borderBottom: 'none' }} align="baseline">
      <Text as="dt" flex="0 0 84px" fontFamily={MONO} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary">
        {label}
      </Text>
      <Box as="dd" flex="1 1 auto" minW={0} fontSize="sm">
        {children}
      </Box>
    </Flex>
  )
}

/**
 * The consent of design §6.4, inside the sign-in card's look: the host the
 * app returns to leads, in ASCII (punycode for an IDN), then who the app is —
 * the host of its client document (verified by its address), a client this
 * site knows, or a name the app gave itself, flagged as unverifiable. No
 * logos. Warnings for a loopback-only return address and for more than one
 * request in the window. The three access levels, worded from the live
 * catalogue, pre-selected from the request but never above Read and draft;
 * the owner may raise it here. Unless the app and its return address are an
 * exact known pair, Allow waits for the owner to type that host.
 *
 * Allow is armed (useArmedAction: on screen for a second in a focused
 * window, then a pointer or the keyboard inside the card), asks for a
 * verification within 2 minutes, and posts with fetch — never a form, so
 * CSP's `form-action 'self'` never meets the app's redirect. The page then
 * follows the redirect the server built (code, state, iss) with
 * location.assign, after checking it is a web address. Cancel sends a known
 * pair back with access_denied; anything else stays here.
 */
export default function ConsentCard({
  facts,
  params,
  tools,
  levels,
  onUnauthorized,
}: {
  facts: ConsentFacts
  /** The authorize query this page was opened with, sent back unchanged. */
  params: string
  tools: CatalogueTool[]
  levels: AccessLevel[]
  onUnauthorized: () => void
}) {
  const id = useId()
  const c = AI_COPY.consent
  const { fetchWithStepUp, stepUpElement } = useStepUp()
  const [level, setLevel] = useState<number>(facts.preselectedLevel)
  const [typed, setTyped] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState<'allow' | 'cancel' | null>(null)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState<Outcome>(null)
  const host = facts.redirect.host
  const hostOk = facts.known || sameHost(typed, host)
  const { ref, armed } = useArmedAction<HTMLDivElement>(!outcome)
  const scopesOf = (n: number) => levels.find((l) => l.level === n)?.scopes ?? []

  const follow = (redirect: unknown): boolean => {
    if (!isWebRedirect(redirect)) {
      setError(c.badRedirect)
      return false
    }
    window.location.assign(redirect)
    return true
  }

  const allow = async () => {
    if (!armed || !hostOk || busy) return
    setBusy('allow')
    setError('')
    try {
      const res = await fetchWithStepUp(
        '/api/admin/ai/oauth/consent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ params, pairing_id: facts.pairingId, decision: 'allow', scopes: scopesOf(level), ...(facts.known ? {} : { typedHost: typed }) }),
        },
        c.stepUp,
        { freshWithinMs: FRESH_MS },
      )
      if (wasStepUpCancelled(res)) return
      if (res.status === 401) return onUnauthorized()
      const json = await readJsonObject(res)
      if (!res.ok) {
        setError(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
        return
      }
      // Say so first: when the app's own page doesn't take over, this is what stays on screen.
      setOutcome({ kind: 'allowed', host })
      follow(json.redirect)
    } catch {
      setError(NETWORK_ERROR)
    } finally {
      setBusy(null)
    }
  }

  const cancel = async () => {
    if (busy) return
    setBusy('cancel')
    setError('')
    try {
      const res = await fetch('/api/admin/ai/oauth/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params, decision: 'deny' }) })
      if (res.status === 401) return onUnauthorized()
      const json = await readJsonObject(res)
      setOutcome({ kind: 'cancelled' })
      if (res.ok && json.redirect) follow(json.redirect)
    } catch {
      // Refusing never depends on the server: nothing was allowed, so nothing was shared.
      setOutcome({ kind: 'cancelled' })
    } finally {
      setBusy(null)
    }
  }

  if (outcome) {
    return (
      <Box role="status" aria-live="polite">
        <Alert status={outcome.kind === 'allowed' ? 'success' : 'info'} variant="left-accent" borderRadius="md" fontSize="13px" bg="page.bg-elevated">
          <AlertIcon />
          <AlertDescription>{outcome.kind === 'allowed' ? c.done(outcome.host) : c.cancelled}</AlertDescription>
        </Alert>
        {error ? (
          <Text role="alert" mt={3} fontSize="sm" color="status.error">
            {error}
          </Text>
        ) : null}
      </Box>
    )
  }

  const unverified = facts.client.kind === 'dcr'
  const typedError = touched && typed.trim() && !hostOk ? c.typeHostMismatch(host) : ''

  return (
    <Box ref={ref} data-consent-card data-armed={armed ? 'true' : 'false'}>
      <Box as="dl" m={0}>
        <Fact label={c.returnsTo}>
          <Text fontFamily={MONO} fontSize="15px" fontWeight={600} overflowWrap="anywhere" data-testid="consent-host">
            {host}
          </Text>
          <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" overflowWrap="anywhere" mt={0.5}>
            {facts.redirect.uri}
          </Text>
        </Fact>
        <Fact label={c.identity}>
          {facts.client.knownName ? (
            <Text>{c.known(facts.client.knownName)}</Text>
          ) : !unverified && facts.client.host ? (
            <Text>
              <Box as="span" fontFamily={MONO} fontSize="13px">
                {facts.client.host}
              </Box>
              {`, ${c.verifiedBy}`}
            </Text>
          ) : (
            <Text {...warnTextProps}>{facts.client.selfName ? c.unverified(facts.client.selfName) : c.unnamed}</Text>
          )}
        </Fact>
      </Box>

      {facts.redirect.loopback ? (
        <Text mt={3} fontSize="13px" {...warnTextProps}>
          {c.loopback(host)}
        </Text>
      ) : null}
      {facts.requests > 1 ? (
        <Alert status="warning" variant="left-accent" borderRadius="md" fontSize="13px" bg="page.bg-elevated" mt={3}>
          <AlertIcon />
          <AlertDescription>{c.manyRequests(facts.requests)}</AlertDescription>
        </Alert>
      ) : null}

      <Box as="fieldset" mt={5} mx={0} mb={0} border="none" p={0} minW={0}>
        <Text as="legend" fontSize="12px" fontWeight={500} mb={2}>
          {c.access}
        </Text>
        <Stack spacing={2}>
          {levels.map((l) => {
            const s = levelSummary(l.level, tools)
            const checked = level === l.level
            return (
              <Box
                as="label"
                key={l.level}
                display="flex"
                alignItems="flex-start"
                gap={3}
                px={3}
                py={2.5}
                border="1px solid"
                borderColor={checked ? 'accent.500' : 'page.border-strong'}
                bg={checked ? 'var(--accent-soft)' : 'page.bg'}
                borderRadius="md"
                cursor="pointer"
                transition="border-color 150ms var(--ease-out-quart), background-color 150ms var(--ease-out-quart)"
                sx={{ '&:has(input:focus-visible)': { outline: '2px solid var(--chakra-colors-accent-500)', outlineOffset: '2px' } }}
              >
                <Box
                  as="input"
                  type="radio"
                  name={`${id}-level`}
                  value={String(l.level)}
                  checked={checked}
                  onChange={() => setLevel(l.level)}
                  mt="3px"
                  flexShrink={0}
                  sx={{ accentColor: 'var(--chakra-colors-accent-500)', width: '16px', height: '16px', '&:focus-visible': { outline: 'none' } }}
                />
                <Box minW={0}>
                  <Text as="span" fontSize="sm" fontWeight={600}>
                    {s.name}
                  </Text>
                  <Text fontSize="xs" color="page.fg-secondary" mt={0.5}>
                    {s.text}
                  </Text>
                </Box>
              </Box>
            )
          })}
        </Stack>
        {facts.requestedLevel > facts.preselectedLevel ? (
          <Text fontSize="xs" color="page.fg-secondary" mt={2}>
            {c.asked(levelName(facts.requestedLevel))}
          </Text>
        ) : null}
      </Box>

      {!facts.known ? (
        <FormControl mt={5} isInvalid={!!typedError}>
          <FormLabel htmlFor={`${id}-host`} fontSize="12px" fontWeight={500} mb={1.5}>
            {c.typeHost(host)}
          </FormLabel>
          <Input
            id={`${id}-host`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => setTouched(true)}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            fontFamily={MONO}
            fontSize="14px"
            {...inputProps}
          />
          {typedError ? <FormErrorMessage fontSize="12px">{typedError}</FormErrorMessage> : <FormHelperText fontSize="12px">{c.typeHostHelp}</FormHelperText>}
        </FormControl>
      ) : null}

      <Text mt={5} fontSize="12px" color="page.fg-secondary">
        {c.lasts}
      </Text>
      <Text mt={1.5} fontSize="12px" color="page.fg-secondary">
        {c.never}
      </Text>

      {error ? (
        <Text role="alert" mt={4} fontSize="sm" color="status.error">
          {error}
        </Text>
      ) : null}
      <Flex mt={5} gap={2} direction={{ base: 'column', sm: 'row' }}>
        <Button
          {...primaryButtonProps}
          flex={{ sm: '1 1 auto' }}
          onClick={() => void allow()}
          isDisabled={!armed || !hostOk || busy !== null}
          isLoading={busy === 'allow'}
          loadingText={c.allowing}
        >
          {c.allow}
        </Button>
        <Button {...outlineButtonProps} onClick={() => void cancel()} isDisabled={busy !== null} isLoading={busy === 'cancel'}>
          {c.cancel}
        </Button>
      </Flex>
      {stepUpElement}
    </Box>
  )
}
