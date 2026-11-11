# Connect GitHub

GitHub connects with a personal access token (`auth_path: 'api_key'`) — there is no
guided OAuth wizard for this connector yet.

1. On GitHub, go to **Settings → Developer settings → Fine-grained tokens** and
   generate a new token.
2. Grant it **Contents** and **Pull requests** permissions (read and write) for the
   repositories agents should work in.
3. Paste the token into Settings → Connectors → GitHub in this app.

Agents then open pull requests and push code as you, with no separate `GH_TOKEN`
secret needed. See `app/server/src/connectors/defs/github.ts`.
