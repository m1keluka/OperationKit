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
  TRANSCRIPT_DIR,
} from '../config.js'
import { buildAgentRoster, buildSkillRoster } from '../services/agent-roster.js'
import { readMemory, readDisk, readProcessCount, detectContainer } from '../services/host-stats.js'
import { readCpuUsage } from '../services/cpu-sampler.js'

const router = Router()

// VPS system stats
router.get('/system', async (_req: AuthRequest, res) => {
  const cpus = os.cpus()
  const uptime = os.uptime()

  // Host-wide CPU (every core, every container) as CURRENT usage — never the
  // since-boot average a single os.cpus() read gives. A one-off 500ms snapshot
  // swung 17%→59% within a minute on the OVH host and read as "maxed out"; the
  // sampler reports a ~10s average plus the minute's avg/peak and a
  // sessions/kernel/other split. See services/cpu-sampler.ts (obj 900685).
  const cpu = await readCpuUsage()

  // Memory (MemAvailable), disk (statfs with df's math) and process count
  // (/proc) are read from the kernel with no shell. See services/host-stats.ts
  // for what the old ps/df/freemem reads got wrong (obj 900495).
  const memory = readMemory()
  const disk = readDisk('/')
  const processCount = readProcessCount()

  // Load averages
  const loadAvg = os.loadavg()

  res.json({
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model || 'unknown',
      usagePercent: cpu.usagePercent,
      avg1mPercent: cpu.avg1mPercent,
      peak1mPercent: cpu.peak1mPercent,
      breakdown: cpu.breakdown,
      windowSeconds: cpu.windowSeconds,
      loadAvg: loadAvg.map(l => Math.round(l * 100) / 100),
    },
    memory,
    disk,
    uptime,
    processCount,
    hostname: os.hostname(),
    // Under Docker the hostname is a container id, not the machine's name; the UI labels it.
    inContainer: detectContainer(),
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

// List agents and skills — the one roster (obj 900684). Every source of agents
// the app knows about (persona files, chat/built-in agents such as Knowledge
// Base Setup, registry rows with no file, starter-pack agents not switched on)
// plus top-level skills AND sub-skills. See services/agent-roster.ts.
router.get('/agents', (_req: AuthRequest, res) => {
  try {
    res.json({ agents: buildAgentRoster(), skills: buildSkillRoster() })
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
