/// <reference lib="dom" />
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, BrowserContext, Cookie, ElementHandle, Locator, Page } from 'playwright'
export type { Cookie }
import { chromium as playwrightChromium } from 'playwright'
import { addExtra } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

import { env } from './env-schema.js'
import { createLogger } from './logger.js'

const log = createLogger('tiktok-scraping')

const chromium = addExtra(playwrightChromium)
chromium.use(StealthPlugin())

const VIEWPORT = { width: 1366, height: 768 }
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const VIDEO_CARD_SELECTOR = '[data-e2e="user-post-item"]'
const VIDEO_LINK_SELECTOR = 'a[href*="/video/"]'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollectedVideo = {
  url: string
  text: string
  creatorHandle: string | null
  createdAt: string | null
  metrics: {
    likes: number
    replies: number
    reposts: number
    quotes: number
  } | null
}

export type CollectResult = {
  status: 'completed' | 'failed'
  stoppedReason: string
  postsRead: number
  pagesFetched: number
  viewedVideos: number
  resolvedHandle: string | null
  videos: CollectedVideo[]
  error: string | null
}

type ExtractedVideo = {
  url: string
  text: string
  creatorHandle: string | null
  createdAt?: string | null
  metrics?: {
    likes: number
    replies: number
    reposts: number
    quotes: number
  }
}

type TikTokFavoriteApiItem = {
  id?: string
  desc?: string
  createTime?: number | string
  author?: { uniqueId?: string }
  stats?: { diggCount?: number; commentCount?: number; shareCount?: number }
  statsV2?: { diggCount?: string; commentCount?: string; shareCount?: string }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function extractHandleFromUrl(url: string): string | null {
  const match = url.match(/tiktok\.com\/(@[\w._-]+)/)
  return match?.[1] ?? null
}

// ---------------------------------------------------------------------------
// Debug snapshots
// ---------------------------------------------------------------------------

async function captureDebugSnapshot(page: Page, reason: string): Promise<void> {
  const dir = join(process.cwd(), '.tiktok-scraping-debug')
  const safeReason = reason.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = `${timestamp}-${safeReason}-${randomUUID()}`

  try {
    await mkdir(dir, { recursive: true })
    await Promise.allSettled([
      writeFile(join(dir, `${baseName}.html`), await page.content().catch(() => ''), 'utf8'),
      page.screenshot({ path: join(dir, `${baseName}.png`), fullPage: true, animations: 'disabled' }),
    ])
    log.warn('debug_snapshot_saved', { reason, url: page.url() })
  } catch (err) {
    log.error('debug_snapshot_failed', err, { reason })
  }
}

// ---------------------------------------------------------------------------
// Browser interaction helpers
// ---------------------------------------------------------------------------

async function isLoggedOut(page: Page): Promise<boolean> {
  const loginButton = await page.$('[data-e2e="top-login-button"], a[href*="/login"]')
  if (!loginButton) return false
  return loginButton.isVisible().catch(() => false)
}

async function clickHandle(page: Page, element: ElementHandle): Promise<void> {
  await element.scrollIntoViewIfNeeded().catch(() => undefined)
  await sleep(rand(200, 500))

  const box = await element.boundingBox().catch(() => null)
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 })
    await sleep(rand(120, 300))
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: rand(40, 120) })
    return
  }

  await element.click({ timeout: 5_000 }).catch(() => undefined)
}

async function clickLocator(page: Page, locator: Locator): Promise<boolean> {
  const target = locator.first()
  if (!await target.isVisible({ timeout: 1_500 }).catch(() => false)) return false

  await target.scrollIntoViewIfNeeded().catch(() => undefined)
  await sleep(rand(200, 500))

  const box = await target.boundingBox().catch(() => null)
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 })
    await sleep(rand(120, 300))
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: rand(40, 120) })
    return true
  }

  await target.click({ timeout: 5_000 }).catch(() => undefined)
  return true
}

async function clickLikedTab(page: Page): Promise<boolean> {
  const selectorCandidates = [
    '[data-e2e="liked-tab"]',
    '[data-e2e="user-liked-tab"]',
    'button[aria-label*="Liked" i]',
    'button[aria-label*="Curtid" i]',
    '[role="tab"][aria-label*="Liked" i]',
    '[role="tab"][aria-label*="Curtid" i]',
  ]

  for (const selector of selectorCandidates) {
    const elements = await page.$$(selector).catch(() => [])
    for (const element of elements) {
      if (!await element.isVisible().catch(() => false)) continue
      await clickHandle(page, element)
      return true
    }
  }

  const textPattern = /^(Liked|Curtidos|Curtidas|Curtido)$/i
  const roleLocators = [
    page.getByRole('tab', { name: /liked|curtid/i }),
    page.getByRole('button', { name: /liked|curtid/i }),
    page.locator('button, [role="button"], [role="tab"]').filter({ hasText: textPattern }),
    page.locator('div, span').filter({ hasText: textPattern }),
  ]

  for (const locator of roleLocators) {
    if (await clickLocator(page, locator).catch(() => false)) return true
  }

  return false
}

