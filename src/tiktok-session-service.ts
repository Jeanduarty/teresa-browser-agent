import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, BrowserContext, Cookie, ElementHandle, Page } from 'playwright'
import { chromium as playwrightChromium } from 'playwright'
import { addExtra } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { env } from './env-schema.js'
import { createLogger } from './logger.js'

const log = createLogger('tiktok-session')

// ---------------------------------------------------------------------------
// Browser setup
// ---------------------------------------------------------------------------

const chromium = addExtra(playwrightChromium)
chromium.use(StealthPlugin())

const VIEWPORT = { width: 1366, height: 768 }
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const QR_LOGIN_URL = 'https://www.tiktok.com/login/qrcode'
const PROFILE_URL = 'https://www.tiktok.com/profile'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QRCodeChallenge = { image: string; width: number; height: number }

export type LoginStatus =
  | { status: 'waiting' }
  | { status: 'success' }
  | { status: 'failed'; code: string; message: string }

type Session = {
  browser: Browser
  context: BrowserContext
  page: Page
  loginStatus: LoginStatus
  timeoutHandle: NodeJS.Timeout
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>()

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rand(min: number, max: number) { return min + Math.random() * (max - min) }
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }
function compactText(t: string) { return t.replace(/\s+/g, ' ').trim() }
function bufferFingerprint(buf: Buffer) {
  return `${buf.length}:${buf.subarray(0, 32).toString('base64')}:${buf.subarray(-32).toString('base64')}`
}

async function findVisibleElement(page: Page, selectors: string[]) {
  let best: ElementHandle<SVGElement | HTMLElement> | null = null
  let bestArea = 0
  for (const sel of selectors) {
    for (const el of await page.$$(sel).catch(() => [])) {
      if (!await el.isVisible().catch(() => false)) continue
      const box = await el.boundingBox().catch(() => null)
      if (!box || box.width < 120 || box.height < 80) continue
      const area = box.width * box.height
      if (area > bestArea) { best = el; bestArea = area }
    }
  }
  return best
}

async function screenshotElement(page: Page, el: ElementHandle) {
  await el.scrollIntoViewIfNeeded().catch(() => undefined)
  await sleep(150)
  const box = await el.boundingBox().catch(() => null)
  if (!box) return null
  const vp = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const pad = 8
  const clip = {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.min(vp.width, Math.ceil(box.x + box.width + pad)) - Math.max(0, Math.floor(box.x - pad)),
    height: Math.min(vp.height, Math.ceil(box.y + box.height + pad)) - Math.max(0, Math.floor(box.y - pad)),
  }
  if (clip.width < 1 || clip.height < 1) return null
  const buffer = await page.screenshot({ type: 'png', clip, animations: 'disabled' }).catch(() => null)
  return buffer ? { buffer, width: Math.round(clip.width), height: Math.round(clip.height) } : null
}

async function isQrCanvasReady(page: Page) {
  return page.$eval('canvas', (c) => {
    const canvas = c as HTMLCanvasElement
    if (canvas.width < 120 || canvas.height < 120) return false
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let i = 0; i < data.length; i += 16) {
      if (data[i + 3] > 240 && data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) dark++
    }
    return dark > 250
  }).catch(() => false)
}

async function waitForStableQrCode(page: Page): Promise<QRCodeChallenge | null> {
  const deadline = Date.now() + env.TIKTOK_QR_READY_TIMEOUT_MS
  let prevFingerprint: string | null = null
  let stableReads = 0

  while (Date.now() < deadline) {
    if (await isQrCanvasReady(page)) {
      const el = await findVisibleElement(page, ['[data-e2e="qr-code"]', 'canvas', '[class*="qr" i]'])
      if (el) {
        const shot = await screenshotElement(page, el)
        if (shot) {
          const fp = bufferFingerprint(shot.buffer)
          stableReads = fp === prevFingerprint ? stableReads + 1 : 1
          prevFingerprint = fp
          if (stableReads >= 2) return { image: shot.buffer.toString('base64'), width: shot.width, height: shot.height }
        }
      }
    }
    await sleep(500)
  }

  const el = await findVisibleElement(page, ['[data-e2e="qr-code"]', 'canvas', '[class*="qr" i]'])
  if (!el) return null
  const shot = await screenshotElement(page, el)
  return shot ? { image: shot.buffer.toString('base64'), width: shot.width, height: shot.height } : null
}

