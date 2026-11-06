import dynamic from 'next/dynamic'
import { Flex, Spinner } from '@chakra-ui/react'
import { AdminPageShell } from '../../components/Admin/shell/ui'
import { AI_COPY } from '../../components/Admin/ai/copy'

// Loaded with the view (design §11): nothing of Admin → AI reaches _app or a public page.
const ConnectionsPanel = dynamic(() => import('../../components/Admin/ai/ConnectionsPanel'), {
  ssr: false,
  loading: function PanelLoading() {
    return (
      <Flex h="30vh" align="center" justify="center" role="status" aria-label={AI_COPY.page.loading}>
        <Spinner color="accent.500" />
      </Flex>
    )
  },
})

/**
 * Admin → AI (design §8.1). Connections is its view so far
 * (/admin/ai?view=connections, also /admin/ai): AI access, connecting an app
 * with a personal token, the connected apps and the tool catalogue. The
 * assistant, Changes and Models views join it in their stages, each a
 * dynamic() panel behind SegmentedTabs like Admin → System.
 */
export default function AdminAi() {
  return (
    <AdminPageShell headTitle={AI_COPY.page.headTitle} eyebrow={AI_COPY.page.eyebrow} title={AI_COPY.page.title}>
      <ConnectionsPanel />
    </AdminPageShell>
  )
}
