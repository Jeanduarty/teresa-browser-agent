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
  newPosts: number | null
  pagesFetched: number
  viewedVideos: number
  resolvedHandle: string | null
  videos: CollectedVideo[]
  error: string | null
}

export type LikedVideosCheckpoint = {
  jobId: string
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

type CheckpointRuntime = {
  config: LikedVideosCheckpoint
  pending: CollectedVideo[]
  newPosts: number
}

type CheckpointDecision = {
  shouldContinue: boolean
  stoppedReason?: string
  knownUrl?: string | null
  persistedCount?: number
  persistedUrls?: string[]
}

class CheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointError'
  }
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ])
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

function normalizeTikTokVideoUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const match = parsed.pathname.match(/\/(@[\w._-]+)\/video\/(\d+)/)
    if (!match) return url
    return `https://www.tiktok.com/${match[1]}/video/${match[2]}`
  } catch {
    return url
  }
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
    ? `https://www.tiktok.com/${handle.replace(/^@?/, '@')}?t=${Date.now()}`
    : `https://www.tiktok.com/profile?t=${Date.now()}`
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

async function getVisibleVideoCardsInVisualOrder(page: Page): Promise<ElementHandle[]> {
  const cards = await getVideoCards(page)
  const visibleCards = await Promise.all(
    cards.map(async card => ({
      card,
      box: await card.boundingBox().catch(() => null),
      visible: await card.isVisible().catch(() => false),
    })),
  )

  return visibleCards
    .filter(item => item.visible && item.box)
    .sort((a, b) => {
      const yDiff = (a.box?.y ?? 0) - (b.box?.y ?? 0)
      if (Math.abs(yDiff) > 8) return yDiff
      return (a.box?.x ?? 0) - (b.box?.x ?? 0)
    })
    .map(item => item.card)
}