function classifyText(text: string): { status: 'failed'; code: string; message: string } | null {
  if (
    /verifica[cç][aã]o em duas etapas|two[- ]step verification|two[- ]factor|2fa|authenticator/i.test(text) ||
    /(insira|digite|informe|enter).{0,60}(c[oó]digo|code)/i.test(text) ||
    /confirme sua identidade|confirm your identity/i.test(text)
  ) {
    return {
      status: 'failed',
      code: 'verification_required',
      message: 'O TikTok pediu verificação adicional. Faça login em um navegador comum, conclua a verificação e tente novamente.',
    }
  }

  if (
    /drag.{0,30}slider|slider.{0,30}puzzle|fit.{0,20}puzzle|rotate.{0,30}image/i.test(text) ||
    /captcha|security check|bot.{0,20}check/i.test(text) ||
    /muitas tentativas|too many attempts|tente novamente mais tarde|try again later/i.test(text) ||
    /atividade suspeita|suspicious activity|unusual activity/i.test(text)
  ) {
    return {
      status: 'failed',
      code: 'unsupported_challenge',
      message: 'O TikTok bloqueou esta tentativa. Aguarde alguns minutos e tente novamente.',
    }
  }

  return null
}

function setStatus(sessionId: string, status: LoginStatus) {
  const session = sessions.get(sessionId)
  if (session) session.loginStatus = status
}

async function monitorLogin(sessionId: string, page: Page) {
  const deadline = Date.now() + env.TIKTOK_QR_LOGIN_TIMEOUT_MS

  while (Date.now() < deadline) {
    const url = page.url()

    if (!url.includes('/login') && url.includes('tiktok.com')) {
      setStatus(sessionId, { status: 'success' })
      log.info('login_success', { sessionId })
      return
    }

    // Redirect /login/qrcode → /login = sessão rejeitada por IP de datacenter
    if (url.includes('tiktok.com/') && url.includes('/login') && !url.includes('/login/qrcode')) {
      const text = compactText(await page.$eval('body', b => (b as HTMLElement).innerText).catch(() => ''))
      setStatus(sessionId, classifyText(text) ?? {
        status: 'failed',
        code: 'unsupported_challenge',
        message: 'O TikTok recusou a autenticação via QR. Verifique a configuração do túnel.',
      })
      log.warn('login_rejected', { sessionId, url })
      return
    }

    const text = compactText(await page.$eval('body', b => (b as HTMLElement).innerText).catch(() => ''))
    const classified = classifyText(text)
    if (classified) { setStatus(sessionId, classified); log.warn('login_failed_classified', { sessionId, code: classified.code }); return }

    if (/expir|expired|invalid|inv[aá]lido/i.test(text)) {
      setStatus(sessionId, { status: 'failed', code: 'login_failed', message: 'O QR code expirou. Tente novamente.' })
      return
    }

    await sleep(1000)
  }

  setStatus(sessionId, { status: 'failed', code: 'login_failed', message: 'Login por QR não concluiu no tempo esperado.' })
}

async function extractHandle(page: Page): Promise<string | null> {
  try {
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await sleep(rand(1500, 3000))
    const handle = await page
      .$eval('[data-e2e="user-page"] [data-e2e="user-subtitle"], [data-e2e="user-title"]', el => (el.textContent ?? '').trim())
      .catch(() => null)
    if (handle) return handle.startsWith('@') ? handle : `@${handle}`
    const fromUrl = page.url().match(/tiktok\.com\/@([\w._-]+)/)
    return fromUrl ? `@${fromUrl[1]}` : null
  } catch {
    return null
  }
}

