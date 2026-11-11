/**
 * Fixture harness for Knowledge Base Setup (obj 900556).
 *
 * Not part of the app bundle — `vite build` builds from index.html only. Renders
 * the page from fixture data so it can be driven and screenshotted without a
 * server or a login.
 *
 *   npx vite --port 5199
 *   http://localhost:5199/harness/kb-setup.html?state=upload|progress|summary&theme=light|dark
 */
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import { KbSetupPage } from '../src/components/kb-setup/KbSetupPage'
import { KbSetupStep } from '../src/components/kb-setup/KbSetupStep'
import {
  FIXTURE_PROGRESS, FIXTURE_SUMMARY, FIXTURE_UPLOAD, type KbSetupFixture,
} from '../src/components/kb-setup/KbSetupPage.fixture'

const params = new URLSearchParams(window.location.search)
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.setAttribute('data-theme', theme)

const FIXTURES: Record<string, KbSetupFixture> = {
  upload: FIXTURE_UPLOAD,
  progress: FIXTURE_PROGRESS,
  summary: FIXTURE_SUMMARY,
}
const state = params.get('state') ?? 'upload'

createRoot(document.getElementById('root')!).render(
  state === 'step' ? (
    <div className="mx-auto max-w-xl space-y-3 p-6">
      <KbSetupStep done={false} />
      <KbSetupStep index={1} done />
    </div>
  ) : (
    <KbSetupPage key={state} workspace="lumen-lark" fixture={FIXTURES[state] ?? FIXTURE_UPLOAD} />
  ),
)
