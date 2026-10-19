import { describe, it, expect } from 'vitest'
import { laneOf } from './JobsBoard'
import type { Objective } from '@operationkit/shared'

// Lane derivation is the heart of the Jobs board: a "job" (routine-spawned
// objective) lands in Running while in flight, then in Needs Review or Complete
// once done, keyed off the orthogonal job_disposition (NOT the status).
function job(p: Pick<Objective, 'status' | 'job_disposition'>) {
  return p as Pick<Objective, 'status' | 'job_disposition'>
}

describe('laneOf', () => {
  it('non-terminal statuses are Running regardless of disposition', () => {
    for (const status of ['queue', 'working', 'ai_review', 'review'] as const) {
      expect(laneOf(job({ status, job_disposition: null }))).toBe('running')
      // disposition is ignored until the run is done
      expect(laneOf(job({ status, job_disposition: 'needs_review' }))).toBe('running')
    }
  })

  it('done + needs_review → Needs Review', () => {
    expect(laneOf(job({ status: 'done', job_disposition: 'needs_review' }))).toBe('needs_review')
  })

  it('done + complete → Complete', () => {
    expect(laneOf(job({ status: 'done', job_disposition: 'complete' }))).toBe('complete')
  })

  it('done with no disposition defaults to Complete (legacy/un-instrumented jobs)', () => {
    expect(laneOf(job({ status: 'done', job_disposition: null }))).toBe('complete')
    expect(laneOf(job({ status: 'done', job_disposition: undefined }))).toBe('complete')
  })
})
