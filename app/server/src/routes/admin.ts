/**
 * Admin API facade (`/api/admin`).
 *
 * Split: accounts in admin-accounts.ts, ops in admin-ops.ts, jobs/assistant/strategy
 * in admin-jobs.ts. Users and workspaces already live in admin-users.ts /
 * admin-workspaces.ts (mounted separately). This file applies auth and composes
 * the remaining route groups. Paths are unchanged.
 */
import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import accountsRouter from './admin-accounts.js'
import seatsRouter from './admin-seats.js'
import emailRouter from './admin-email.js'
import opsRouter from './admin-ops.js'
import jobsRouter from './admin-jobs.js'
import queueAutostartRouter from './admin-queue-autostart.js'

const router = Router()

// All admin routes require auth + admin
router.use(requireAuth, requireAdmin)
router.use(accountsRouter)
router.use(seatsRouter)
router.use(emailRouter)  // /api/admin/email, /setup-status (obj 900497)
router.use(opsRouter)
router.use(jobsRouter)
router.use(queueAutostartRouter)  // /api/admin/queue-autostart (obj 900625)

export default router
