# Master Schema v2.1

The single schema every record in the ecosystem uses. Built on the v1 envelope design in `repo/mdm-v1/` (its design notes are kept in `README.v1-design-notes.md`: principles, classification model, conventions, migration table). Everything there still applies; this file lists what v2 adds.

```text
schema/
  record.schema.json          the envelope (id, type, label required; everything else optional)
  common.schema.json          shared value shapes: money, money_range, quantity, contact_point, translations
  changeset.schema.json       how apps write back (whole-record upserts + optional base checksums)
  collection.schema.json      wrapper for any list: { "meta": {...}, "items": [...] }
  atlas-export.schema.json    GeoJSON interchange view for map tools
  types/                      one schema per type: allOf [record] + type const + data definition
  examples/                   v1 examples (still valid)
  validate.mjs, negative.mjs  ajv validators (npm i ajv ajv-formats && node validate.mjs)
```

Python validation (used by the toolchain): `python tools/mdm.py validate <file or folder>`.

## v2.1 (schema review, 2026-10-24) - additive, nothing existing breaks

| Change | Why |
|---|---|
| `common.schema.json` with `money`, `money_range`, `quantity`, `contact_point`, `translations` | One shape everywhere. Money gains an exact decimal `amount` ("0.0034") next to `amount_minor`, because component prices go below a cent. All type schemas now reference it. |
| `data.contact_points[]` on person, organization, location, employment | Any number and kind of phones, emails, social handles. Old single fields still work. |
| Envelope `ext` (namespaced by app id) | App-specific fields travel with the record without colliding or being dropped. |
| Envelope `lang` + `translations` | Multilingual labels and summaries without new types. |
| `product.data.specs` values use the shared `quantity` | Measured specs look the same in Product manager, RFQ and Aventrek. |
| New types `training_record`, `observation` | Needed by the planned Training and Health manager apps (and inspections, KPIs). |
| `changeset.schema.json` | App write-back is now a validated contract, with optimistic concurrency (`base`) and draft status for AI. |
| Collection `meta.schema_version` | Every file says which schema version wrote it. |
| `registry/vocabularies.json` | 52 relation names with inverses, identifier schemes, category dimensions, realms (personal, aventrek, better_society, public). `validate` warns on unlisted relation names. |

Compatibility rules: readers ignore unknown fields and writers send them back (must-ignore, must-carry); additive changes bump the minor; breaking changes get a new `/schema/v3/` path and a migration. See `docs/standards/INTEGRATION-RULES.md`.

## Changes from v1

| Change | Detail |
|---|---|
| `$id` base | `https://mdm.cameron-dietz.com/schema/v2/` |
| `classification` (new envelope field) | `{c 0-7, i 0-4, a 0-4, control 0-4, caveats[]}` from the governance policy. `visibility` remains as the coarse label. |
| `relations[].props` | edge properties (BOM qty/uom/find_no, ownership_pct, order) |
| New types | `product`, `part_number`, `asset`, `relationship`, `event`, `resource`, `procedure`, `work_item` (goal/strategy/objective/task/milestone), `taxonomy_scheme`, `taxonomy_term`, `mapping`, `content_item`, `channel`, `publication`, `campaign`, `job_listing`, `job_application`, `rfq` |
| Deprecated | `item` → `product` (definition) / `asset` (owned unit); `content_category` → `taxonomy_term` with `data.seo` |
| Clarified | `organization` covers company/subsidiary/department/branch/team/unit via `category.kind`; `person` family links |

## Type families

| Family | Types |
|---|---|
| Parties | organization, person, employment, relationship |
| Products | product, part_number, asset |
| Places | location, place (+ `geo` on every record) |
| Time and work | event, goal, strategy, objective, task, milestone |
| Knowledge | document, resource, procedure |
| Taxonomy | taxonomy_scheme, taxonomy_term, mapping |
| Marketing | content_item, channel, publication, campaign |
| Career | job_listing, job_application |
| Commerce | rfq |
| Learning and logs | training_record, observation |

Adding a type: write `types/<type>.schema.json` (copy a small one such as `resource`), add it to `registry/types.json`, add an example, run both validators.
