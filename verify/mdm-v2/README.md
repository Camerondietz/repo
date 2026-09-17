# MDM v2 — unified record schema

One envelope shape for every entity across every app. Three fields are required — `id`, `type`, `label` — and everything else is optional, so a record can be three lines or forty.

## Layout

```
mdm-v2/
  record.schema.json          master envelope — everything else builds on this
  collection.schema.json      wrapper for any list of records
  atlas-export.schema.json    GeoJSON interchange view for map tools
  types/
    person.schema.json
    organization.schema.json
    location.schema.json
    place.schema.json         gazetteer (new — see below)
    document.schema.json
    item.schema.json
    employment.schema.json
    content_category.schema.json
  examples/
    record.example.json       exercises every envelope field
    <type>.example.json       one complete example per type
    collection.example.json
    atlas-export.example.json
  validate.mjs
```

Each type schema is `allOf: [record.schema.json]` plus a `const` on `type` and a narrowed `data`. Validating against a type schema therefore validates the envelope too. Validating against `record.schema.json` alone is also valid — useful for types that don't have a schema yet.

## Principles

**Resolve hierarchies at write time; keep queries flat.** Geography and classification are both tree problems. Resolving them at read time means every app needs the tree, a geometry engine, and matching logic. `geo.place_closure` is computed once on write, so "everything in Travis County" is one array-contains lookup.

**The envelope is strict; the payload is not.** `additionalProperties: false` at the top level means a typo like `craeted_at` fails loudly instead of silently vanishing. `metadata` is the pressure valve — unmodeled fields go there, then get promoted to real fields once they prove out.

**Payload is nested, not flattened.** `data` exists so payload field names can never collide with envelope names. This is not hypothetical: `version` already means three different things across the systems this replaces. Per-type API endpoints can still flatten on output — flatten at the edge, nest in storage.

**Type schemas describe shape, not completeness.** Almost nothing is required beyond the envelope's three fields, because real records arrive sparse. Use `status: "draft"` to mark one as incomplete rather than failing validation.

## Classification

`category` is an object. Keys are **dimensions** — independent axes that don't collide. Depth *within* a dimension uses dots, so hierarchy is a prefix match rather than a closure table.

```json
"category": {
  "primary": "fema",
  "kind": "doctrine",
  "domain": ["emergency_management.planning", "emergency_management.hazmat"],
  "audience": "responder"
}
```

A query for `emergency_management` matches `emergency_management.hazmat` with `LIKE 'emergency_management%'`. Values may be a string or an array; normalize with:

```js
const vals = v => v == null ? [] : Array.isArray(v) ? v : [v];
```

The map is open — new dimensions need no schema change. Commonly useful ones: `primary`, `kind`, `domain`, `form`, `audience`, `jurisdiction`, `discipline`, `phase`, `hazard`.

`tags` is the uncontrolled counterpart: freeform keywords for full-text search. Anything you intend to facet, filter, or report on belongs in `category` instead.

## Conventions

| | |
|---|---|
| Field naming | `snake_case` everywhere. Person and address fields follow schema.org, snake-cased. |
| `id` | UUID. Never reused, never changes. |
| `slug` | Human-readable handle for URLs — where kebab ids like `nims-doctrine-2023` live. |
| `uri` | `https://mdm.cameron-dietz.com/id/{type}/{id}` |
| Coordinates | `[longitude, latitude]`, WGS84. **Longitude first** — GeoJSON order, the reverse of how humans write it. Assert `abs(lat) <= 90` on ingest to catch flips. |
| Timestamps | RFC 3339 with explicit offset; store UTC. |
| Money | Integer **minor** units (cents) plus an ISO 4217 currency. Never floats. |
| `status` vs `state` | `status` is record lifecycle (draft → active → superseded). `state` is domain condition (`in_service`, `vacant`). A record has both. |
| `valid_from`/`valid_to` vs `created_at`/`updated_at` | When the fact was true in the world vs when the system learned it. Keeping them separate is what lets you ask what was in force on a given date. |
| `url` vs `source_url` | Where the thing lives vs where you got the record. |

## Validating

```bash
npm i ajv ajv-formats && node validate.mjs && node negative.mjs
```

`validate.mjs` compiles every schema and validates each example against both its type schema and the master envelope. `negative.mjs` is the other half: 25 deliberately broken records that must all be rejected — a schema that accepts everything would pass the first script too.

Both pass as shipped. Two checks worth knowing about:

- **Coordinate flips fail validation.** `position` bounds each slot separately, so `[30.2672, -97.7431]` is rejected because −97.74 is not a valid latitude. Most Austin-area flips die at the door.
- **Ring closure is *not* enforced.** JSON Schema cannot express "first element equals last", so only the 4-position minimum is checked. Assert closure and winding in ingest code — CAP/IPAWS polygons arrive as `lat,lon` pairs and routinely need both a flip and an explicit close.

## Migrating the previous files

| Was | Now |
|---|---|
| `mdm.person` / `.organizations` / `.locations` / `.items` / `.employments` | `types/*.schema.json`; `id`, `uri`, `label`, `metadata`, `source_*`, timestamps keep their names |
| `mdm.locations.latitude` / `.longitude` | `geo.point` as `[lon, lat]` — both are currently `null`, so this costs nothing today |
| `mdm.locations` address fields | `geo.address`, **names unchanged** |
| `mdm.organizations.domains` | `identifiers.domain[]` |
| `mdm.*.org_type` / `.kind` / `.doc_type` / `.categories` | `category` |
| `mdm.documents.embedding` / `.embedding_model` | sidecar keyed `(record_id, model, version)` — out of the record |
| `documents.schema.json` catalog wrapper | `collection.schema.json` |
| `documents.schema.json` `id` (kebab) | `slug`; mint a UUID for `id` |
| `documents.schema.json` `path`/`file_type`/`size_bytes`/`checksum_sha256` | `attachments[]` |
| `review-page.places.json` camelCase | snake_case; `parentIds[0]` → `parent_id`, remainder → `relations` |
| `review-page` `status: "published"` | `status: "active"` |
| `review-page` `media.featuredImage` | `attachments[role: featured_image]` |
| `location.list.txt` (ATLAS) | `location` records; GeoJSON stays as the **export** view, not storage |
| ATLAS `_atlasType` | dropped — it only restated `geometry.type` |

### `place` is new

The one type here that wasn't in your originals. `geo.places` and `geo.place_closure` on every other record point at these, and without them areas get stored as bare points — which is exactly what the current ATLAS file does with Texas. Build the gazetteer first; everything geographic depends on it.

Seed it from Census TIGER/Line (states, counties, places, ZCTAs — FIPS plus geometry), NWS zone shapefiles (UGC plus geometry), and the FEMA/FCC SAME list. Then build one index over every `identifiers` entry: `(scheme, value) → id`. That index is what lets an IPAWS SAME code, an NWS UGC zone, and a geocoder string all resolve to the same record.

## Deliberately not included

Each of these is additive later and none require reshaping what's here:

- **Term/scheme vocabulary records** — `category` covers classification without the governance overhead.
- **Sensitivity ranks, TLP, caveats, field-level redaction** — `visibility` + `pii` + `owner` cover the current need.
- **Hash-chain revision history** — `version`, `status`, `superseded_by`, `checksum_sha256`, and `created_by`/`updated_by` cover it until something forces more.
- **Per-group ACLs** — belong in a grants table keyed by record id, not on the record; otherwise every permission change rewrites the record and churns `updated_at`.

One caveat worth repeating: `visibility` is a **label**, not enforcement. The serving layer has to check it on every read.
