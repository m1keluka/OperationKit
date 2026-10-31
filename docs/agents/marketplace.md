# How a shared agent marketplace would plug in

**Status: not built.** This page describes how a future shared marketplace —
a place where consultants publish agents and clients install them — would
connect to what exists today. Everything it needs on the install side is
already in place.

## What exists today

- **One file per agent** with a `version` and an `author`
  ([agent-file-format.md](agent-file-format.md)). That file is the unit that
  would be published, downloaded and installed.
- **A local Templates gallery** (Agents → Templates) listing:
  - *Available templates* — files the install can add, with version and author;
  - *Agents on this install* — what is installed, which version, where it came from.
  It shows **Update to vX** when an available template is newer than the
  installed copy.
- **Two template sources**, read in this order:
  1. the **local templates folder** (`agent-templates/` in the workspace folder,
     or `AGENT_TEMPLATES_DIR`) — anything dropped here appears in the gallery
     marked *Local*;
  2. the **starter templates** shipped with the app (marked *Starter*).
- **One install path.** The screen, the script and server start-up all call the
  same check-then-install step, which refuses invalid files and files containing
  secret values.

## Where a marketplace connects

A marketplace only has to **put agent files into the local templates folder**.
The gallery, the update check, the validation and the install all work
unchanged.

```
marketplace catalogue ──(download agent.yaml)──▶ agent-templates/<slug>/agent.yaml
                                                         │
                                                         ▼
                                     Templates gallery: "Available" / "Update to vX"
                                                         │  (person clicks Add / Update)
                                                         ▼
                                              agents/<slug>/agent.yaml (installed)
```

Concretely, a future marketplace would add:

1. **A catalogue** — a simple list (for example a JSON file served over HTTPS)
   of `{ slug, name, description, version, author, download_url, checksum }`.
   The fields match the agent file, so the gallery can show catalogue entries
   with no new design.
2. **A "Get" action** that downloads one file into the local templates folder
   after checking its checksum. From there it is an ordinary local template.
3. **Optional signing** — the catalogue publishes the author's public key and a
   signature per file, and the install refuses unsigned or altered files. The
   `author` field becomes a verified publisher name.

## Rules a marketplace must keep

- **The client decides.** Nothing is installed or updated automatically; a person
  clicks Add or Update. Schedules arrive switched off.
- **No secrets in files.** The importer already rejects files that look like
  they contain a key. Agents reference secrets by name; each client stores their
  own values in Settings → Secrets.
- **Each install stays private.** The marketplace sends files *to* an install; it
  never reads the client's knowledge base, cards or secrets. Downloading a file is
  the only network call, and an install can work with no marketplace at all.
- **Generic agents only.** Agents should not depend on one client's folder names;
  `knowledge_folders` is the one place an installer adapts an agent to a client.
- **Versions only go up.** A newer `version` is offered as an update; the
  installed copy is replaced only when the person accepts.

## Not decided yet

Pricing, reviews/ratings, who may publish, and where the catalogue is hosted are
business decisions for when the marketplace is built.
