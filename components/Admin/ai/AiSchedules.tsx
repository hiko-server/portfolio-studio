import { Box, Checkbox, Text } from '@chakra-ui/react'
import { MONO } from '../shell/ui'
import { AI_COPY } from './copy'
import { formatMoment } from './changeFormat'
import type { AiSchedule } from './types'

/**
 * The schedules approved AI changes set that have not run yet (design §5.2,
 * §5.4; THREATS R17), inside the "Turn off AI access" and "Revoke" dialogs:
 * turning AI off or revoking an app stops what it can do next, not what it
 * already scheduled, so the dialog lists them and offers to clear them.
 */
export function AiSchedulesNote({ schedules, checked, onChange, id }: { schedules: AiSchedule[]; checked: boolean; onChange: (v: boolean) => void; id: string }) {
  if (!schedules.length) return null
  const s = AI_COPY.schedules
  return (
    <Box mt={4} data-testid="ai-schedules">
      <Text fontSize="sm">{s.intro(schedules.length)}</Text>
      <Box as="ul" listStyleType="none" mt={1.5} display="grid" gap={1}>
        {schedules.map((x) => (
          <Box as="li" key={`${x.collection}/${x.slug}`} fontSize="13px">
            {s.post(x.collection)}{' '}
            <Text as="span" fontFamily={MONO} fontSize="12px">
              {x.slug}
            </Text>
            <Text as="span" color="page.fg-secondary">
              {' · '}
              {[x.publishAt ? s.goesLive(formatMoment(x.publishAt)) : '', x.unpublishAt ? s.comesOff(formatMoment(x.unpublishAt)) : ''].filter(Boolean).join(', ')}
            </Text>
          </Box>
        ))}
      </Box>
      <Checkbox mt={3} isChecked={checked} onChange={(e) => onChange(e.target.checked)} colorScheme="purple" aria-describedby={`${id}-help`}>
        <Text as="span" fontSize="sm">
          {s.clear(schedules.length)}
        </Text>
      </Checkbox>
      <Text id={`${id}-help`} mt={1} ml={6} fontSize="12px" color="page.fg-secondary">
        {s.clearHelp}
      </Text>
    </Box>
  )
}

/**
 * Clear schedules through the editor's own schedule action (POST
 * /api/admin/posts|work { action: 'schedule', publishAt: null, unpublishAt:
 * null }): the same write, the same activity row, as clearing it by hand.
 */
export async function clearAiSchedules(schedules: AiSchedule[]): Promise<{ cleared: number; failed: number }> {
  let cleared = 0
  let failed = 0
  for (const x of schedules) {
    try {
      const res = await fetch(x.collection === 'blog' ? '/api/admin/posts' : '/api/admin/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'schedule', slug: x.slug, publishAt: null, unpublishAt: null }),
      })
      if (res.ok) cleared++
      else failed++
    } catch {
      failed++
    }
  }
  return { cleared, failed }
}
