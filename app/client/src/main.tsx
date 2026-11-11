import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// Brand: OperationKit. The container's index.html is image-baked (not bind-mounted),
// so set the document title + caret favicon at runtime from the (mounted) client src.
document.title = 'OperationKit'
{
  const favicon =
    (document.querySelector("link[rel='icon']") as HTMLLinkElement | null) ??
    document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }))
  favicon.type = 'image/svg+xml'
  favicon.href =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230c0f14'/%3E%3Ctext x='15' y='23' font-family='monospace' font-size='22' font-weight='700' fill='%23ff5a1f'%3E%E2%80%BA%3C/text%3E%3C/svg%3E"
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
