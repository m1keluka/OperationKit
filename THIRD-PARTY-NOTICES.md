# Third-party notices

OperationKit itself is licensed under [Apache-2.0](LICENSE). It depends on third-party
packages that carry their own licenses. This file records the ones with obligations a
downstream user or forker should know about; it is not an exhaustive SBOM. Generate the
full list from a checkout with:

```bash
cd app && npx license-checker-rspack --summary
```

## Weak-copyleft dependency: BlockNote (MPL-2.0)

The document editor is built on BlockNote:

| Package | Version range | License |
| --- | --- | --- |
| `@blocknote/core` | `^0.48.1` | MPL-2.0 |
| `@blocknote/mantine` | `^0.48.1` | MPL-2.0 |
| `@blocknote/react` | `^0.48.1` | MPL-2.0 |

The **Mozilla Public License 2.0 is file-level copyleft**, which has two practical
consequences:

1. **Using BlockNote as an unmodified dependency is fine.** Importing it from
   `app/client` and shipping it alongside Apache-2.0 code imposes no license change on
   OperationKit's own source. MPL-2.0 explicitly permits combination with code under
   other licenses ("Larger Work", MPL-2.0 §3.3).
2. **Modifying BlockNote's own source files triggers copyleft on those files.** If you
   fork this project and patch files that originated in a `@blocknote/*` package —
   vendoring them into your tree and editing them, rather than wrapping or subclassing —
   those specific files remain under MPL-2.0 and you must make their source available to
   anyone you distribute the result to (MPL-2.0 §3.1–3.2). The obligation is per-file: it
   does **not** spread to the rest of your codebase.

If you need to change editor behaviour, prefer BlockNote's extension points (custom
blocks, schema, and React overrides) over vendoring its source. That keeps the copyleft
boundary at the package edge.

Full license text: <https://www.mozilla.org/en-US/MPL/2.0/>
Upstream: <https://github.com/TypeCellOS/BlockNote>

## Permissive dependencies

The remaining runtime dependencies are permissively licensed (MIT, ISC, BSD-2/3-Clause,
or Apache-2.0) and require only that their copyright and license notices be preserved in
distributions. These include, among others: `react`, `react-dom`, `react-router-dom`,
`@mantine/*`, `@dnd-kit/*`, `@xterm/*`, `lucide-react`, `mermaid`, `express`,
`better-sqlite3`, `ws`, `node-pty`, `jsonwebtoken`, `bcrypt`, `cors`, `cookie-parser`,
and `multer`. Their notices ship inside the corresponding `node_modules` packages.

## Container images

`docker-compose.yml` pulls upstream images (`docker.litellm.ai/berriai/litellm-database`,
`postgres:16`) that are distributed under their own licenses. Nothing in this repository
redistributes them; Docker fetches them at run time.

## Reporting an omission

If a dependency with a notable obligation is missing here, please open an issue — see
[SUPPORT.md](SUPPORT.md).
