import { ADMIN, expect, loginAsAdmin, test } from './fixtures'

/**
 * Signing in over plain http on loopback in a production build. The session
 * cookie is Secure there. Chromium stores and sends a Secure cookie on
 * http://127.0.0.1, and the existing `admin` project has always run that way;
 * Firefox was the open question of stage P0 (docs/ai-trial.md records the
 * answer). The consent flow of stage M5 stands on this, so it stays as a check
 * in both AI projects.
 */
test.describe('@ai sign-in on plain http, production build', () => {
  test.skip(!ADMIN.email || !ADMIN.password, 'ADMIN_EMAIL / ADMIN_PASS not set')

  test('the form signs in; the Secure session cookie is stored and sent back', async ({ page, context, baseURL }) => {
    expect(new URL(baseURL ?? '').protocol).toBe('http:')
    expect(new URL(baseURL ?? '').hostname).toBe('127.0.0.1')

    await loginAsAdmin(page, { fresh: true })
    await expect(page).not.toHaveURL(/\/admin\/login/)

    const session = (await context.cookies()).find((c) => c.name === 'cv_admin_token')
    expect(session, 'the browser kept the session cookie').toBeTruthy()
    expect(session?.secure).toBe(true)
    expect(session?.httpOnly).toBe(true)

    // Sent back: the page's own fetch reaches a route that needs the session.
    const status = await page.evaluate(async () => (await fetch('/api/admin/overview', { credentials: 'same-origin' })).status)
    expect(status).toBe(200)

    // And still there after a reload, which is what a consent page would be.
    await page.reload()
    await expect(page).not.toHaveURL(/\/admin\/login/)
  })

  test('with no session, the same route answers 401 and the admin sends you to sign in', async ({ page }) => {
    // Outside the page: a browser logs a refused fetch as a console error, which the fixture counts as a failure.
    expect((await page.request.get('/api/admin/overview')).status()).toBe(401)
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/login/)
  })
})
