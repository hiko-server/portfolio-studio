import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import { Box, Flex, Spinner } from '@chakra-ui/react'
import { AdminPageShell } from '../../components/Admin/shell/ui'
import SegmentedTabs, { tabPanelProps, type SegmentedItem } from '../../components/Admin/shell/SegmentedTabs'
import { AI_COPY } from '../../components/Admin/ai/copy'

const panelLoading = (label: string) =>
  function PanelLoading() {
    return (
      <Flex h="30vh" align="center" justify="center" role="status" aria-label={label}>
        <Spinner color="accent.500" />
      </Flex>
    )
  }

// Loaded with their view (design §11): nothing of Admin → AI reaches _app or a public page.
const AssistantPanel = dynamic(() => import('../../components/Admin/ai/AssistantPanel'), {
  ssr: false,
  loading: panelLoading(AI_COPY.tabs.loadingAssistant),
})
const ChangesPanel = dynamic(() => import('../../components/Admin/ai/ChangesPanel'), {
  ssr: false,
  loading: panelLoading(AI_COPY.tabs.loadingChanges),
})
const ConnectionsPanel = dynamic(() => import('../../components/Admin/ai/ConnectionsPanel'), {
  ssr: false,
  loading: panelLoading(AI_COPY.page.loading),
})
const ModelsPanel = dynamic(() => import('../../components/Admin/ai/ModelsPanel'), {
  ssr: false,
  loading: panelLoading(AI_COPY.tabs.loadingModels),
})

const AI_VIEWS = ['assistant', 'changes', 'connections', 'models'] as const
type View = (typeof AI_VIEWS)[number]
const isView = (v: unknown): v is View => typeof v === 'string' && (AI_VIEWS as readonly string[]).includes(v)
/** The view /admin/ai opens on: the assistant (design §8.1). */
const DEFAULT_VIEW: View = 'assistant'

/**
 * Admin → AI (design §8.1): one page, its views behind SegmentedTabs in the
 * title bar like Admin → System, each a dynamic() panel.
 *   /admin/ai                    the assistant (?c=<id> one conversation)
 *   /admin/ai?view=changes       what AI proposed and what became of it
 *   /admin/ai?view=connections   access, connecting an app, connected apps,
 *                                the tool catalogue
 *   /admin/ai?view=models        model keys, the assistant's settings, usage,
 *                                what leaves this server
 */
export default function AdminAi() {
  const router = useRouter()
  const [view, setView] = useState<View>(DEFAULT_VIEW)
  const [waiting, setWaiting] = useState<number | null>(null)
  const [openAdd, setOpenAdd] = useState(false)

  useEffect(() => {
    if (!router.isReady) return
    setView(isView(router.query.view) ? router.query.view : DEFAULT_VIEW)
  }, [router.isReady, router.query.view])

  // The Changes tab carries the waiting count, like a badge (PRODUCT §3).
  const loadWaiting = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/ai/summary', { cache: 'no-store', credentials: 'same-origin' })
      if (!res.ok) return
      const json = (await res.json()) as { waiting?: unknown }
      setWaiting(typeof json.waiting === 'number' ? json.waiting : null)
    } catch {
      // The tab simply shows no count.
    }
  }, [])
  useEffect(() => {
    void loadWaiting()
  }, [loadWaiting, view])

  const go = useCallback(
    (next: View) => {
      setView(next)
      const query = { ...router.query }
      // A conversation belongs to the assistant view; other views start from their own top.
      delete query.c
      if (next !== DEFAULT_VIEW) query.view = next
      else delete query.view
      void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true, scroll: false })
    },
    [router],
  )

  const items: SegmentedItem<View>[] = [
    { key: 'assistant', label: AI_COPY.tabs.assistant },
    { key: 'changes', label: waiting ? AI_COPY.tabs.changesWaiting(waiting) : AI_COPY.tabs.changes },
    { key: 'connections', label: AI_COPY.tabs.connections },
    { key: 'models', label: AI_COPY.tabs.models },
  ]

  return (
    <AdminPageShell
      headTitle={AI_COPY.page.headTitle}
      eyebrow={AI_COPY.page.eyebrow}
      title={AI_COPY.page.title}
      actions={<SegmentedTabs items={items} value={view} onSelect={go} label={AI_COPY.tabs.label} idPrefix="ai" size="sm" />}
    >
      <Box {...tabPanelProps('ai', view)}>
        {view === 'assistant' ? (
          <AssistantPanel
            onShowModels={() => go('models')}
            onShowConnections={() => go('connections')}
            onAddModel={() => {
              setOpenAdd(true)
              go('models')
            }}
            onChangesMoved={() => void loadWaiting()}
          />
        ) : view === 'changes' ? (
          <ChangesPanel onShowConnections={() => go('connections')} onWaiting={setWaiting} />
        ) : view === 'models' ? (
          <ModelsPanel openAdd={openAdd} onAddHandled={() => setOpenAdd(false)} onShowChanges={() => go('changes')} />
        ) : (
          <ConnectionsPanel onShowChanges={() => go('changes')} />
        )}
      </Box>
    </AdminPageShell>
  )
}