async function gotoLikedTab(page: Page, handle: string | null): Promise<boolean> {
  const target = handle
    ? `https://www.tiktok.com/${handle.replace(/^@?/, '@')}`
    : 'https://www.tiktok.com/profile'
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await sleep(rand(2000, 4000))

  const clicked = await clickLikedTab(page)
  if (!clicked) return false

  await sleep(rand(1500, 3000))
  await page.waitForSelector(`${VIDEO_CARD_SELECTOR}, ${VIDEO_LINK_SELECTOR}`, { timeout: 10_000 }).catch(() => null)
  return true
}

async function getVideoCards(page: Page): Promise<ElementHandle[]> {
  const cards = await page.$$(VIDEO_CARD_SELECTOR).catch(() => [])
  if (cards.length > 0) return cards
  return page.$$(VIDEO_LINK_SELECTOR).catch(() => [])
}

async function extractCardData(page: Page, index: number): Promise<ExtractedVideo | null> {
  return page
    .evaluate(
      ({ idx, cardSelector, linkSelector }) => {
        const cards = document.querySelectorAll(cardSelector)
        const card = (cards[idx] ?? document.querySelectorAll(linkSelector)[idx]) as HTMLElement | undefined
        if (!card) return null

        const link = (card.matches(linkSelector) ? card : card.querySelector(linkSelector)) as HTMLAnchorElement | null
        const url = link?.href ?? null
        if (!url) return null

        const text =
          card.querySelector('[data-e2e="user-post-item-desc"]')?.textContent?.trim() ??
          card.querySelector('a[href*="/video/"]')?.getAttribute('aria-label') ??
          ''

        const match = url.match(/tiktok\.com\/(@[\w._-]+)\/video\//)
        return { url, text, creatorHandle: match ? match[1] : null }
      },
      { idx: index, cardSelector: VIDEO_CARD_SELECTOR, linkSelector: VIDEO_LINK_SELECTOR },
    )
    .catch(() => null)
}


async function humanScroll(page: Page): Promise<void> {
  const totalDistance = Math.round(rand(500, 900))
  const steps = Math.round(rand(8, 14))
  const stepSize = totalDistance / steps
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepSize)
    await sleep(rand(40, 120))
  }
}

// ---------------------------------------------------------------------------
// API fallback (when liked tab is private)
// ---------------------------------------------------------------------------

function mapApiItemToVideo(item: TikTokFavoriteApiItem): ExtractedVideo | null {
  if (!item.id || !item.author?.uniqueId) return null

  const creatorHandle = `@${item.author.uniqueId.replace(/^@/, '')}`
  const createdAt = item.createTime
    ? new Date(toNumber(item.createTime) * 1000).toISOString()
    : null

  return {
    url: `https://www.tiktok.com/${creatorHandle}/video/${item.id}`,
    text: item.desc ?? '',
    creatorHandle,
    createdAt,
    metrics: {
      likes: toNumber(item.stats?.diggCount ?? item.statsV2?.diggCount),
      replies: toNumber(item.stats?.commentCount ?? item.statsV2?.commentCount),
      reposts: toNumber(item.stats?.shareCount ?? item.statsV2?.shareCount),
      quotes: 0,
    },
  }
}

