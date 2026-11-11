/**
 * Linear connector (obj 900508, Sprint 7.4 catalog preload). `auth_path:
 * 'dcr_mcp'` per Sprint 7.5's direct verification
 * (docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md): `mcp.linear.app`
 * advertises both `registration_endpoint` and
 * `client_id_metadata_document_supported: true`, and Linear's own docs state
 * "the interactive setup flow uses OAuth 2.1 with dynamic client
 * registration" — but, same as Notion, the shared DCR client (Sprint 7.3) is
 * out of scope here. Deferred — see connectors/lib/deferred-connector.ts and
 * docs/connectors/guides/linear.md for the fallback that works today.
 */
import { deferredConnector } from '../lib/deferred-connector.js'

const linear = deferredConnector({
  id: 'linear',
  name: 'Linear',
  order: 170,
  setup_guide: 'docs/connectors/guides/linear.md',
  description: 'Lets agents read and update Linear issues, once the remote MCP client (Sprint 7.3) is built.',
  products: [
    { id: 'issues', name: 'Issues', description: 'Read and update issues across teams the token can reach.' },
  ],
  auth_path: 'dcr_mcp',
  mcp_url: 'https://mcp.linear.app',
  deferred_reason:
    "Linear's mcp.linear.app supports OAuth 2.1 DCR/CIMD (verified #900505), but connecting through it needs the shared DCR client (Sprint 7.3), not yet built. Until then, add a Linear API key as a Settings → Secrets value per the setup guide.",
})

export default linear
