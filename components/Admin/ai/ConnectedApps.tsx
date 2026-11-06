import { useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Badge,
  Box,
  Button,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Text,
} from '@chakra-ui/react'
import { MONO, SectionLabel, inputProps, outlineButtonProps, primaryButtonProps, warnTextProps } from '../shell/ui'
import { absoluteTime, relativeTime } from '../security/securityFormat'
import { AI_COPY, levelName } from './copy'
import type { AppView } from './types'

const ROW = {
  as: 'li' as const,
  px: { base: 3, md: 4 },
  py: 3,
  borderBottom: '1px solid',
  borderColor: 'page.border',
  _last: { borderBottom: 'none' },
}

function When({ at, now }: { at: number; now: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>
      {relativeTime(at, now)}
    </time>
  )
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" className="tnum" mt={0.5}>
      {children}
    </Text>
  )
}

/** " · " between the parts that exist. */
function joined(parts: React.ReactNode[]): React.ReactNode[] {
  const out: React.ReactNode[] = []
  parts.filter(Boolean).forEach((p, i) => {
    if (i) out.push(' · ')
    out.push(<Box as="span" key={i}>{p}</Box>)
  })
  return out
}

/**
 * [03] Connected apps (design §8.5, PRODUCT §7.1): every app that may act,
 * as hairline rows like Security's signed-in browsers — the owner's name for
 * it, its kind and access level, the last four characters of its token,
 * what it says it is (self-declared, flagged when that changed), use, and
 * when it ends. Rename; revoke one or all (no step-up: reducing access has
 * no friction).
 */
