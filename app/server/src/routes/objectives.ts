import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { registerObjectiveCrudRoutes } from './objectives-crud.js'
import { registerObjectiveStatusRoutes } from './objectives-status.js'
import { registerObjectiveUploadRoutes } from './objectives-uploads.js'
import { registerObjectivePlanningRoutes } from './objectives-planning.js'
import {
  registerObjectiveGoalDraftRoutes,
  registerObjectiveControlRoutes,
} from './objectives-control.js'
import { registerObjectiveOutputRoutes } from './objectives-output.js'
import { registerObjectiveDesignRoutes } from './objectives-design.js'

const router = Router()
router.use(requireAuth)

registerObjectiveCrudRoutes(router)
registerObjectiveGoalDraftRoutes(router)
registerObjectiveStatusRoutes(router)
registerObjectiveOutputRoutes(router)
registerObjectiveDesignRoutes(router)
registerObjectiveControlRoutes(router)
registerObjectiveUploadRoutes(router)
registerObjectivePlanningRoutes(router)

export default router
