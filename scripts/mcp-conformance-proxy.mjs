#!/usr/bin/env node
/**
 * A loopback proxy for the MCP conformance suite (design §12.3), which cannot
 * send headers: it forwards every request to a local server and adds the
 * bearer token. The product has no test bypass; this is the test's side.
 *
 *   MCP_CONFORMANCE_TOKEN=<token> node scripts/mcp-conformance-proxy.mjs <port> <server origin>
 *
 * The token comes from the environment (never argv, which `ps` shows) and is
 * never printed. A request addressed to the proxy itself (Host: 127.0.0.1:<port>)
 * goes on as addressed to the server; any other Host, and every Origin, is
 * passed on unchanged, so the suite's DNS-rebinding checks reach the server's
 * own Host and Origin rules. Loopback only, on both sides.
 *
 * A whole run sends more than a grant's 60 requests a minute (lib/ai/budgets):
 * a 429 from the server is waited out (its Retry-After, at most 70 s) and the
 * same request sent again, twice at most. The suite tests the protocol; the
 * budget itself is tested in tests/ai-mcp-route.
 */
import http from 'node:http'

const [portArg, targetArg] = process.argv.slice(2)
const token = process.env.MCP_CONFORMANCE_TOKEN || ''
const port = Number(portArg)
let target
try {
  target = new URL(targetArg)
} catch {
  target = null
}
const loopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
if (!Number.isInteger(port) || port < 1024 || !target || target.protocol !== 'http:' || !loopback(target.hostname) || !/^ps[tor]_[A-Za-z0-9_-]{43}$/.test(token)) {
  process.stderr.write('Usage: MCP_CONFORMANCE_TOKEN=<pst_ token> node scripts/mcp-conformance-proxy.mjs <port> <http://127.0.0.1:<server port>>\n')
  process.exit(2)
}

const own = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

const RETRIES = 2

/** Send one request upstream; resolves with the response, already read when it is a 429. */
function forward(req, headers, body) {
  return new Promise((resolve, reject) => {
    const upstream = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers }, (up) => {
      if (up.statusCode !== 429) return resolve({ up, retryAfter: null })
      up.resume()
      up.on('end', () => resolve({ up, retryAfter: Number(up.headers['retry-after']) }))
    })
    upstream.on('error', reject)
    upstream.end(body)
  })
}

const server = http.createServer(async (req, res) => {
  const headers = { ...req.headers, authorization: `Bearer ${token}` }
  if (!req.headers.host || own.has(String(req.headers.host).toLowerCase())) headers.host = target.host
  // Read whole, so a request can be sent again after a 429 (the suite's requests are small).
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  try {
    for (let attempt = 0; ; attempt++) {
      const { up, retryAfter } = await forward(req, headers, body)
      if (up.statusCode === 429 && attempt < RETRIES && Number.isFinite(retryAfter) && retryAfter <= 70) {
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + 250))
        continue
      }
      res.writeHead(up.statusCode || 502, up.headers)
      if (up.statusCode === 429) res.end()
      else up.pipe(res)
      return
    }
  } catch {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('upstream unavailable')
  }
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`conformance proxy on http://127.0.0.1:${port} -> ${target.origin}\n`))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
