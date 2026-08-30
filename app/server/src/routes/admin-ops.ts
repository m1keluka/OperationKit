/**
 * Admin ops routes (system, rebuild, restart, agents, file, cron) —
 * extracted from admin.ts (behavior frozen).
 *
 * Auth is applied by the admin.ts facade. Paths are unchanged.
 */
import { Router } from 'express'
import type { Response } from 'express'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { AuthRequest } from '../middleware/auth.js'
import { scheduleRestart } from '../services/restart-guard.js'
import {
  AI_WORKSPACE_DIR,
  AGENTS_DIR,
  SKILLS_DIR,
  TRANSCRIPT_DIR,
} from '../config.js'
import { AGENT_META, type AgentContext } from '@operationkit/shared'

const router = Router()

// VPS system stats
router.get('/system', async (_req: AuthRequest, res) => {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const uptime = os.uptime()

  // CPU usage sampled over a short interval. os.cpus() reports CUMULATIVE times
  // since boot, so (1 - idle/total) on a single read is the average utilisation
  // *since boot* — on a long-lived box that reads near-idle (e.g. 13%) even when
  // the machine is currently pegged, which hid real CPU pressure and made it look
  // like we had headroom. Diff two snapshots ~500ms apart for CURRENT usage.
  // Only `idle` is subtracted, so niced session work correctly counts as busy.
  const snapshot = () => os.cpus().reduce((acc, c) => {
    const total = Object.values(c.times).reduce((a, b) => a + b, 0)
    return { idle: acc.idle + c.times.idle, total: acc.total + total }
  }, { idle: 0, total: 0 })
  const s1 = snapshot()
  await new Promise(resolve => setTimeout(resolve, 500))
  const s2 = snapshot()
  const idleDelta = s2.idle - s1.idle
  const totalDelta = s2.total - s1.total
  const cpuUsage = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0

  // Disk usage via df
  let disk = { total: 0, used: 0, available: 0, usagePercent: 0 }
  try {
    const df = execSync("df -B1 / | tail -1", { encoding: 'utf-8', timeout: 5000 }).trim().split(/\s+/)
    disk = {
      total: parseInt(df[1]) || 0,
      used: parseInt(df[2]) || 0,
      available: parseInt(df[3]) || 0,
      usagePercent: parseInt(df[4]) || 0,
    }
  } catch {}

  // Load averages
  const loadAvg = os.loadavg()

  // Process count
  let processCount = 0
  try {
    processCount = parseInt(execSync("ps aux | wc -l", { encoding: 'utf-8', timeout: 5000 }).trim()) - 1
  } catch {}

  res.json({
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model || 'unknown',
      usagePercent: Math.round(cpuUsage * 10) / 10,
      loadAvg: loadAvg.map(l => Math.round(l * 100) / 100),
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usagePercent: Math.round((usedMem / totalMem) * 1000) / 10,
    },
    disk,
    uptime,
    processCount,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    timestamp: new Date().toISOString(),
  })
})

// Rebuild frontend
router.post('/rebuild-frontend', (_req: AuthRequest, res) => {
  try {
    const output = execSync('npx vite build --outDir dist', {
      timeout: 90000,
      encoding: 'utf-8',
      cwd: '/app/client',
    })
    res.json({ ok: true, output })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Build failed'
    res.status(500).json({ error: message })
  }
})

// Restart server. Admin-initiated and deliberate, so it forces past the
// self-deploy cooldown — but still records the marker + in-process dedupe so a
// session deploy arriving right after won't pile on a second restart.
router.post('/restart', (_req: AuthRequest, res) => {
  const result = scheduleRestart('admin restart', { force: true })
  if (!result.scheduled) {
    res.json({ ok: true, coalesced: true, message: 'Restart already in progress.' })
    return
  }
  res.json({ ok: true, message: 'Restarting in 1 second...' }) // Container auto-restarts
})

