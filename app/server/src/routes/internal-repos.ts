/**
 * Localhost list of linked repos (living-docs Job reads this).
 */
import type { Router } from 'express'
import { isLocalhost } from '../lib/is-localhost.js'
import { listLivingDocsRepos, listWorkspaceRepos } from '../services/workspace-repos.js'
import { listWorkspaces } from '../services/workspaces.js'

export function registerInternalReposRoutes(router: Router): void {
  router.get('/repos', (req, res) => {
    if (!isLocalhost(req)) {
      res.status(403).json({ error: 'Internal API: localhost only' })
      return
    }
    const living = req.query.living === '1' || req.query.living === 'true'
    if (living) {
      res.json({ repos: listLivingDocsRepos() })
      return
    }
    const repos = listWorkspaces().flatMap(w => listWorkspaceRepos(w.slug))
    res.json({ repos })
  })
}
