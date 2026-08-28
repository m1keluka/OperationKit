import { Router } from 'express'
import { registerInternalDeployRoutes } from './internal-deploy.js'
import { registerInternalProgressRoutes } from './internal-progress.js'
import { registerInternalHermesRoutes } from './internal-hermes.js'
import { registerInternalCreateRoutes } from './internal-create.js'
import { registerInternalPreviewRoutes } from './internal-preview.js'
import { registerInternalGmailRoutes } from './internal-gmail.js'
import { registerInternalMentorRoutes } from './internal-mentor.js'
import { registerInternalReposRoutes } from './internal-repos.js'

const router = Router()

registerInternalDeployRoutes(router)
registerInternalCreateRoutes(router)
registerInternalPreviewRoutes(router)
registerInternalProgressRoutes(router)
registerInternalGmailRoutes(router)
registerInternalHermesRoutes(router)
registerInternalMentorRoutes(router)
registerInternalReposRoutes(router)

export default router
