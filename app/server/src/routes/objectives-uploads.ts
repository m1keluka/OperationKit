/**
 * Objective file uploads — extracted from objectives.ts (behavior frozen).
 * Registered on the same /api/objectives router. Upload dir and limits unchanged.
 */
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import type { Objective } from '@command-center/shared'
import { requireOwnership } from './objectives-helpers.js'

// Upload storage — files go to /app/data/uploads/<objectiveId>/
const UPLOAD_DIR = '/app/data/uploads'
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(UPLOAD_DIR, String(req.params.id))
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      // Preserve original name, prefix with timestamp to avoid collisions
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, `${Date.now()}-${safeName}`)
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
})

export function registerObjectiveUploadRoutes(router: Router): void {
// POST /api/objectives/:id/upload — upload files for use in session prompts
// Phase 5: must be the owner (admin bypasses). Files become part of the session
// prompt — uploading to someone else's objective is a prompt-injection vector.
router.post('/:id/upload', (req: AuthRequest, res, next) => {
  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const ownershipError = requireOwnership(req, objective)
  if (ownershipError) {
    res.status(403).json({ error: ownershipError })
    return
  }
  next()
}, upload.array('files', 10), (req, res) => {
  const files = req.files as Express.Multer.File[]
  if (!files || files.length === 0) {
    res.status(400).json({ error: 'No files uploaded' })
    return
  }
  const uploaded = files.map(f => ({
    originalName: f.originalname,
    path: f.path,
    size: f.size,
    mimetype: f.mimetype,
  }))
  console.log(`[upload] ${files.length} file(s) uploaded for objective ${req.params.id}`)
  res.json({ files: uploaded })
})

// GET /api/objectives/:id/uploads — list uploaded files
router.get('/:id/uploads', (req: AuthRequest, res) => {
  const id = String(req.params.id)
  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const ownershipError = requireOwnership(req, objective)
  if (ownershipError) {
    res.status(403).json({ error: ownershipError })
    return
  }
  const dir = path.join(UPLOAD_DIR, id)
  if (!fs.existsSync(dir)) {
    res.json({ files: [] })
    return
  }
  const files = fs.readdirSync(dir).map(name => {
    const fullPath = path.join(dir, name)
    const stat = fs.statSync(fullPath)
    return { name, path: fullPath, size: stat.size }
  })
  res.json({ files })
})

}
