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

export function createLogger(scope: string) {
  return {
    info(message: string, meta?: Record<string, unknown>) {
      console.log(format(scope, 'info', message, meta))
    },
    warn(message: string, meta?: Record<string, unknown>) {
      console.warn(format(scope, 'warn', message, meta))
    },
    error(message: string, err?: unknown, meta?: Record<string, unknown>) {
      console.error(
        format(scope, 'error', message, {
          ...(meta ?? {}),
          ...(err !== undefined ? { error: serializeError(err) } : {}),
        }),
      )
    },
  }
}
