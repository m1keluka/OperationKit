/**
 * Sentry connector (obj 900508, Sprint 7.4 catalog preload). `auth_path:
 * 'dcr_mcp'` per Sprint 7.5's direct verification
 * (docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md): `mcp.sentry.dev`
 * advertises both `registration_endpoint` and
 * `client_id_metadata_document_supported: true`, and Sentry's docs confirm
 * "the first connection will trigger an authentication flow" with no
 * pre-registration — but, same as Notion/Linear/Atlassian, the shared DCR
 * client (Sprint 7.3) is out of scope here. The only documented fallback
 * (CLI login) is a local/stdio mode, not this remote-OAuth catalog row.
 * Deferred — see docs/connectors/guides/sentry.md.
 */
import { deferredConnector } from '../lib/deferred-connector.js'

const sentry = deferredConnector({
  id: 'sentry',
  name: 'Sentry',
  order: 190,
  setup_guide: 'docs/connectors/guides/sentry.md',
  description: 'Lets agents read Sentry issues and events, once the remote MCP client (Sprint 7.3) is built.',
  products: [
    { id: 'issues', name: 'Issues', description: 'Read errors and events scoped to a project.' },
  ],
  auth_path: 'dcr_mcp',
  mcp_url: 'https://mcp.sentry.dev',
  mcp_server_url: 'https://mcp.sentry.dev/mcp',
  deferred_reason:
    "Sentry's mcp.sentry.dev supports OAuth 2.1 DCR/CIMD with no pre-registration (verified #900505), but connecting through it needs the shared DCR client (Sprint 7.3), not yet built. The documented fallback (CLI login) is a local/stdio mode, not applicable to this remote connector.",
})

export default sentry