// List agents and skills
router.get('/agents', (_req: AuthRequest, res) => {
  try {
    // Read agent files
    const agentFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'))
    const agents = agentFiles.map(filename => {
      const stat = fs.statSync(path.join(AGENTS_DIR, filename))
      const slug = filename.replace('.md', '') as AgentContext
      // Persona intent classification (obj-2387 / D7). A persona present on disk
      // but absent from AGENT_META is shown as routing-only + non-assignable so
      // nothing is silently mislabeled (e.g. an unmapped new persona file).
      const meta = AGENT_META[slug]
      return {
        name: slug.replace(/-/g, ' '),
        filename,
        slug,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        assignable: meta ? meta.assignable : false,
        kind: meta ? meta.kind : 'routing-only',
        label: meta ? meta.label : slug,
      }
    })

    // Read skill directories
    const skillDirs = fs.readdirSync(SKILLS_DIR).filter(d => {
      try { return fs.statSync(path.join(SKILLS_DIR, d)).isDirectory() } catch { return false }
    })
    const skills = skillDirs.map(dirname => {
      const skillFile = path.join(SKILLS_DIR, dirname, 'SKILL.md')
      let description = ''
      let size = 0
      try {
        const stat = fs.statSync(skillFile)
        size = stat.size
        const content = fs.readFileSync(skillFile, 'utf-8')
        // Parse YAML frontmatter description
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
        if (fmMatch) {
          const descMatch = fmMatch[1].match(/description:\s*(.+)/)
          if (descMatch) description = descMatch[1].trim()
        }
      } catch {}
      // Count sub-files
      let fileCount = 0
      try {
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry)
            if (fs.statSync(full).isDirectory()) walk(full)
            else fileCount++
          }
        }
        walk(path.join(SKILLS_DIR, dirname))
      } catch {}
      return { name: dirname, description, dirname, size, fileCount }
    })

    res.json({ agents, skills })
  } catch (err) {
    res.status(500).json({ error: 'Failed to read workspace' })
  }
})

// Read a file from ai-workspace (path-validated)
router.get('/file', (req: AuthRequest, res) => {
  const filePath = req.query.path as string
  if (!filePath) {
    res.status(400).json({ error: 'path query param required' })
    return
  }
  // Resolve and validate path stays within ai-workspace
  const resolved = path.resolve(AI_WORKSPACE_DIR, filePath)
  if (!resolved.startsWith(AI_WORKSPACE_DIR)) {
    res.status(403).json({ error: 'Path outside workspace' })
    return
  }
  try {
    const content = fs.readFileSync(resolved, 'utf-8')
    res.json({ path: filePath, content, size: Buffer.byteLength(content) })
  } catch {
    res.status(404).json({ error: 'File not found' })
  }
})

// Cron jobs status
router.get('/cron', (_req: AuthRequest, res) => {
  try {
    // Read cached crontab (host writes to this mounted path)
    let crontab = ''
    try {
      crontab = fs.readFileSync(path.join(TRANSCRIPT_DIR, 'crontab-cache.txt'), 'utf-8')
    } catch {}

    // Parse cron entries with # command-center: tags
    const jobs: Array<{
      name: string
      schedule: string
      scheduleHuman: string
      scriptPath: string
      logFile: string
      logTail: string
      logSize: number
      timezone: string
    }> = []

    let currentTz = 'UTC'
    for (const line of crontab.split('\n')) {
      const tzMatch = line.match(/^CRON_TZ=(.+)/)
      if (tzMatch) {
        currentTz = tzMatch[1].trim()
        continue
      }

      const ccMatch = line.match(/^([0-9*\/,\- ]+)\s+(.+?)\s+>>\s+(\S+).*#\s*command-center:\s*(\S+)/)
      if (ccMatch) {
        const [, schedule, scriptPart, logFile, name] = ccMatch
        const scriptMatch = scriptPart.match(/(?:bash\s+)?(\S+\.sh)/)
        const scriptPath = scriptMatch ? scriptMatch[1] : scriptPart.trim()

        // Human-readable schedule
        const parts = schedule.trim().split(/\s+/)
        let scheduleHuman = schedule.trim()
        if (parts[0] === '0' && parts[1] === '*') scheduleHuman = 'Every hour'
        else if (parts[1] !== '*') scheduleHuman = `Daily at ${parseInt(parts[1])}:${parts[0].padStart(2, '0')}`
        else if (parts[0] !== '*') scheduleHuman = `At :${parts[0].padStart(2, '0')} every hour`

        // Tail the log file
        let logTail = ''
        let logSize = 0
        try {
          const stat = fs.statSync(logFile)
          logSize = stat.size
          const content = fs.readFileSync(logFile, 'utf-8')
          const lines = content.trim().split('\n')
          logTail = lines.slice(-50).join('\n')
        } catch {}

        jobs.push({
          name,
          schedule: schedule.trim(),
          scheduleHuman,
          scriptPath,
          logFile,
          logTail,
          logSize,
          timezone: currentTz,
        })
        // Reset TZ after use (only applies to next line)
        currentTz = 'UTC'
      }
    }

    res.json(jobs)
  } catch (err) {
    res.status(500).json({ error: 'Failed to read cron config' })
  }
})


export default router
