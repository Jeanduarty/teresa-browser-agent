import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const LOG_FILE = join(process.cwd(), 'logs.txt')

type LogLevel = 'info' | 'warn' | 'error'

function format(scope: string, level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const timestamp = new Date().toISOString()
  const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
  return `${timestamp} [${level.toUpperCase()}] [${scope}] ${message}${metaStr}`
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { value: String(err) }
}

function writeLine(line: string) {
  try {
    appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch {
    // silently ignore file write errors so logging never crashes the process
  }
}

export function createLogger(scope: string) {
  return {
    info(message: string, meta?: Record<string, unknown>) {
      const line = format(scope, 'info', message, meta)
      console.log(line)
      writeLine(line)
    },
    warn(message: string, meta?: Record<string, unknown>) {
      const line = format(scope, 'warn', message, meta)
      console.warn(line)
      writeLine(line)
    },
    error(message: string, err?: unknown, meta?: Record<string, unknown>) {
      const line = format(scope, 'error', message, {
        ...(meta ?? {}),
        ...(err !== undefined ? { error: serializeError(err) } : {}),
      })
      console.error(line)
      writeLine(line)
    },
  }
}