async function saveDebugSnapshot(page: Page, sessionId: string, reason: string) {
  const dir = join(process.cwd(), '.tiktok-login-debug')
  const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sessionId}-${reason}-${randomUUID()}`
  try {
    await mkdir(dir, { recursive: true })
    await Promise.allSettled([
      writeFile(join(dir, `${base}.html`), await page.content().catch(() => ''), 'utf8'),
      page.screenshot({ path: join(dir, `${base}.png`), animations: 'disabled' }),
    ])
    log.info('debug_snapshot_saved', { sessionId, reason })
  } catch { /* debug only */ }
}

async function closeSession(sessionId: string) {
  const s = sessions.get(sessionId)
  if (!s) return
  clearTimeout(s.timeoutHandle)
  sessions.delete(sessionId)
  await s.page.close().catch(() => undefined)
  await s.context.close().catch(() => undefined)
  await s.browser.close().catch(() => undefined)
  log.info('session_closed', { sessionId })
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export const tiktokSessionService = {
  async start(sessionId: string): Promise<QRCodeChallenge> {
    if (sessions.has(sessionId)) await closeSession(sessionId)
    log.info('session_starting', { sessionId })

    let browser: Browser | null = null
    try {
      browser = await chromium.launch({
        headless: env.PLAYWRIGHT_HEADLESS,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
      })
      const context = await browser.newContext({
        viewport: VIEWPORT,
        userAgent: USER_AGENT,
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
      })
      const page = await context.newPage()

      await page.goto(QR_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForSelector('[data-e2e="qr-code"], canvas', { timeout: 20_000 })

      const qrCode = await waitForStableQrCode(page)
      if (!qrCode) {
        await saveDebugSnapshot(page, sessionId, 'qr_not_found')
        await browser.close()
        throw new Error('Não foi possível gerar o QR code.')
      }

      const timeoutHandle = setTimeout(() => void closeSession(sessionId), env.TIKTOK_LOGIN_SESSION_TIMEOUT_MS)
      sessions.set(sessionId, { browser, context, page, loginStatus: { status: 'waiting' }, timeoutHandle })

      void monitorLogin(sessionId, page).catch(() =>
        setStatus(sessionId, { status: 'failed', code: 'login_failed', message: 'Erro interno no monitor de login.' }),
      )

      log.info('session_ready', { sessionId })
      return qrCode
    } catch (err) {
      await browser?.close().catch(() => undefined)
      throw err
    }
  },

  getStatus(sessionId: string): LoginStatus | null {
    return sessions.get(sessionId)?.loginStatus ?? null
  },

  async finalize(sessionId: string): Promise<{ handle: string | null; cookies: Cookie[] }> {
    const session = sessions.get(sessionId)
    if (!session) throw new Error('Sessão não encontrada ou expirou.')

    const { page, context } = session
    try {
      // Collect cookies before any navigation to avoid losing the session
      const allCookies: Cookie[] = await context.cookies()
      const cookies = allCookies.filter(c => /tiktok\.com$/.test(c.domain.replace(/^\./, '')))

      if (cookies.length === 0) {
        await saveDebugSnapshot(page, sessionId, 'no_cookies')
        throw new Error('Nenhum cookie do TikTok encontrado após login.')
      }

      // Extract handle after cookies are safe — failure here is non-fatal
      const handle = await extractHandle(page)

      log.info('session_finalized', { sessionId, handle, cookieCount: cookies.length })
      return { handle, cookies }
    } finally {
      await closeSession(sessionId)
    }
  },

  async abort(sessionId: string): Promise<void> {
    await closeSession(sessionId)
  },

  get activeCount() {
    return sessions.size
  },
}
