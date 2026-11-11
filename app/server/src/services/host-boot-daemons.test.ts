import { describe, it, expect, vi } from 'vitest'

// obj 720210: a client install has no host-boot.d; the runner must not log a
// "run-all failed: No such file" line on every tick.
process.env.HOST_BOOT_RUN_ALL = '/nonexistent/host-boot.d/run-all.sh'
const { startHostBootDaemons } = await import('./host-boot-daemons.js')

describe('host-boot on an install without host-boot.d', () => {
  it('logs once that it is off and never runs the script', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const timers = vi.spyOn(global, 'setInterval')
    try {
      startHostBootDaemons()
      expect(log.mock.calls.flat().join('\n')).toContain('not present — host-boot daemons off')
      expect(timers).not.toHaveBeenCalled()
      expect(err).not.toHaveBeenCalled()
    } finally {
      log.mockRestore(); err.mockRestore(); timers.mockRestore()
    }
  })
})
