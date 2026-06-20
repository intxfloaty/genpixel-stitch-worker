import express from 'express'
import { stitchVideo } from './stitch'

const app = express()
app.use(express.json())

const PORT = process.env.PORT ?? 3001
const WORKER_SECRET = process.env.STITCH_WORKER_SECRET

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/', (req, res) => {
  const authHeader = req.headers.authorization
  if (WORKER_SECRET && authHeader !== `Bearer ${WORKER_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const { generation_id } = req.body as { generation_id?: string }
  if (!generation_id) {
    res.status(400).json({ error: 'Missing generation_id' })
    return
  }

  // Respond immediately so the caller's webhook doesn't time out
  res.json({ received: true })

  stitchVideo(generation_id).catch((err) => {
    console.error(`[worker] Unhandled error for ${generation_id}:`, err)
  })
})

app.listen(PORT, () => {
  console.log(`Stitch worker listening on port ${PORT}`)
})
