import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import { Alert, AlertDescription, AlertIcon, Box, Button, Flex, Link, Spinner, Text } from '@chakra-ui/react'
import HeaderFooter from '../../../../layout/HeaderFooter'
import CustomHead from '../../../../components/General-UI/CustomHead'
import { AuthCard } from '../../../../components/Admin/AuthCard'
import { loginHref, readJsonObject } from '../../../../components/Admin/shell/http'
import { NETWORK_ERROR } from '../../../../components/Admin/shell/authMessages'
import { outlineButtonProps } from '../../../../components/Admin/shell/ui'
import { CHANGES_COPY } from '../../../../components/Admin/ai/copy'
import { actorText, kindCopy } from '../../../../components/Admin/ai/changeFormat'
import type { ChangeDetail, ChangeState } from '../../../../components/Admin/ai/types'

// Loaded with the page (design §11): nothing of the change card reaches _app or a public page.
const ChangeCard = dynamic(() => import('../../../../components/Admin/ai/ChangeCard'), {
  ssr: false,
  loading: function CardLoading() {
    return (
      <Flex h="160px" align="center" justify="center" role="status" aria-label={CHANGES_COPY.page.loading}>
        <Spinner color="accent.500" />
      </Flex>
    )
  },
})

const ID_RE = /^ch_[a-z2-7]{16}$/
const ALL_CHANGES = '/admin/ai?view=changes'

/**
 * One AI change on a page of its own (design §8.1, PRODUCT §6):
 * /admin/ai/change/<id>, the sign-in card's width. A connected app's
 * review_url is /ai/review/<id>, which bounces here with a same-site
 * navigation, so the Strict session cookie comes along and a signed-in owner
 * opens it straight away, without passing the sign-in form; a signed-out one
 * is sent to sign in by the proxy and comes back here. The address holds
 * only an opaque id and grants nothing: the change loads behind the session.
 */
export default function AdminAiChange() {
  const router = useRouter()
  const p = CHANGES_COPY.page
  const id = typeof router.query.id === 'string' ? router.query.id : ''
  const [detail, setDetail] = useState<ChangeDetail | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState('')

  const load = useCallback(async () => {
    if (!ID_RE.test(id)) {
      setState('missing')
      return
    }
    try {
      const res = await fetch(`/api/admin/ai/changes/${id}`, { cache: 'no-store', credentials: 'same-origin' })
      if (res.status === 401) {
        window.location.href = loginHref(`/admin/ai/change/${id}`)
        return
      }
      if (res.status === 404) {
        setState('missing')
        return
      }
      const json = await readJsonObject(res)
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
      setDetail(json as unknown as ChangeDetail)
      setState('ready')
      setError('')
    } catch (err) {
      setError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : NETWORK_ERROR)
      setState((s) => (s === 'ready' ? s : 'error'))
    }
  }, [id])

  useEffect(() => {
    if (router.isReady) void load()
  }, [router.isReady, load])

  const onDecided = (next: ChangeState) => {
    if (!detail) return
    const who = actorText(detail.actor)
    const mcp = detail.actor.kind === 'mcp'
    if (next === 'applied') setOutcome(mcp ? CHANGES_COPY.appWillSee(kindCopy(detail.kind).done, who) : `${kindCopy(detail.kind).done}.`)
    else if (next === 'rejected') setOutcome(mcp ? CHANGES_COPY.rejectedAppWillSee(who) : CHANGES_COPY.state.rejected)
    else if (next === 'undone') setOutcome(CHANGES_COPY.state.undone)
    else setOutcome('')
  }

  const title = detail ? CHANGES_COPY.wantsTo(actorText(detail.actor), detail.title) : state === 'missing' ? p.notFound : p.title
  const footer = (
    <Link as={NextLink} href={ALL_CHANGES} color="accent.text">
      {p.allChanges}
    </Link>
  )

  return (
    <>
      <CustomHead title={p.headTitle} noindex />
      <HeaderFooter>
        <AuthCard eyebrow={p.eyebrow} title={title} footer={footer}>
          {state === 'loading' ? (
            <Flex h="160px" align="center" justify="center" role="status" aria-label={p.loading}>
              <Spinner color="accent.500" />
            </Flex>
          ) : state === 'missing' ? (
            <Text fontSize="sm" color="page.fg-secondary" data-change-page="missing">
              {p.notFoundBody}
            </Text>
          ) : state === 'error' || !detail ? (
            <Box role="alert">
              <Alert status="error" variant="left-accent" borderRadius="md" fontSize="13px" bg="page.bg-elevated" role="presentation">
                <AlertIcon />
                <AlertDescription>{p.loadError(error)}</AlertDescription>
              </Alert>
              <Button size="sm" mt={4} {...outlineButtonProps} onClick={() => void load()}>
                {p.retry}
              </Button>
            </Box>
          ) : (
            <Box data-change-page="ready">
              <Box role="status" aria-live="polite">
                {outcome ? (
                  <Text fontSize="sm" fontWeight={600} mb={4} data-testid="change-outcome">
                    {outcome}
                  </Text>
                ) : null}
              </Box>
              <ChangeCard change={detail} reload={load} variant="page" onDecided={onDecided} />
            </Box>
          )}
        </AuthCard>
      </HeaderFooter>
    </>
  )
}
