import { createClient } from '@supabase/supabase-js'
import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// DejaVu Sans Bold — installed via apt fonts-dejavu-core in Dockerfile
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

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

// Replace characters that break ffmpeg's drawtext text= option
function sanitizeHookText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '’') // replace straight apostrophe with right single quote (renders identically)
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ')
    .trim()
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const headers: HeadersInit = {}

  // Private Supabase storage buckets need the service role key
  if (url.startsWith(SUPABASE_URL)) {
    headers['Authorization'] = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  }

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`)

  const buffer = Buffer.from(await res.arrayBuffer())
  await writeFile(destPath, buffer)
}

async function runFfmpeg({
  reactionPath,
  demoPath,
  hookText,
  outputPath,
}: {
  reactionPath: string
  demoPath: string | null
  hookText: string | null
  outputPath: string
}): Promise<void> {
  const args: string[] = []

  const drawtextFilter = hookText
    ? `drawtext=fontfile=${FONT_PATH}:text='${sanitizeHookText(hookText)}':fontcolor=white:fontsize=72:x=(w-tw)/2:y=h*0.08:shadowcolor=black:shadowx=2:shadowy=2:enable='lte(t,3)'`
    : null

  if (demoPath) {
    // Scale both clips to 1080x1920 (portrait), concat, then overlay hook text on first 3s
    const filterParts = [
      '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[v0]',
      '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[v1]',
      '[v0][v1]concat=n=2:v=1:a=0[concat]',
      drawtextFilter ? `[concat]${drawtextFilter}[out]` : '[concat]copy[out]',
    ]

    args.push('-i', reactionPath)
    args.push('-i', demoPath)
    args.push('-filter_complex', filterParts.join(';'))
    args.push('-map', '[out]')
  } else {
    // Reaction clip only — optionally with hook text overlay
    args.push('-i', reactionPath)

    if (drawtextFilter) {
      args.push('-vf', `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,${drawtextFilter}`)
    } else {
      args.push('-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2')
    }
  }

  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '2', '-x264-params', 'rc-lookahead=10', '-an', '-y', outputPath)

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

    // 4. Run ffmpeg
    const outputPath = join(tmpDir, 'output.mp4')
    await runFfmpeg({ reactionPath, demoPath, hookText: gen.hook_text, outputPath })

    // 5. Upload final video to Supabase Storage (transformations bucket is public)
    const outputBuffer = await readFile(outputPath)
    const storagePath = `finals/${generationId}.mp4`

    const { error: uploadErr } = await supabase.storage
      .from('finals')
      .upload(storagePath, outputBuffer, { contentType: 'video/mp4', upsert: true })

    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

    const { data: { publicUrl } } = supabase.storage
      .from('finals')
      .getPublicUrl(storagePath)

    // 6. Mark complete
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
