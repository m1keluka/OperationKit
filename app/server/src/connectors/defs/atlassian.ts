/**
 * Atlassian (Rovo — Jira/Confluence/Bitbucket) connector (obj 900508,
 * Sprint 7.4 catalog preload). `auth_path: 'dcr_mcp'` per Sprint 7.5's
 * direct verification (docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md):
 * `mcp.atlassian.com` advertises `registration_endpoint` (DCR confirmed),
 * though CIMD support on that specific issuer is flagged UNCONFIRMED there
 * (don't assume it carries over from `auth.atlassian.com`). Either way the
 * shared DCR client (Sprint 7.3) is out of scope for this card — deferred.
 * No API-key fallback is documented for Rovo MCP, so there is no "connect
 * today" path at all yet; see docs/connectors/guides/atlassian.md.
 */
import { deferredConnector } from '../lib/deferred-connector.js'

const atlassian = deferredConnector({
  id: 'atlassian',
  name: 'Atlassian (Jira, Confluence, Bitbucket)',
  order: 180,
  setup_guide: 'docs/connectors/guides/atlassian.md',
  description: 'Lets agents read and update Jira, Confluence and Bitbucket via the Rovo MCP server, once the remote MCP client (Sprint 7.3) is built.',
  products: [
    { id: 'jira', name: 'Jira', description: 'Read and update issues.' },
    { id: 'confluence', name: 'Confluence', description: 'Read and update pages.' },
    { id: 'bitbucket', name: 'Bitbucket', description: 'Read repositories and pull requests.' },
  ],
  auth_path: 'dcr_mcp',
  mcp_url: 'https://mcp.atlassian.com',
  deferred_reason:
    "Atlassian's mcp.atlassian.com confirms DCR (registration_endpoint); CIMD support on that issuer is unconfirmed (#900505). Either way, connecting needs the shared DCR client (Sprint 7.3), not yet built, and no API-key fallback is documented for Rovo MCP — this entry is catalog-only until Sprint 7.3 ships.",
})

export default atlassian