async function fetchLikedVideosApiPage(
  page: Page,
  cursor: string,
  count: number,
): Promise<{ cursor: string; hasMore: boolean; items: ExtractedVideo[] } | null> {
  const payload = await page
    .evaluate(
      async ({ requestedCursor, requestedCount }) => {
        const rawData = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent
        const universalData = rawData ? JSON.parse(rawData) : null
        const scope = universalData?.__DEFAULT_SCOPE__ ?? {}
        const appContext = scope['webapp.app-context'] ?? {}
        const userDetail = scope['webapp.user-detail']?.userInfo?.user ?? {}
        const secUid = appContext.user?.secUid ?? userDetail.secUid

        if (!secUid) return null

        const params = new URLSearchParams({
          WebIdLastTime: appContext.webIdCreatedTime ?? '',
          aid: '1988',
          app_language: 'en',
          app_name: 'tiktok_web',
          browser_language: navigator.language,
          browser_name: 'Mozilla',
          browser_online: String(navigator.onLine),
          browser_platform: navigator.platform,
          browser_version: navigator.userAgent,
          channel: 'tiktok_web',
          cookie_enabled: String(navigator.cookieEnabled),
          count: String(requestedCount),
          cursor: requestedCursor,
          device_id: appContext.wid ?? '',
          device_platform: 'web_pc',
          focus_state: 'true',
          from_page: 'user',
          history_len: String(window.history.length),
          is_fullscreen: 'false',
          is_page_visible: 'true',
          language: 'en',
          os: 'mac',
          priority_region: appContext.region ?? 'BR',
          referer: '',
          region: appContext.region ?? 'BR',
          screen_height: String(window.screen.height),
          screen_width: String(window.screen.width),
          secUid,
          tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
          webcast_language: 'en',
        })

        const response = await fetch(`/api/favorite/item_list/?${params.toString()}`, {
          credentials: 'include',
          headers: { accept: 'application/json, text/plain, */*' },
        })

        if (!response.ok) return null
        return response.json()
      },
      { requestedCursor: cursor, requestedCount: count },
    )
    .catch(() => null)

  if (!payload || typeof payload !== 'object') return null

  const response = payload as {
    cursor?: string | number
    hasMore?: boolean
    itemList?: TikTokFavoriteApiItem[]
  }

  const items = Array.isArray(response.itemList)
    ? response.itemList.map(mapApiItemToVideo).filter((item): item is ExtractedVideo => Boolean(item))
    : []

  return {
    cursor: String(response.cursor ?? cursor),
    hasMore: Boolean(response.hasMore),
    items,
  }
}