async function getTopLeftVideoCard(cards: ElementHandle[]): Promise<ElementHandle | null> {
  const visibleCards = await Promise.all(
    cards.map(async card => ({
      card,
      box: await card.boundingBox().catch(() => null),
      visible: await card.isVisible().catch(() => false),
    })),
  )

  return visibleCards
    .filter(item => item.visible && item.box)
    .sort((a, b) => {
      const yDiff = (a.box?.y ?? 0) - (b.box?.y ?? 0)
      if (Math.abs(yDiff) > 8) return yDiff
      return (a.box?.x ?? 0) - (b.box?.x ?? 0)
    })[0]?.card ?? null
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

async function extractCardElementData(card: ElementHandle): Promise<ExtractedVideo | null> {
  return card.evaluate((element, linkSelector) => {
    const cardElement = element as HTMLElement
    const link = (
      cardElement.matches(linkSelector)
        ? cardElement
        : cardElement.querySelector(linkSelector)
    ) as HTMLAnchorElement | null
    const url = link?.href ?? null
    if (!url) return null

    const text =
      cardElement.querySelector('[data-e2e="user-post-item-desc"]')?.textContent?.trim() ??
      link?.getAttribute('aria-label') ??
      ''

    const match = url.match(/tiktok\.com\/(@[\w._-]+)\/video\//)
    return { url, text, creatorHandle: match ? match[1] : null }
  }, VIDEO_LINK_SELECTOR).catch(() => null)
}

function createCheckpointRuntime(checkpoint?: LikedVideosCheckpoint): CheckpointRuntime | null {
  if (!checkpoint) return null
  return { config: checkpoint, pending: [], newPosts: 0 }
}

async function flushCheckpoint(runtime: CheckpointRuntime | null): Promise<CheckpointDecision | null> {
  if (!runtime || runtime.pending.length === 0) return null

  const videos = runtime.pending
  runtime.pending = []

  const checkpointUrl = new URL('/internal/browser-agent/tiktok-liked-batch', env.TERESA_SERVER_URL).toString()
  const response = await fetch(checkpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.BROWSER_AGENT_SECRET}`,
    },
    body: JSON.stringify({
      jobId: runtime.config.jobId,
      videos,
    }),
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string }
    throw new CheckpointError(body.error ?? body.message ?? 'Falha no checkpoint de posts curtidos.')
  }

  const decision = await response.json() as CheckpointDecision
  runtime.newPosts += decision.persistedCount ?? 0
  return decision
}

async function enqueueCheckpointVideo(
  runtime: CheckpointRuntime | null,
  video: CollectedVideo,
): Promise<CheckpointDecision | null> {
  if (!runtime) return null
  runtime.pending.push(video)
  if (runtime.pending.length < 5) return null
  return flushCheckpoint(runtime)
}

async function waitForVideoUrlChange(page: Page, previousUrl: string, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const currentUrl = page.url()
    if (currentUrl !== previousUrl && currentUrl.includes('/video/')) return true
    await sleep(250)
  }
  return false
}

async function navigateToNextLikedVideo(page: Page, previousUrl: string): Promise<boolean> {
  await page.keyboard.press('ArrowDown')
  if (await waitForVideoUrlChange(page, previousUrl)) return true

  const nextSelectors = [
    '[data-e2e="arrow-down"]',
    '[data-e2e="arrow-right"]',
    '[data-e2e="browse-video-ctrl-next"]',
    'button[aria-label*="Next" i]',
    'button[aria-label*="Próximo" i]',
    'button[aria-label*="Proximo" i]',
  ]

  for (const selector of nextSelectors) {
    const btn = page.locator(selector).first()
    if (!await btn.isVisible({ timeout: 500 }).catch(() => false)) continue
    await btn.click()
    if (await waitForVideoUrlChange(page, previousUrl)) return true
  }

  return false
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

// ---------------------------------------------------------------------------
// Player navigation (primary collection path)
// Opens the first liked video and navigates through using keyboard/buttons.
// The liked tab shows posts in descending order (most recently liked first),
// so index 0 = "último post curtido". Navigation follows TikTok's internal order.
// ---------------------------------------------------------------------------

async function collectViaPlayerNavigation(
  page: Page,
  maxVideos: number,
  checkpoint?: LikedVideosCheckpoint,
): Promise<{
  stoppedReason: string
  postsRead: number
  newPosts: number | null
  pagesFetched: number
  viewedVideos: number
  videos: CollectedVideo[]
} | null> {
  const cards = await getVideoCards(page)
  if (cards.length === 0) return null

  // Click the visually top-left card (most recently liked = descending order index 0)
  const firstCard = await getTopLeftVideoCard(cards) ?? cards[0]
  await firstCard.scrollIntoViewIfNeeded().catch(() => undefined)
  await sleep(rand(400, 800))

  const linkHandle = await firstCard.$('a[href*="/video/"]').catch(() => null) ?? firstCard
  await clickHandle(page, linkHandle as ElementHandle)
  await page.waitForURL(url => url.href.includes('/video/'), { timeout: 10_000 }).catch(() => undefined)
  await sleep(rand(800, 1400))

  const videos: CollectedVideo[] = []
  const seenUrls = new Set<string>()
  const checkpointRuntime = createCheckpointRuntime(checkpoint)
  let viewedVideos = 0
  let consecutiveNoChange = 0
  let stoppedReason = 'end_of_feed'

  while (viewedVideos < maxVideos) {
    const currentUrl = normalizeTikTokVideoUrl(page.url())

    if (currentUrl.includes('/video/') && !seenUrls.has(currentUrl)) {
      seenUrls.add(currentUrl)
      const creatorHandle = extractHandleFromUrl(currentUrl)
      const text =
        (await page
          .locator('[data-e2e="browse-video-desc"]')
          .first()
          .textContent({ timeout: 1_000 })
          .catch(() => '')) ?? ''

      log.info('liked_post_url', { url: currentUrl, index: videos.length + 1 })
      const video = { url: currentUrl, text: text.trim(), creatorHandle, createdAt: null, metrics: null }
      videos.push(video)
      viewedVideos++

      const decision = await enqueueCheckpointVideo(checkpointRuntime, video)
      if (decision && !decision.shouldContinue) {
        stoppedReason = decision.stoppedReason ?? 'known_post_found'
        break
      }
    } else {
      viewedVideos++
    }

    if (videos.length >= maxVideos) {
      stoppedReason = 'max_videos_reached'
      break
    }

    const prevUrl = page.url()

    if (await navigateToNextLikedVideo(page, prevUrl)) {
      consecutiveNoChange = 0
      continue
    }

    consecutiveNoChange++
    if (consecutiveNoChange >= 2) {
      stoppedReason = 'end_of_feed'
      break
    }
  }

  if (videos.length === 0) return null

  if (stoppedReason !== 'known_post_found') {
    const decision = await flushCheckpoint(checkpointRuntime)
    if (decision && !decision.shouldContinue) {
      stoppedReason = decision.stoppedReason ?? 'known_post_found'
    }
  }

  return {
    stoppedReason,
    postsRead: videos.length,
    newPosts: checkpointRuntime?.newPosts ?? null,
    pagesFetched: Math.ceil(viewedVideos / 10),
    viewedVideos,
    videos,
  }
}

async function collectLikedVideosFromApi(
  page: Page,
  checkpoint?: LikedVideosCheckpoint,
): Promise<{
  stoppedReason: string
  postsRead: number
  newPosts: number | null
  pagesFetched: number
  viewedVideos: number
  videos: CollectedVideo[]
} | null> {
  let cursor = '0'
  let stoppedReason = 'end_of_feed'
  let postsRead = 0
  let pagesFetched = 0
  let viewedVideos = 0
  const videos: CollectedVideo[] = []
  const seenUrls = new Set<string>()
  const checkpointRuntime = createCheckpointRuntime(checkpoint)

  while (viewedVideos < env.TIKTOK_WEB_MAX_VIDEOS) {
    const remaining = Math.max(1, env.TIKTOK_WEB_MAX_VIDEOS - viewedVideos)
    const apiPage = await fetchLikedVideosApiPage(page, cursor, Math.min(30, remaining))
    if (!apiPage) return null

    pagesFetched++
    if (apiPage.items.length === 0) break

    for (const video of apiPage.items) {
      viewedVideos++
      const normalizedUrl = normalizeTikTokVideoUrl(video.url)
      if (seenUrls.has(normalizedUrl)) continue
      seenUrls.add(normalizedUrl)
      postsRead++

      const collectedVideo = {
        url: normalizedUrl,
        text: video.text,
        creatorHandle: video.creatorHandle,
        createdAt: video.createdAt ?? null,
        metrics: video.metrics ?? null,
      }

      log.info('liked_post_url', { url: collectedVideo.url, index: postsRead })
      videos.push(collectedVideo)

      const decision = await enqueueCheckpointVideo(checkpointRuntime, collectedVideo)
      if (decision && !decision.shouldContinue) {
        stoppedReason = decision.stoppedReason ?? 'known_post_found'
        break
      }

      if (viewedVideos >= env.TIKTOK_WEB_MAX_VIDEOS) {
        stoppedReason = 'max_videos_reached'
        break
      }
    }

    if (stoppedReason === 'max_videos_reached' || stoppedReason === 'known_post_found') break
    if (!apiPage.hasMore || apiPage.cursor === cursor) break
    cursor = apiPage.cursor
    await sleep(rand(1200, 2400))
  }

  if (stoppedReason !== 'known_post_found') {
    const decision = await flushCheckpoint(checkpointRuntime)
    if (decision && !decision.shouldContinue) {
      stoppedReason = decision.stoppedReason ?? 'known_post_found'
    }
  }

  return { stoppedReason, postsRead, newPosts: checkpointRuntime?.newPosts ?? null, pagesFetched, viewedVideos, videos }
}

async function collectViaLikedGridOrder(
  page: Page,
  maxVideos: number,
  checkpoint?: LikedVideosCheckpoint,
): Promise<{
  stoppedReason: string
  postsRead: number
  newPosts: number | null
  pagesFetched: number
  viewedVideos: number
  videos: CollectedVideo[]
} | null> {
  let stoppedReason = 'end_of_feed'
  let pagesFetched = 0
  let viewedVideos = 0
  let lastSeenCount = 0
  let consecutiveNoNewCards = 0
  const videos: CollectedVideo[] = []
  const seenUrls = new Set<string>()
  const checkpointRuntime = createCheckpointRuntime(checkpoint)

  while (videos.length < maxVideos) {
    const cards = await getVisibleVideoCardsInVisualOrder(page)
    let newCardsThisRound = 0

    for (const card of cards) {
      const data = await extractCardElementData(card)
      if (!data?.url) continue

      const normalizedUrl = normalizeTikTokVideoUrl(data.url)
      if (seenUrls.has(normalizedUrl)) continue
      seenUrls.add(normalizedUrl)
      newCardsThisRound++
      viewedVideos++

      const video = {
        url: normalizedUrl,
        text: data.text,
        creatorHandle: data.creatorHandle,
        createdAt: data.createdAt ?? null,
        metrics: data.metrics ?? null,
      }

      log.info('liked_post_url', { via: 'grid', url: video.url, index: videos.length + 1 })
      videos.push(video)

      const decision = await enqueueCheckpointVideo(checkpointRuntime, video)
      if (decision && !decision.shouldContinue) {
        stoppedReason = decision.stoppedReason ?? 'known_post_found'
        break
      }

      if (videos.length >= maxVideos) {
        stoppedReason = 'max_videos_reached'
        break
      }
    }

    if (stoppedReason === 'known_post_found' || stoppedReason === 'max_videos_reached') break

    if (newCardsThisRound === 0 || seenUrls.size === lastSeenCount) {
      consecutiveNoNewCards++
      if (consecutiveNoNewCards >= 2) {
        stoppedReason = 'end_of_feed'
        break
      }
    } else {
      consecutiveNoNewCards = 0
    }

    lastSeenCount = seenUrls.size
    await humanScroll(page)
    pagesFetched++
    await sleep(rand(env.TIKTOK_WEB_SCROLL_DELAY_MIN_MS, env.TIKTOK_WEB_SCROLL_DELAY_MAX_MS))
  }

  if (videos.length === 0) return null

  if (stoppedReason !== 'known_post_found') {
    const decision = await flushCheckpoint(checkpointRuntime)
    if (decision && !decision.shouldContinue) {
      stoppedReason = decision.stoppedReason ?? 'known_post_found'
    }
  }

  return {
    stoppedReason,
    postsRead: videos.length,
    newPosts: checkpointRuntime?.newPosts ?? null,
    pagesFetched,
    viewedVideos,
    videos,
  }
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export const tiktokScrapingService = {
  async collectLikedVideos(
    cookies: Cookie[],
    handle: string | null,
    checkpoint?: LikedVideosCheckpoint,
  ): Promise<CollectResult> {
    let browser: Browser | null = null
    let context: BrowserContext | null = null
    let page: Page | null = null
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
        serviceWorkers: 'block',
        extraHTTPHeaders: {
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      })
      await context.addCookies(cookies)

      page = await context.newPage()

      const tabOpened = await gotoLikedTab(page, handle)
      const resolvedHandle = extractHandleFromUrl(page.url())

      if (!tabOpened) {
        if (await isLoggedOut(page)) {
          log.warn('session_expired_detected', { handle, url: page.url() })
          return {
            status: 'failed',
            stoppedReason: 'session_expired',
            postsRead: 0,
            newPosts: null,
            pagesFetched: 0,
            viewedVideos: 0,
            resolvedHandle,
            videos: [],
            error: 'Sessão expirou — reconecte.',
          }
        }

        log.warn('liked_tab_not_found', { handle, url: page.url() })
        await captureDebugSnapshot(page, 'liked_tab_not_found')

        const apiResult = await collectLikedVideosFromApi(page, checkpoint)
        if (apiResult) {
          log.info('collected_via_api_fallback', { stoppedReason: apiResult.stoppedReason, postsRead: apiResult.postsRead })
          return {
            status: 'completed',
            stoppedReason: apiResult.stoppedReason,
            postsRead: apiResult.postsRead,
            newPosts: apiResult.newPosts,
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
          newPosts: null,
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
          newPosts: null,
          pagesFetched: 0,
          viewedVideos: 0,
          resolvedHandle,
          videos: [],
          error: 'Sessão expirou — reconecte.',
        }
      }

      // Primary: the liked grid is the source of truth for descending order.
      // TikTok's player navigation can jump through a feed order that differs
      // from the visual "Curtido" grid, so use the grid order first.
      const gridResult = await collectViaLikedGridOrder(page, env.TIKTOK_WEB_MAX_VIDEOS, checkpoint)

      if (gridResult && gridResult.videos.length > 0) {
        log.info('collect_completed', {
          via: 'grid',
          stoppedReason: gridResult.stoppedReason,
          postsRead: gridResult.postsRead,
          viewedVideos: gridResult.viewedVideos,
          videoCount: gridResult.videos.length,
        })
        return {
          status: 'completed',
          stoppedReason: gridResult.stoppedReason,
          postsRead: gridResult.postsRead,
          newPosts: gridResult.newPosts,
          pagesFetched: gridResult.pagesFetched,
          viewedVideos: gridResult.viewedVideos,
          resolvedHandle,
          videos: gridResult.videos,
          error: null,
        }
      }

      // Fallback: open first liked video and navigate through the player.
      const playerResult = await collectViaPlayerNavigation(page, env.TIKTOK_WEB_MAX_VIDEOS, checkpoint).catch(err => {
        if (err instanceof CheckpointError) throw err
        log.warn('player_navigation_error', { error: err instanceof Error ? err.message : 'unknown' })
        return null
      })

      if (playerResult && playerResult.videos.length > 0) {
        log.info('collect_completed', {
          via: 'player',
          stoppedReason: playerResult.stoppedReason,
          postsRead: playerResult.postsRead,
          viewedVideos: playerResult.viewedVideos,
          videoCount: playerResult.videos.length,
        })
        return {
          status: 'completed',
          stoppedReason: playerResult.stoppedReason,
          postsRead: playerResult.postsRead,
          newPosts: playerResult.newPosts,
          pagesFetched: playerResult.pagesFetched,
          viewedVideos: playerResult.viewedVideos,
          resolvedHandle,
          videos: playerResult.videos,
          error: null,
        }
      }

      // Fallback: grid card scraping
      log.info('player_navigation_no_results_fallback_to_grid', {})
      let stoppedReason = 'end_of_feed'
      let postsRead = 0
      let pagesFetched = 0
      let viewedVideos = 0
      let lastScrollHeight = 0
      let consecutiveNoNewCards = 0
      const seenUrls = new Set<string>()
      const checkpointRuntime = createCheckpointRuntime(checkpoint)

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
          const normalizedUrl = normalizeTikTokVideoUrl(data.url)
          if (seenUrls.has(normalizedUrl)) continue
          seenUrls.add(normalizedUrl)
          postsRead++

          const video = {
            url: normalizedUrl,
            text: data.text,
            creatorHandle: data.creatorHandle,
            createdAt: data.createdAt ?? null,
            metrics: data.metrics ?? null,
          }

          log.info('liked_post_url', { url: video.url, index: postsRead })
          videos.push(video)

          const decision = await enqueueCheckpointVideo(checkpointRuntime, video)
          if (decision && !decision.shouldContinue) {
            stoppedReason = decision.stoppedReason ?? 'known_post_found'
            break
          }

          if (viewedVideos >= env.TIKTOK_WEB_MAX_VIDEOS) {
            stoppedReason = 'max_videos_reached'
            break
          }
        }

        if (stoppedReason === 'max_videos_reached' || stoppedReason === 'known_post_found') break

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

      if (stoppedReason !== 'known_post_found') {
        const decision = await flushCheckpoint(checkpointRuntime)
        if (decision && !decision.shouldContinue) {
          stoppedReason = decision.stoppedReason ?? 'known_post_found'
        }
      }

      log.info('collect_completed', { stoppedReason, postsRead, pagesFetched, viewedVideos, videoCount: videos.length })

      return {
        status: 'completed',
        stoppedReason,
        postsRead,
        newPosts: checkpointRuntime?.newPosts ?? null,
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
        newPosts: null,
        pagesFetched: 0,
        viewedVideos: 0,
        resolvedHandle: null,
        videos,
        error,
      }
    } finally {
      await withTimeout(page?.close().catch(() => undefined) ?? Promise.resolve(), 5_000)
      await withTimeout(context?.close().catch(() => undefined) ?? Promise.resolve(), 10_000)
      await browser?.close().catch(() => undefined)
      log.info('chromium_closed_after_collect', {})
    }
  },
}
