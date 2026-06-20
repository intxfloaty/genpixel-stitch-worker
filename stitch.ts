import { createClient } from '@supabase/supabase-js'
import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const VIDEO_WIDTH = 1080
const VIDEO_HEIGHT = 1920
const FONT_SIZE = 56
const LINE_HEIGHT = Math.round(FONT_SIZE * 1.35)

type Generation = {
  id: string
  project_id: string
  hook_text: string | null
  reaction_clip_url: string | null
  status: string
}

type Project = {
  demo_media_urls: string[]
}

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function wrapText(text: string, maxWidth: number): string[] {
  const avgCharWidth = FONT_SIZE * 0.58
  const maxChars = Math.floor(maxWidth / avgCharWidth)
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

async function renderTextOverlay(text: string, outputPath: string): Promise<void> {
  const usableWidth = Math.round(VIDEO_WIDTH * 0.88)
  const lines = wrapText(text.trim(), usableWidth)
  const yStart = Math.round(VIDEO_HEIGHT * 0.07) + FONT_SIZE

  const textElements = lines
    .map(
      (line, i) =>
        `<text x="${VIDEO_WIDTH / 2}" y="${yStart + i * LINE_HEIGHT}" font-family="DejaVu Sans, sans-serif" font-size="${FONT_SIZE}" font-weight="bold" fill="white" text-anchor="middle" filter="url(#shadow)">${escapeXml(line)}</text>`
    )
    .join('\n    ')

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${VIDEO_WIDTH}" height="${VIDEO_HEIGHT}">
  <defs>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="black" flood-opacity="0.9"/>
    </filter>
  </defs>
  ${textElements}
</svg>`

  await sharp(Buffer.from(svg)).png().toFile(outputPath)
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const headers: HeadersInit = {}

  if (url.startsWith(SUPABASE_URL)) {
    headers['Authorization'] = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  }

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`)

  const buffer = Buffer.from(await res.arrayBuffer())
  await writeFile(destPath, buffer)
}

const SCALE_PAD = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2'

async function runFfmpeg({
  reactionPath,
  demoPath,
  overlayPath,
  outputPath,
}: {
  reactionPath: string
  demoPath: string | null
  overlayPath: string | null
  outputPath: string
}): Promise<void> {
  const args: string[] = []

  if (demoPath) {
    args.push('-i', reactionPath, '-i', demoPath)
    if (overlayPath) args.push('-i', overlayPath)

    const overlayIdx = overlayPath ? 2 : null
    const filterParts = [
      `[0:v]${SCALE_PAD}[v0]`,
      `[1:v]${SCALE_PAD}[v1]`,
      '[v0][v1]concat=n=2:v=1:a=0[concat]',
      overlayIdx !== null
        ? `[concat][${overlayIdx}:v]overlay=0:0:enable='lte(t,3)'[out]`
        : '[concat]copy[out]',
    ]

    args.push('-filter_complex', filterParts.join(';'), '-map', '[out]')
  } else {
    args.push('-i', reactionPath)
    if (overlayPath) args.push('-i', overlayPath)

    if (overlayPath) {
      args.push(
        '-filter_complex',
        `[0:v]${SCALE_PAD}[scaled];[scaled][1:v]overlay=0:0:enable='lte(t,3)'[out]`,
        '-map', '[out]'
      )
    } else {
      args.push('-vf', SCALE_PAD)
    }
  }

  args.push(
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-threads', '2', '-x264-params', 'rc-lookahead=10',
    '-an', '-y', outputPath
  )

  const { stderr } = await execFileAsync('ffmpeg', args)
  if (stderr) console.log('[ffmpeg]', stderr)
}

export async function stitchVideo(generationId: string): Promise<void> {
  const supabase = getSupabase()
  const tmpDir = await mkdtemp(join(tmpdir(), `stitch-${generationId}-`))

  try {
    // 1. Fetch generation
    const { data: generation, error: genErr } = await supabase
      .from('generations')
      .select('id, project_id, hook_text, reaction_clip_url, status')
      .eq('id', generationId)
      .single()

    if (genErr || !generation) throw new Error(`Generation not found: ${generationId}`)

    const gen = generation as Generation

    if (!gen.reaction_clip_url) throw new Error('Missing reaction_clip_url')

    // 2. Fetch project for demo footage
    const { data: project } = await supabase
      .from('projects')
      .select('demo_media_urls')
      .eq('id', gen.project_id)
      .single()

    const proj = project as Project | null
    const demoUrl = proj?.demo_media_urls?.[0] ?? null

    // 3. Download files to temp dir
    const reactionPath = join(tmpDir, 'reaction.mp4')
    await downloadFile(gen.reaction_clip_url, reactionPath)

    let demoPath: string | null = null
    if (demoUrl) {
      demoPath = join(tmpDir, 'demo.mp4')
      await downloadFile(demoUrl, demoPath)
    }

    // 4. Render text overlay PNG if hook text exists
    let overlayPath: string | null = null
    if (gen.hook_text) {
      overlayPath = join(tmpDir, 'overlay.png')
      await renderTextOverlay(gen.hook_text, overlayPath)
    }

    // 5. Run ffmpeg
    const outputPath = join(tmpDir, 'output.mp4')
    await runFfmpeg({ reactionPath, demoPath, overlayPath, outputPath })

    // 6. Upload final video to Supabase Storage
    const outputBuffer = await readFile(outputPath)
    const storagePath = `finals/${generationId}.mp4`

    const { error: uploadErr } = await supabase.storage
      .from('finals')
      .upload(storagePath, outputBuffer, { contentType: 'video/mp4', upsert: true })

    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    const { data: { publicUrl } } = supabase.storage
      .from('finals')
      .getPublicUrl(storagePath)

    // 7. Mark complete
    await supabase
      .from('generations')
      .update({ status: 'complete', final_video_url: publicUrl })
      .eq('id', generationId)

    console.log(`[stitch] Done: ${generationId} → ${publicUrl}`)
  } catch (err) {
    console.error(`[stitch] Failed: ${generationId}`, err)

    await supabase
      .from('generations')
      .update({ status: 'failed' })
      .eq('id', generationId)

    throw err
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