export default function ConnectedApps({
  index,
  apps,
  now,
  busy,
  onRename,
  onRevoke,
  onRevokeAll,
}: {
  index: number
  apps: AppView[]
  now: number
  busy: string | null
  onRename: (app: AppView, name: string) => Promise<boolean>
  onRevoke: (app: AppView) => Promise<void>
  onRevokeAll: () => Promise<void>
}) {
  const [renaming, setRenaming] = useState<AppView | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [revoking, setRevoking] = useState<AppView | null>(null)
  const [revokingAll, setRevokingAll] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const cancelAllRef = useRef<HTMLButtonElement>(null)
  const c = AI_COPY.apps

  return (
    <>
      <SectionLabel
        index={index}
        title={c.title}
        id="ai-apps"
        hint={c.hint}
        action={
          apps.length > 1 ? (
            <Button size="sm" variant="ghost" color="status.error" onClick={() => setRevokingAll(true)} isLoading={busy === 'revoke-all'}>
              {c.revokeAll}
            </Button>
          ) : null
        }
      />
      {apps.length === 0 ? (
        <Text fontSize="sm" color="page.fg-secondary">
          {c.empty}
        </Text>
      ) : (
        <Box as="ul" listStyleType="none" border="1px solid" borderColor="page.border" borderRadius="lg" aria-labelledby="ai-apps">
          {apps.map((a) => (
            <Flex key={a.id} {...ROW} align="center" gap={3} flexWrap="wrap" data-app-id={a.id}>
              <Box flex="1 1 260px" minW={0}>
                <Flex align="center" gap={2} flexWrap="wrap">
                  <Text fontSize="sm" fontWeight={600} wordBreak="break-word">
                    {a.name}
                  </Text>
                  <Badge variant="subtle" colorScheme="gray" fontFamily={MONO} fontSize="9px">
                    {a.kind === 'oauth' ? c.oauth : c.token}
                  </Badge>
                  <Badge variant="subtle" colorScheme="purple" fontFamily={MONO} fontSize="9px">
                    {levelName(a.level)}
                  </Badge>
                </Flex>
                <Meta>
                  {joined([
                    a.hint ? c.tokenHint(a.hint) : null,
                    a.clientReported ? c.saysItIs(a.clientReported) : null,
                    a.lastUsedAt ? (
                      <>
                        {`${c.lastUsed} `}
                        <When at={a.lastUsedAt} now={now} />
                      </>
                    ) : (
                      c.notUsed
                    ),
                    a.callsThisWeek ? c.callsThisWeek(a.callsThisWeek) : null,
                    <>
                      {`${c.expires} `}
                      <When at={a.expiresAt} now={now} />
                    </>,
                  ])}
                </Meta>
                {a.clientReportedChangedAt ? (
                  <Text fontSize="11px" mt={0.5} {...warnTextProps}>
                    {`${c.nameChanged} `}
                    <When at={a.clientReportedChangedAt} now={now} />
                    {c.nameChangedWhy}
                  </Text>
                ) : null}
                <Text fontSize="11px" color="page.fg-secondary" mt={0.5}>
                  {`${c.made} `}
                  <When at={a.createdAt} now={now} />
                  {c.madeOn(a.createdDevice, a.createdHere)}
                </Text>
              </Box>
              <Flex gap={2}>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setRenaming(a)
                    setRenameValue(a.name)
                  }}
                >
                  {c.rename}
                  <Box as="span" srOnly>
                    {` ${a.name}`}
                  </Box>
                </Button>
                <Button size="xs" {...outlineButtonProps} onClick={() => setRevoking(a)} isLoading={busy === `revoke:${a.id}`}>
                  {c.revoke}
                  <Box as="span" srOnly>
                    {` ${a.name}`}
                  </Box>
                </Button>
              </Flex>
            </Flex>
          ))}
        </Box>
      )}

      <Modal isOpen={!!renaming} onClose={() => setRenaming(null)} isCentered size="sm">
        <ModalOverlay />
        <ModalContent bg="page.bg-elevated" border="1px solid" borderColor="page.border" mx={4}>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              if (renaming && (await onRename(renaming, renameValue))) setRenaming(null)
            }}
          >
            <ModalHeader fontSize="md">{c.renameTitle}</ModalHeader>
            <ModalCloseButton />
            <ModalBody>
              <FormControl>
                <FormLabel fontSize="12px">{c.nameLabel}</FormLabel>
                <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={48} autoFocus {...inputProps} />
                <FormHelperText fontSize="xs">{c.nameHelp}</FormHelperText>
              </FormControl>
            </ModalBody>
            <ModalFooter gap={2}>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                {c.cancel}
              </Button>
              <Button size="sm" type="submit" {...primaryButtonProps} isLoading={busy === `rename:${renaming?.id}`} isDisabled={!renameValue.trim()}>
                {c.save}
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>

      <AlertDialog isOpen={!!revoking} leastDestructiveRef={cancelRef} onClose={() => setRevoking(null)} isCentered>
        <AlertDialogOverlay>
          <AlertDialogContent bg="page.bg-elevated" border="1px solid" borderColor="page.border" mx={4}>
            <AlertDialogHeader fontSize="md">{revoking ? c.revokeTitle(revoking.name) : ''}</AlertDialogHeader>
            <AlertDialogBody fontSize="sm">{c.revokeBody}</AlertDialogBody>
            <AlertDialogFooter gap={2}>
              <Button ref={cancelRef} size="sm" {...outlineButtonProps} onClick={() => setRevoking(null)}>
                {c.cancel}
              </Button>
              <Button
                size="sm"
                colorScheme="red"
                onClick={async () => {
                  const target = revoking
                  setRevoking(null)
                  if (target) await onRevoke(target)
                }}
              >
                {c.revoke}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>

      <AlertDialog isOpen={revokingAll} leastDestructiveRef={cancelAllRef} onClose={() => setRevokingAll(false)} isCentered>
        <AlertDialogOverlay>
          <AlertDialogContent bg="page.bg-elevated" border="1px solid" borderColor="page.border" mx={4}>
            <AlertDialogHeader fontSize="md">{c.revokeAllTitle}</AlertDialogHeader>
            <AlertDialogBody fontSize="sm">{c.revokeAllBody(apps.length)}</AlertDialogBody>
            <AlertDialogFooter gap={2}>
              <Button ref={cancelAllRef} size="sm" {...outlineButtonProps} onClick={() => setRevokingAll(false)}>
                {c.cancel}
              </Button>
              <Button
                size="sm"
                colorScheme="red"
                onClick={async () => {
                  setRevokingAll(false)
                  await onRevokeAll()
                }}
              >
                {c.revokeAll}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </>
  )
}
