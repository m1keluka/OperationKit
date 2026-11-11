import { Router } from 'express'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()

// Serve the shell HTML page (admin only)
router.get('/', requireAuth, requireAdmin, (_req: AuthRequest, res) => {
  res.sendFile(path.join(__dirname, '../../shell.html'))
})

export default router
