/**
 * Supabase connector (obj 900508, Sprint 7.4 catalog preload). `api_key`
 * per the proposal §3 row 20 — same pattern this repo already uses for its
 * own Supabase deploys (SUPABASE_ACCESS_TOKEN), scoped per Command Center
 * user rather than one shared token.
 */
import { apiKeyConnector } from '../lib/api-key-connector.js'

const supabase = apiKeyConnector({
  id: 'supabase',
  name: 'Supabase',
  order: 150,
  setup_guide: 'docs/connectors/guides/supabase.md',
  description: 'Lets agents run migrations, deploy edge functions and query project data using a Supabase access token.',
  products: [
    { id: 'projects', name: 'Projects', description: 'Manage projects, migrations and edge functions the token can reach.' },
  ],
  fields: [
    { key: 'api_key', label: 'Access token (personal or service role)', where_to_get_it_url: 'https://supabase.com/dashboard/account/tokens' },
    { key: 'project_ref', label: 'Default project ref (optional)' },
  ],
})

export default supabase
