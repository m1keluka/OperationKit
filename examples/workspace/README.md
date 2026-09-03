# Example workspace

This is a **generic, self-contained example** of the directory tree Command Center
expects a workspace to live in. It exists so a fresh self-hosted install has
something to point at out of the box, and so you can see the shape before wiring
up your own.

Point the relevant env vars at this tree (or copy it somewhere and edit):

```
AI_WORKSPACE_DIR=/path/to/examples/workspace
SECOND_BRAIN_DIR=/path/to/examples/workspace
```

Layout:

```
examples/workspace/
  agents/                      # agent personas the orchestrator can adopt
    engineer.md
    ops.md
    general.md
  skills/                      # reusable, parameterized capabilities
    summarize-notes/SKILL.md
    draft-update/SKILL.md
  workspaces/
    acme/context.md            # per-workspace business context (placeholder)
```

Everything here is fictional ("Acme"). Replace it with your own personas, skills,
and context. Nothing in this tree references any real person, company, or host.
