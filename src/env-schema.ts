import { z } from 'zod'

const EnvSchema = z.object({
  BROWSER_AGENT_PORT: z.coerce.number().int().positive().default(3334),
  BROWSER_AGENT_SECRET: z.string().min(1).default('dev-secret'),
  PLAYWRIGHT_HEADLESS: z.string().default('true').transform(v => v !== 'false'),
  TIKTOK_QR_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  TIKTOK_QR_LOGIN_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  TIKTOK_LOGIN_SESSION_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
})

export const env = EnvSchema.parse(process.env)
