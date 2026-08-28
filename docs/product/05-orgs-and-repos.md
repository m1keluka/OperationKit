# Organizations and linked repos

An **organization** (workspace) is a business: Example, Example Project, Example3, …. Cards, Docs roots, and agent pools hang off it.

A **linked repo** is a GitHub project attached to an organization: name, `owner/repo`, optional path on disk (`/home/operator/projects/…`), stack tags, and whether **living product docs** are on.

## Attach a repo

Settings → Org → expand the organization → **Repos & projects**.

- Paste `owner/repo`, or **Add repo from org** if GitHub is connected for that org.
- Set `repo_path` when the checkout lives on this VPS (needed for the docs breathe job to edit the tree).
- Leave **Living docs** on unless the repo should be ignored.

The same row is how changelog and GitHub webhooks know which org a repo belongs to, and how a session opens a PR (`gh pr create --repo owner/repo`). Do not invent a second list.

## Projects (folders)

Within an organization you can create **projects** — named folders that group related cards on the Board. A project is not a linked repo; it is a lightweight label (`projects` table, one row per name per workspace).

- Create / rename / delete: Board → **Projects** button (top-right) → manage.
- Filter: the Board toolbar shows a project picker; selecting one hides cards not in that folder.
- Assign a card: on the card form or the edit drawer, pick a project. The association is a nullable `project_id` foreign key on `objectives`; deleting a project unlinks its cards rather than deleting them.

Projects complement linked repos — a project is “what we're building now” (a sprint or initiative); a linked repo is “where the code lives.”

## What “living docs” means

If enabled, the daily **docs-breathe** Job looks at that checkout’s `docs/product/` (see [LIVING.md](./LIVING.md)). If the product changed yesterday, it updates those files via a PR. If the folder does not exist yet, the Job may create the skeleton (README + what-it-is) rather than invent a novel wiki.

Command Center itself is a linked Example repo: `your-org/command-center-infra`, path `/home/operator/projects/command-center-infra`, docs at `docs/product/`.
