import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

import type { Cookie } from './tiktok-scraping-service.js'

const execFileAsync = promisify(execFile)

export type DownloadedAudio = {
  buffer: Buffer
  filename: string
  contentType: string
}

function toNetscapeCookies(cookies: Cookie[]): string {
  const lines = [
    '# Netscape HTTP Cookie File',
    ...cookies.map(cookie => {
      const domain = cookie.domain.startsWith('.') ? cookie.domain : cookie.domain
      const includeSubdomains = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE'
      const path = cookie.path || '/'
      const secure = cookie.secure ? 'TRUE' : 'FALSE'
      const expires = cookie.expires && cookie.expires > 0 ? Math.floor(cookie.expires) : 0
      return [domain, includeSubdomains, path, secure, expires, cookie.name, cookie.value].join('\t')
    }),
  ]

  return `${lines.join('\n')}\n`
}

async function assertYtDlpReady(): Promise<void> {
  try {
    await execFileAsync('yt-dlp', ['--version'], { timeout: 5_000 })
  } catch {
    throw new Error('yt-dlp não está instalado ou não está disponível no PATH do browser-agent.')
  }

  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5_000 })
  } catch {
    throw new Error('ffmpeg não está instalado ou não está disponível no PATH do browser-agent.')
  }
}

export const mediaAudioService = {
  async downloadAudio(url: string, cookies: Cookie[] = []): Promise<DownloadedAudio> {
    await assertYtDlpReady()

    const tempDir = await mkdtemp(join(tmpdir(), 'teresa-audio-'))
    const outputTemplate = join(tempDir, 'audio.%(ext)s')
    const cookieFile = join(tempDir, 'cookies.txt')

    try {
      const args = [
        '--no-playlist',
        '-f',
        'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio/best',
        '--extract-audio',
        '--audio-format',
        'm4a',
        '--audio-quality',
        '128K',
        '-o',
        outputTemplate,
      ]

      if (cookies.length > 0) {
        await writeFile(cookieFile, toNetscapeCookies(cookies), 'utf8')
        args.push('--cookies', cookieFile)
      }

      args.push(url)

      await execFileAsync('yt-dlp', args, { timeout: 180_000 })

      const files = await readdir(tempDir)
      const audioFile = files.find(file => file.endsWith('.m4a')) ?? files.find(file => file !== 'cookies.txt')
      if (!audioFile) {
        throw new Error('yt-dlp não gerou arquivo de áudio.')
      }

      return {
        buffer: await readFile(join(tempDir, audioFile)),
        filename: audioFile,
        contentType: 'audio/mp4',
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  },
}
