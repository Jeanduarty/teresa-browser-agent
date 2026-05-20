import { z } from 'zod'

const EnvSchema = z.object({
  BROWSER_AGENT_PORT: z.coerce.number().int().positive().default(3334),
  BROWSER_AGENT_SECRET: z.string().min(1).default('dev-secret'),
  PLAYWRIGHT_HEADLESS: z.string().default('true').transform(v => v !== 'false'),
  TIKTOK_QR_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  TIKTOK_QR_LOGIN_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  TIKTOK_LOGIN_SESSION_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  TIKTOK_WEB_MAX_VIDEOS: z.coerce.number().int().positive().default(80),
  TIKTOK_WEB_HOVER_MIN_MS: z.coerce.number().int().positive().default(800),
  TIKTOK_WEB_HOVER_MAX_MS: z.coerce.number().int().positive().default(2500),
  TIKTOK_WEB_SCROLL_DELAY_MIN_MS: z.coerce.number().int().positive().default(2000),
  TIKTOK_WEB_SCROLL_DELAY_MAX_MS: z.coerce.number().int().positive().default(5000),
})

export const env = EnvSchema.parse(process.env)
