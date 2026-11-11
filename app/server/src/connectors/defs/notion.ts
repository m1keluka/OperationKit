/**
 * Notion connector (obj 900508, Sprint 7.4 catalog preload). `auth_path:
 * 'dcr_mcp'` per Sprint 7.5's direct verification
 * (docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md): `mcp.notion.com`
 * advertises both `registration_endpoint` (DCR) and
 * `client_id_metadata_document_supported: true` (CIMD), so no pre-registered
 * app is needed — but CONNECTING that way needs the shared DCR client, which
 * is Sprint 7.3 and explicitly out of scope for this card. Deferred — see
 * connectors/lib/deferred-connector.ts and docs/connectors/guides/notion.md
 * for the fallback that works today.
 */
import { deferredConnector } from '../lib/deferred-connector.js'

const notion = deferredConnector({
  id: 'notion',
  name: 'Notion',
  order: 160,
  setup_guide: 'docs/connectors/guides/notion.md',
  description: 'Lets agents read and write Notion pages and databases, once the remote MCP client (Sprint 7.3) is built.',
  products: [
    { id: 'pages', name: 'Pages & databases', description: 'Read and write pages and database rows.' },
  ],
  auth_path: 'dcr_mcp',
  mcp_url: 'https://mcp.notion.com',
  deferred_reason:
    "Notion's mcp.notion.com supports OAuth 2.1 DCR/CIMD (verified #900505), but connecting through it needs the shared DCR client (Sprint 7.3), not yet built. Until then, add a Notion internal-integration API key as a Settings → Secrets value (Business/Enterprise plans only) per the setup guide.",
})

export default notion
