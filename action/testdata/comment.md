<!-- gantry:pr-comment -->
## Gantry: what this pull request changes

**Risk: low (0/100)** · 1 file · 2 symbol changes (2 added) · `a521528...32416af`

> **Structural radius only.** This repository has no committed `.gantry/recipe.json`, so the radius follows imports, calls and renders, and routes, endpoints and tables are not linked. A recipe lets this comment show what developers see locally.

### Duplicates

1 group with code this pull request adds or changes · 3 functions · 16 duplicate lines

1. **exact**, 3 functions, 24 lines: keep `packages/ui/src/slug-copy.ts:2 slugify` **added here**
   - `apps/web/src/lib/slug.ts:1 slugify` (exact 1.00)
   - `packages/utils/src/slug.ts:2 slugify` (exact 1.00)

### Changed symbols (2)

| Change | Symbol | Where | Direct | Potential |
| --- | --- | --- | ---: | ---: |
| added | `SLUG_VERSION` | `packages/ui/src/slug-copy.ts:11` | 0 | 0 |
| added | `slugify` | `packages/ui/src/slug-copy.ts:2` | 1 | 0 |

### Consumers

<details>
<summary>`slugify`: 1 direct, 0 potential</summary>

Directly affected (1):

- `SLUG_VERSION (const, packages/ui/src/slug-copy.ts:11) calls`

</details>

<sub>Gantry 0.1.0 · duplicate tiers: exact and near · no model calls · updated for 32416af</sub>