async function collectLikedVideosFromApi(
  page: Page,
): Promise<{ stoppedReason: string; postsRead: number; pagesFetched: number; viewedVideos: number; videos: CollectedVideo[] } | null> {
  let cursor = '0'
  let stoppedReason = 'end_of_feed'
  let postsRead = 0
  let pagesFetched = 0
  let viewedVideos = 0
  const videos: CollectedVideo[] = []
  const seenUrls = new Set<string>()

  while (viewedVideos < env.TIKTOK_WEB_MAX_VIDEOS) {
    const remaining = Math.max(1, env.TIKTOK_WEB_MAX_VIDEOS - viewedVideos)
    const apiPage = await fetchLikedVideosApiPage(page, cursor, Math.min(30, remaining))
    if (!apiPage) return null

    pagesFetched++
    if (apiPage.items.length === 0) break

    for (const video of apiPage.items) {
      viewedVideos++
      if (seenUrls.has(video.url)) continue
      seenUrls.add(video.url)
      postsRead++

      videos.push({
        url: video.url,
        text: video.text,
        creatorHandle: video.creatorHandle,
        createdAt: video.createdAt ?? null,
        metrics: video.metrics ?? null,
      })

      if (viewedVideos >= env.TIKTOK_WEB_MAX_VIDEOS) {
        stoppedReason = 'max_videos_reached'
        break
      }
    }

    if (stoppedReason === 'max_videos_reached') break
    if (!apiPage.hasMore || apiPage.cursor === cursor) break
    cursor = apiPage.cursor
    await sleep(rand(1200, 2400))
  }

  return { stoppedReason, postsRead, pagesFetched, viewedVideos, videos }
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export const tiktokScrapingService = {
  async collectLikedVideos(cookies: Cookie[], handle: string | null): Promise<CollectResult> {
    let browser: Browser | null = null
    let context: BrowserContext | null = null
    const videos: CollectedVideo[] = []

    try {
      browser = await chromium.launch({
        headless: env.PLAYWRIGHT_HEADLESS,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      })

      context = await browser.newContext({
        viewport: VIEWPORT,
        userAgent: USER_AGENT,
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
      })
      await context.addCookies(cookies)

      const page = await context.newPage()

      const tabOpened = await gotoLikedTab(page, handle)
      const resolvedHandle = extractHandleFromUrl(page.url())

      if (!tabOpened) {
        if (await isLoggedOut(page)) {
          log.warn('session_expired_detected', { handle, url: page.url() })
          return {
            status: 'failed',
            stoppedReason: 'session_expired',
            postsRead: 0,
            pagesFetched: 0,
            viewedVideos: 0,
            resolvedHandle,
            videos: [],
            error: 'Sessão expirou — reconecte.',
          }
        }

        log.warn('liked_tab_not_found', { handle, url: page.url() })
        await captureDebugSnapshot(page, 'liked_tab_not_found')

        const apiResult = await collectLikedVideosFromApi(page)
        if (apiResult) {
          log.info('collected_via_api_fallback', { stoppedReason: apiResult.stoppedReason, postsRead: apiResult.postsRead })
          log.info('collected_urls', { urls: apiResult.videos.map(v => v.url) })
          return {
            status: 'completed',
            stoppedReason: apiResult.stoppedReason,
            postsRead: apiResult.postsRead,
            pagesFetched: apiResult.pagesFetched,
            viewedVideos: apiResult.viewedVideos,
            resolvedHandle,
            videos: apiResult.videos,
            error: null,
          }
        }

        return {
          status: 'failed',
          stoppedReason: 'liked_tab_not_found',
          postsRead: 0,
          pagesFetched: 0,
          viewedVideos: 0,
          resolvedHandle,
          videos: [],
          error: 'Aba "Curtidos" não disponível (privacidade?).',
        }
      }

      if (await isLoggedOut(page)) {
        log.warn('session_expired_after_tab', { handle })
        return {
          status: 'failed',
          stoppedReason: 'session_expired',
          postsRead: 0,
          pagesFetched: 0,
          viewedVideos: 0,
          resolvedHandle,
          videos: [],
          error: 'Sessão expirou — reconecte.',
        }
      }

      let stoppedReason = 'end_of_feed'
      let postsRead = 0
      let pagesFetched = 0
      let viewedVideos = 0
      let lastScrollHeight = 0
      let consecutiveNoNewCards = 0
      const seenUrls = new Set<string>()

      while (true) {
        const cards = await getVideoCards(page)
        const cardCount = cards.length
        let newCardsThisRound = 0

        for (let i = viewedVideos; i < cardCount; i++) {
          let data: ExtractedVideo | null = null
          try {
            const card = cards[i]
            if (card) {
              await card.scrollIntoViewIfNeeded().catch(() => undefined)
              await sleep(rand(env.TIKTOK_WEB_HOVER_MIN_MS, env.TIKTOK_WEB_HOVER_MAX_MS))
              await card.hover().catch(() => undefined)
            }
            data = await extractCardData(page, i)
          } catch (err) {
            log.warn('card_extract_failed', { index: i, error: err instanceof Error ? err.message : 'unknown' })
          }
          viewedVideos++
          newCardsThisRound++

          if (!data?.url) continue
          if (seenUrls.has(data.url)) continue
          seenUrls.add(data.url)
          postsRead++

          videos.push({
            url: data.url,
            text: data.text,
            creatorHandle: data.creatorHandle,
            createdAt: data.createdAt ?? null,
            metrics: data.metrics ?? null,
          })

          if (viewedVideos >= env.TIKTOK_WEB_MAX_VIDEOS) {
            stoppedReason = 'max_videos_reached'
            break
          }
        }

        if (stoppedReason === 'max_videos_reached') break

        if (newCardsThisRound === 0) {
          consecutiveNoNewCards++
          if (consecutiveNoNewCards >= 2) {
            if (postsRead === 0) {
              await captureDebugSnapshot(page, 'liked_posts_not_found')
            }
            stoppedReason = 'end_of_feed'
            break
          }
        } else {
          consecutiveNoNewCards = 0
        }

        await humanScroll(page)
        pagesFetched++
        await sleep(rand(env.TIKTOK_WEB_SCROLL_DELAY_MIN_MS, env.TIKTOK_WEB_SCROLL_DELAY_MAX_MS))

        const currentHeight = await page.evaluate(() => document.body.scrollHeight)
        if (currentHeight === lastScrollHeight) {
          stoppedReason = 'end_of_feed'
          break
        }
        lastScrollHeight = currentHeight
      }

      log.info('collect_completed', { stoppedReason, postsRead, pagesFetched, viewedVideos, videoCount: videos.length })
      log.info('collected_urls', { urls: videos.map(v => v.url) })

      return {
        status: 'completed',
        stoppedReason,
        postsRead,
        pagesFetched,
        viewedVideos,
        resolvedHandle,
        videos,
        error: null,
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'erro inesperado'
      log.error('collect_unexpected_error', err)
      return {
        status: 'failed',
        stoppedReason: 'unexpected_error',
        postsRead: 0,
        pagesFetched: 0,
        viewedVideos: 0,
        resolvedHandle: null,
        videos,
        error,
      }
    } finally {
      await context?.close().catch(() => undefined)
      await browser?.close().catch(() => undefined)
    }
  },
}
