import { expect, test } from './fixtures'

/**
 * The AI admin flows, on the standalone server scripts/ai-e2e.sh starts. Stage
 * P0 holds the harness check; the stages that build each flow add theirs here,
 * and M2 puts a draft write first (design §12.4: it proves the MDX worker chunk
 * is in the standalone output).
 */
const FAKE = process.env.E2E_FAKE_LLM_URL

test.describe('@ai harness', () => {
  test('the server on loopback serves the synthetic fixture store', async ({ page, baseURL }) => {
    expect(new URL(baseURL ?? '').hostname).toBe('127.0.0.1')
    await page.goto('/')
    await expect(page.getByText('Example Person').first()).toBeVisible()
    await page.goto('/blog')
    await expect(page.locator('a[href="/blog/example-field-notes"]').first()).toBeVisible()
  })

  test('the fake provider answers next to it, on loopback, in the three wires', async () => {
    // The AI projects exist only when scripts/ai-e2e.sh sets it (e2e/playwright.config.ts).
    expect(FAKE, 'E2E_FAKE_LLM_URL').toBeTruthy()
    const origin = new URL(FAKE ?? '')
    expect(origin.hostname).toBe('127.0.0.1')
    const headers = { 'content-type': 'application/json', authorization: 'Bearer e2e-test-key' }

    const health = await fetch(`${FAKE}/__fake/health`)
    expect(health.status).toBe(200)

    const models = await (await fetch(`${FAKE}/v1/models`, { headers })).json()
    expect(models.data.map((m: { id: string }) => m.id)).toContain('fake-model')

    const say = '/say Harness check.'
    const chat = await (await fetch(`${FAKE}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: say }] }) })).json()
    expect(chat.choices[0].message.content).toBe('Harness check.')

    const responses = await (await fetch(`${FAKE}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'fake-model', input: say }) })).json()
    expect(responses.status).toBe('completed')

    const claude = await (await fetch(`${FAKE}/v1/messages`, { method: 'POST', headers: { ...headers, 'anthropic-version': '2026-10-21' }, body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1024, messages: [{ role: 'user', content: say }] }) })).json()
    expect(claude.content.at(-1).text).toBe('Harness check.')
  })
})
