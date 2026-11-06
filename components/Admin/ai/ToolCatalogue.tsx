import { useId, useMemo, useState } from 'react'
import { Badge, Box, Flex, FormControl, FormLabel, Select, Text } from '@chakra-ui/react'
import { MONO, inputProps } from '../shell/ui'
import { AI_COPY, RISK_COPY, levelName } from './copy'
import type { AccessLevel, CatalogueTool, Risk } from './types'

const RISK_ORDER: Risk[] = ['read', 'draft', 'live', 'destructive']

/**
 * [04] What apps can do: the server's real tool catalogue
 * (GET /api/admin/ai/catalogue, design §8.6 — rendered from it, never
 * hand-written), grouped by what a call does, with the lowest access level
 * that includes each tool, filtered by level. Ends with what no tool can do.
 */
export default function ToolCatalogue({ tools, levels }: { tools: CatalogueTool[]; levels: AccessLevel[] }) {
  const id = useId()
  const [level, setLevel] = useState(0)
  const shown = useMemo(() => (level ? tools.filter((t) => t.level <= level) : tools), [tools, level])
  const groups = RISK_ORDER.map((risk) => ({ risk, tools: shown.filter((t) => t.risk === risk) })).filter((g) => g.tools.length)

  return (
    <Box>
      <FormControl display="flex" alignItems="center" gap={3} flexWrap="wrap" mb={4} maxW="100%">
        <FormLabel htmlFor={`${id}-level`} mb={0} fontSize="sm" fontWeight={500}>
          {AI_COPY.catalogue.filter}
        </FormLabel>
        <Select
          id={`${id}-level`}
          size="sm"
          maxW="280px"
          borderRadius="md"
          value={String(level)}
          onChange={(e) => setLevel(Number(e.target.value))}
          {...inputProps}
        >
          <option value="0">{`${AI_COPY.catalogue.everyLevel} · ${AI_COPY.catalogue.tools(tools.length)}`}</option>
          {levels.map((l) => (
            <option key={l.level} value={String(l.level)}>
              {`${levelName(l.level)} · ${AI_COPY.catalogue.tools(tools.filter((t) => t.level <= l.level).length)}`}
            </option>
          ))}
        </Select>
      </FormControl>

      <Box role="status" aria-live="polite" srOnly>
        {`${AI_COPY.catalogue.tools(shown.length)}${level ? ` at ${levelName(level)}` : ''}.`}
      </Box>

      {groups.length === 0 ? (
        <Text fontSize="sm" color="page.fg-secondary">
          {AI_COPY.catalogue.empty}
        </Text>
      ) : null}
      {groups.map((g) => (
        <Box as="section" key={g.risk} aria-labelledby={`${id}-${g.risk}`} mb={6} _last={{ mb: 0 }}>
          <Flex align="baseline" justify="space-between" gap={3} flexWrap="wrap" mb={2}>
            <Text as="h3" id={`${id}-${g.risk}`} fontSize="sm" fontWeight={600}>
              {RISK_COPY[g.risk].title}
              <Box as="span" fontFamily={MONO} fontSize="11px" fontWeight={400} color="page.fg-secondary" ml={2} className="tnum">
                {AI_COPY.catalogue.tools(g.tools.length)}
              </Box>
            </Text>
            <Text fontSize="xs" color="page.fg-secondary">
              {RISK_COPY[g.risk].means}
            </Text>
          </Flex>
          <Box as="ul" listStyleType="none" border="1px solid" borderColor="page.border" borderRadius="lg">
            {g.tools.map((t) => (
              <Box
                as="li"
                key={t.name}
                px={{ base: 3, md: 4 }}
                py={3}
                borderBottom="1px solid"
                borderColor="page.border"
                _last={{ borderBottom: 'none' }}
              >
                <Flex align="baseline" gap={2} flexWrap="wrap">
                  <Text as="span" fontSize="sm" fontWeight={600}>
                    {t.title}
                  </Text>
                  <Text as="code" fontFamily={MONO} fontSize="11px" color="page.fg-secondary" wordBreak="break-all">
                    {t.name}
                  </Text>
                  <Badge variant="outline" colorScheme="gray" fontFamily={MONO} fontSize="9px" fontWeight={500} ml={{ base: 0, md: 'auto' }}>
                    {AI_COPY.catalogue.fromLevel(t.level)}
                  </Badge>
                </Flex>
                <Text fontSize="13px" color="page.fg-secondary" mt={1} maxW="78ch">
                  {t.description}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ))}

      <Text fontSize="xs" color="page.fg-secondary" mt={4} maxW="78ch">
        {AI_COPY.catalogue.never}
      </Text>
    </Box>
  )
}
