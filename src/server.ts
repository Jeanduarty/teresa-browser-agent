import 'dotenv/config'
import Fastify from 'fastify'
import { env } from './env-schema.js'
import { createLogger } from './logger.js'
import { tiktokSessionService } from './tiktok-session-service.js'

const log = createLogger('server')
const app = Fastify({ logger: false })

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.addHook('preHandler', async (req, reply) => {
  if (req.url === '/health') return
  if (req.headers.authorization !== `Bearer ${env.BROWSER_AGENT_SECRET}`) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', async () => ({
  ok: true,
  sessions: tiktokSessionService.activeCount,
}))

// Abre o browser, navega para a página de QR e retorna a imagem
app.post<{ Body: { sessionId: string } }>('/sessions', async (req, reply) => {
  const { sessionId } = req.body
  if (!sessionId) return reply.code(400).send({ error: 'sessionId is required' })

  try {
    const qrCode = await tiktokSessionService.start(sessionId)
    return reply.code(201).send({ qrCode })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro desconhecido'
    log.error('start_failed', err, { sessionId })
    return reply.code(500).send({ error: message })
  }
})

// Render faz polling deste endpoint a cada 2s para saber se o login foi concluído
app.get<{ Params: { id: string } }>('/sessions/:id/status', async (req, reply) => {
  const status = tiktokSessionService.getStatus(req.params.id)
  if (!status) return reply.code(404).send({ error: 'Sessão não encontrada ou expirou.' })
  return status
})

// Extrai handle e cookies após login confirmado e fecha o browser
app.post<{ Params: { id: string } }>('/sessions/:id/finalize', async (req, reply) => {
  try {
    const result = await tiktokSessionService.finalize(req.params.id)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro desconhecido'
    log.error('finalize_failed', err, { sessionId: req.params.id })
    return reply.code(500).send({ error: message })
  }
})

// Aborta a sessão e fecha o browser
app.delete<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
  await tiktokSessionService.abort(req.params.id)
  return reply.code(204).send()
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen({ port: env.BROWSER_AGENT_PORT, host: '127.0.0.1' }, (err) => {
  if (err) { log.error('startup_failed', err); process.exit(1) }
  log.info('started', { port: env.BROWSER_AGENT_PORT })
  console.log(`\n  Browser agent rodando em http://127.0.0.1:${env.BROWSER_AGENT_PORT}`)
  console.log(`  Exponha via: ngrok http ${env.BROWSER_AGENT_PORT}\n`)
})
