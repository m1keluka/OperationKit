/**
 * Fixture harness for the Agents tab (obj 712126).
 *
 * Not part of the app bundle — `vite build` builds from index.html only, so
 * this entry exists purely so the tab can be driven in a real browser (and
 * screenshotted) WITHOUT an authenticated board or the board-layer API, which
 * W6 (obj 712124) is still landing on its own branch.
 *
 *   npx vite --port 5199        →  http://localhost:5199/harness/index.html
 */
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import '../src/index.css'
import { AgentsPage } from '../src/components/AgentsPage'
import { AGENTS_FIXTURE, fixtureLoadFile } from '../src/components/AgentsPage.fixture'

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/agents?project=16']}>
    <Routes>
      <Route path="/agents" element={
        <AgentsPage workspace="example" fixture={AGENTS_FIXTURE} loadFile={fixtureLoadFile} />
      } />
    </Routes>
  </MemoryRouter>,
)
