import { useEffect, useState } from 'react'
import type { Root as HastRoot } from 'hast'
import { Alert, AlertDescription, AlertIcon, Box, Button, Flex, Select, Spinner, Text } from '@chakra-ui/react'
import MDXContent from '../../MDX/MDXContent'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { MONO, outlineButtonProps } from '../shell/ui'
import { CHANGES_COPY } from './copy'
import type { PreviewDocument } from './types'

type Loaded = { tree: HastRoot; replaced: { images: number; embeds: number; links: number } }

/**
 * The review sheet's Preview tab (design §8.2): one MDX document of the
 * change as the site's renderer draws it, from GET …/changes/<id>/preview —
 * compiled in the AI worker and made inert on the server (images from other
 * sites, players and links replaced), so nothing here loads or navigates.
 */
export default function ChangePreviewPane({ changeId, docs }: { changeId: string; docs: Array<{ d: PreviewDocument; i: number }> }) {
  const [pick, setPick] = useState(docs[0]?.i ?? 0)
  const [state, setState] = useState<{ loading: boolean; data: Loaded | null; error: string }>({ loading: true, data: null, error: '' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    setState({ loading: true, data: null, error: '' })
    void (async () => {
      try {
        const res = await fetch(`/api/admin/ai/changes/${changeId}/preview?doc=${pick}`, { cache: 'no-store', credentials: 'same-origin', signal: ctrl.signal })
        const json = await readJsonObject(res)
        if (ctrl.signal.aborted) return
        if (!res.ok) return setState({ loading: false, data: null, error: typeof json.error === 'string' ? json.error : `HTTP ${res.status}` })
        setState({ loading: false, data: json as unknown as Loaded, error: '' })
      } catch {
        if (!ctrl.signal.aborted) setState({ loading: false, data: null, error: NETWORK_ERROR })
      }
    })()
    return () => ctrl.abort()
  }, [changeId, pick, attempt])

  if (!docs.length) {
    return (
      <Text fontSize="sm" color="page.fg-secondary">
        {CHANGES_COPY.sheet.previewNone}
      </Text>
    )
  }

  return (
    <Box>
      <Text fontSize="xs" color="page.fg-secondary" mb={3}>
        {CHANGES_COPY.sheet.previewNote}
      </Text>
      {docs.length > 1 ? (
        <Flex align="center" gap={2} mb={3}>
          <Text as="label" htmlFor={`preview-doc-${changeId}`} fontSize="12px" fontWeight={500} flexShrink={0}>
            {CHANGES_COPY.sheet.previewPick}
          </Text>
          <Select id={`preview-doc-${changeId}`} size="sm" value={pick} onChange={(e) => setPick(Number(e.target.value))} maxW="100%">
            {docs.map(({ d, i }) => (
              <option key={d.ref} value={i}>
                {d.label}
              </option>
            ))}
          </Select>
        </Flex>
      ) : null}
      {state.loading ? (
        <Flex h="160px" align="center" justify="center" role="status" aria-label={CHANGES_COPY.sheet.previewLoading}>
          <Spinner color="accent.500" />
        </Flex>
      ) : state.error ? (
        <Alert status="warning" variant="left-accent" borderRadius="md" bg="page.bg" fontSize="sm" alignItems="center" gap={2} flexWrap="wrap">
          <AlertIcon />
          <AlertDescription flex={1}>{CHANGES_COPY.sheet.previewError(state.error)}</AlertDescription>
          <Button size="xs" {...outlineButtonProps} onClick={() => setAttempt((n) => n + 1)}>
            {CHANGES_COPY.page.retry}
          </Button>
        </Alert>
      ) : state.data ? (
        <Box
          border="1px solid"
          borderColor="page.border"
          borderRadius="md"
          bg="page.bg"
          px={{ base: 4, md: 6 }}
          py={5}
          data-testid="change-preview"
          sx={{
            '& .ai-preview-link': { color: 'accent.text', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '0.15em' },
            '& .ai-preview-blocked': {
              display: 'inline-block',
              fontFamily: MONO,
              fontSize: '12px',
              color: 'page.fg-secondary',
              border: '1px dashed',
              borderColor: 'page.border-strong',
              borderRadius: 'sm',
              px: 2,
              py: 1,
              wordBreak: 'break-all',
            },
          }}
        >
          <MDXContent tree={state.data.tree} as="div" />
        </Box>
      ) : null}
    </Box>
  )
}
