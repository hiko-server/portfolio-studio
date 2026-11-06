import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import NextLink from 'next/link'
import { Alert, AlertDescription, AlertIcon, Box, Button, Flex, Link, Spinner, Text } from '@chakra-ui/react'
import HeaderFooter from '../../../layout/HeaderFooter'
import CustomHead from '../../../components/General-UI/CustomHead'
import { AuthCard } from '../../../components/Admin/AuthCard'
import { loginHref, readJsonObject } from '../../../components/Admin/shell/http'
import { NETWORK_ERROR } from '../../../components/Admin/shell/authMessages'
import { outlineButtonProps } from '../../../components/Admin/shell/ui'
import { AI_COPY } from '../../../components/Admin/ai/copy'
import type { AccessLevel, CatalogueTool, ConsentRequest } from '../../../components/Admin/ai/types'

// Loaded with the page (design §11): nothing of the consent reaches _app or a public page.
const ConsentCard = dynamic(() => import('../../../components/Admin/ai/ConsentCard'), {
  ssr: false,
  loading: function CardLoading() {
    return (
      <Flex h="160px" align="center" justify="center" role="status" aria-label={AI_COPY.consent.loading}>
        <Spinner color="accent.500" />
      </Flex>
    )
  },
})

const CONNECTIONS = '/admin/ai?view=connections'

type Loaded = { request: ConsentRequest; tools: CatalogueTool[]; levels: AccessLevel[]; params: string }

/**
 * The OAuth consent page (design §6.4, §8.1), /admin/ai/connect?<the
 * authorize parameters>. /oauth/authorize bounces here, same-site, so the
 * Strict session cookie comes along; a signed-out owner is sent to sign in by
 * the proxy and comes back to this exact address. Everything is checked
 * behind the session (GET /api/admin/ai/oauth/request): with no pairing
 * window open the page says that nothing is expected, an invalid request is
 * explained here and never redirected, and a valid one shows the consent
 * card. The parameters are read from location.search as they came and sent
 * back unchanged.
 */
export default function AdminAiConnect() {
  const c = AI_COPY.consent
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState('')

  const toLogin = useCallback(() => {
    window.location.href = loginHref(`${window.location.pathname}${window.location.search}`)
  }, [])

  const load = useCallback(async () => {
    const params = window.location.search.replace(/^\?/, '')
    try {
      const [reqRes, catRes] = await Promise.all([
        fetch(`/api/admin/ai/oauth/request?${params}`, { cache: 'no-store', credentials: 'same-origin' }),
        fetch('/api/admin/ai/catalogue', { cache: 'no-store', credentials: 'same-origin' }),
      ])
      if (reqRes.status === 401 || catRes.status === 401) return toLogin()
      const request = await readJsonObject(reqRes)
      const catalogue = await readJsonObject(catRes)
      if (!reqRes.ok) throw new Error(typeof request.error === 'string' ? request.error : `HTTP ${reqRes.status}`)
      setData({
        request: request as unknown as ConsentRequest,
        tools: Array.isArray(catalogue.tools) ? (catalogue.tools as CatalogueTool[]) : [],
        levels: Array.isArray(catalogue.levels) ? (catalogue.levels as AccessLevel[]) : [],
        params,
      })
      setLoadError('')
    } catch (err) {
      setLoadError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : NETWORK_ERROR)
    }
  }, [toLogin])

  useEffect(() => {
    void load()
  }, [load])

  const request = data?.request
  const title =
    request?.state === 'ok'
      ? c.title(request.facts.redirect.host, request.facts.site)
      : request?.state === 'closed'
        ? c.closedTitle
        : request?.state === 'invalid'
          ? c.invalidTitle
          : c.headTitle
  const footer = (
    <Link as={NextLink} href={CONNECTIONS} color="accent.text">
      {c.openConnections}
    </Link>
  )

  return (
    <>
      <CustomHead title={c.headTitle} noindex />
      <HeaderFooter>
        <AuthCard eyebrow={c.eyebrow} title={title} subtitle={request?.state === 'ok' ? c.subtitle : undefined} footer={request && request.state !== 'ok' ? footer : undefined}>
          {loadError && !data ? (
            <Box role="alert">
              <Alert status="error" variant="left-accent" borderRadius="md" fontSize="13px" bg="page.bg-elevated" role="presentation">
                <AlertIcon />
                <AlertDescription>{c.loadError(loadError)}</AlertDescription>
              </Alert>
              <Button size="sm" mt={4} {...outlineButtonProps} onClick={() => void load()}>
                {c.retry}
              </Button>
            </Box>
          ) : !data || !request ? (
            <Flex h="160px" align="center" justify="center" role="status" aria-label={c.loading}>
              <Spinner color="accent.500" />
            </Flex>
          ) : request.state === 'closed' ? (
            <Text fontSize="sm" data-consent-state="closed">
              {request.apps ? c.closed : c.appsOff}
            </Text>
          ) : request.state === 'invalid' ? (
            <Box data-consent-state="invalid">
              <Text fontSize="sm">{request.message}</Text>
              <Text fontSize="sm" color="page.fg-secondary" mt={2}>
                {c.invalidAfter}
              </Text>
            </Box>
          ) : (
            <ConsentCard facts={request.facts} params={data.params} tools={data.tools} levels={data.levels} onUnauthorized={toLogin} />
          )}
        </AuthCard>
      </HeaderFooter>
    </>
  )
}
