#!/usr/bin/env node
// Regenerates all-fields.schema.json and all-fields.template.json from the
// master envelope plus every file in types/. Run it after changing any schema
// so the reference pair never drifts from the real definitions:
//
//   node build-all-fields.mjs
//
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = p => JSON.parse(readFileSync(p, "utf8"));

const record = read(join(here, "record.schema.json"));
const typeFiles = readdirSync(join(here, "types")).filter(f => f.endsWith(".json")).sort();
const types = typeFiles.map(f => ({ file: f, schema: read(join(here, "types", f)) }));

/* ---------------------------------------------------------------- helpers */
// Resolve a local "#/$defs/x" pointer inside whichever document owns it.
function ptr(doc, frag) {
  if (!frag) return doc;
  return frag.replace(/^\//, "").split("/").reduce((c, k) =>
    c == null ? undefined : c[decodeURIComponent(k).replace(/~1/g, "/").replace(/~0/g, "~")], doc);
}
function resolve(ref, ownDoc) {
  const hash = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : "";
  const head = ref.includes("#") ? ref.slice(0, ref.indexOf("#")) : ref;
  // "../record.schema.json#/$defs/x" reaches the master; "#/$defs/x" stays local.
  const doc = head === "" ? ownDoc : record;
  return ptr(doc, hash);
}
// Collapse $ref / allOf / oneOf-with-null into one effective schema.
function merge(sc, ownDoc, seen = new Set()) {
  const out = { properties: {}, required: [] };
  (function absorb(s) {
    if (!s || typeof s !== "object") return;
    for (const [k, v] of Object.entries(s.properties || {}))
      if (!(k in out.properties)) out.properties[k] = v;
    for (const k of s.required || []) if (!out.required.includes(k)) out.required.push(k);
    for (const kw of ["type", "enum", "format", "description", "items", "additionalProperties",
                      "const", "default", "examples", "minimum", "maximum", "pattern",
                      "prefixItems", "minItems"])
      if (s[kw] !== undefined && out[kw] === undefined) out[kw] = s[kw];
    if (s.$ref && !seen.has(s.$ref)) { seen.add(s.$ref); absorb(resolve(s.$ref, ownDoc)); }
    for (const a of s.allOf || []) absorb(a);
    const alt = s.oneOf || s.anyOf;
    if (alt) {
      const live = alt.filter(x => !(x && x.type === "null"));
      if (live.length === 1) absorb(live[0]);
    }
  })(sc);
  return out;
}

/* --------------------------------------------------- template construction */
const MAX_DEPTH = 6;
function template(sc, ownDoc, depth = 0, onPath = new Set()) {
  if (depth > MAX_DEPTH) return null;
  // GeometryCollection makes `geometry` self-referential. Expanding it endlessly
  // buries the useful fields, so a ref already on this branch stops here.
  if (sc && sc.$ref) {
    if (onPath.has(sc.$ref)) return null;
    onPath = new Set(onPath).add(sc.$ref);
  }
  const m = merge(sc, ownDoc);
  let t = m.type;
  if (Array.isArray(t)) t = t.filter(x => x !== "null")[0];
  if (m.const !== undefined) return m.const;
  if (!t) t = Object.keys(m.properties).length ? "object" : (m.items ? "array" : null);

  if (t === "object") {
    const keys = Object.keys(m.properties).filter(k => k !== "$schema");
    // An open map (additionalProperties with no fixed properties) has no fields
    // to enumerate; it stays an empty object and is listed under _openMaps.
    if (!keys.length) return {};
    const o = {};
    for (const k of keys) o[k] = template(m.properties[k], ownDoc, depth + 1, onPath);
    return o;
  }
  if (t === "array") {
    // A positional array (geo.point is [lon, lat]) shows one slot per position,
    // which says far more about the shape than an empty array does.
    if (m.prefixItems) return m.prefixItems.slice(0, m.minItems || m.prefixItems.length).map(() => null);
    if (!m.items) return [];
    const im = merge(m.items, ownDoc);
    const hasShape = Object.keys(im.properties).length > 0 || im.type === "object";
    // One fully-null element, so the item's own fields are visible too.
    if (hasShape) return [template(m.items, ownDoc, depth + 1, onPath)];
    // A scalar array with a minimum length (bbox is four numbers) shows its slots.
    return m.minItems ? new Array(m.minItems).fill(null) : [];
  }
  return null;
}

/* --------------------------------------------------- the reference schema */
const dataDefs = {};
const typeNames = [];
for (const { schema } of types) {
  const m = merge(schema, schema);
  const name = m.properties?.type?.const;
  if (!name) continue;
  typeNames.push(name);
  const dataSc = m.properties.data;
  const dm = dataSc ? merge(dataSc, schema) : { properties: {} };
  dataDefs["data_" + name] = {
    title: name + " payload",
    type: "object",
    additionalProperties: true,
    description: "Everything `data` may hold when type is \"" + name + "\".",
    properties: JSON.parse(JSON.stringify(dm.properties || {}))
  };
}

const allSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://mdm.cameron-dietz.com/schema/all-fields.schema.json",
  title: "All Fields Reference",
  description:
    "Every field the standard defines, in one file, for building forms, interfaces and tables against. " +
    "The envelope is reproduced from record.schema.json; each type's payload is in $defs as data_<type>. " +
    "This is a real schema and validates real records — `data` must match the payload for the declared " +
    "`type`. Regenerate with build-all-fields.mjs after changing any schema.",
  type: "object",
  required: ["id", "type", "label"],
  additionalProperties: false,
  properties: JSON.parse(JSON.stringify(record.properties)),
  $defs: { ...JSON.parse(JSON.stringify(record.$defs)), ...dataDefs },
  allOf: typeNames.map(n => {
    const own = types.find(t => merge(t.schema, t.schema).properties?.type?.const === n);
    // Carry each type's own extra required fields (person needs pii, location
    // needs geo, employment needs relations) so the reference does not quietly
    // accept records the real type schema would reject.
    const extra = (own ? merge(own.schema, own.schema).required : []).filter(k => k !== "type");
    const then = { properties: { data: { $ref: "#/$defs/data_" + n } } };
    if (extra.length) then.required = extra;
    return { if: { properties: { type: { const: n } }, required: ["type"] }, then };
  })
};
// Deliberately NOT an enum. This file is a superset reference, so it must accept
// every record record.schema.json would; pinning the list here would reject a
// valid record whose type has no schema yet. Known types get their payload
// checked by the allOf below; the rest pass with `data` as a plain object.
allSchema.properties.type = {
  ...allSchema.properties.type,
  examples: typeNames,
  description: (allSchema.properties.type.description || "") +
    " Types with a payload definition in $defs: " + typeNames.join(", ") + "."
};
allSchema.properties.data = {
  description: "Type-specific payload. The allOf below selects the matching data_<type> definition.",
  type: "object"
};

/* ------------------------------------------------------- the null template */
const envelope = {};
for (const [k, v] of Object.entries(record.properties)) {
  if (k === "$schema" || k === "data") continue;
  envelope[k] = template(v, record, 1);
}

const openMaps = [];
(function findOpen(props, prefix, doc) {
  for (const [k, v] of Object.entries(props || {})) {
    // `data` is open only on the envelope; every type fills it in below.
    if (prefix === "" && k === "data") continue;
    const m = merge(v, doc);
    const keys = Object.keys(m.properties);
    if (m.type === "object" && !keys.length) openMaps.push(prefix + k);
    else if (keys.length && prefix.split(".").length < 3) findOpen(m.properties, prefix + k + ".", doc);
  }
})(record.properties, "", record);

const out = {
  $comment:
    "FIELD REFERENCE, NOT A RECORD. Every field the standard defines, set to null, one complete " +
    "skeleton per type. Copy the block for the type you are building and fill it in; delete the keys " +
    "you do not use rather than sending nulls, because the envelope drops absent fields but validates " +
    "present ones. Generated by build-all-fields.mjs — do not hand-edit.",
  _generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  _about: {
    envelope: "Shared by every type; see record.schema.json for the rules behind each field.",
    types: Object.fromEntries(typeNames.map(n => [n, "data holds the " + n + " payload"])),
    notAnInstance:
      "These skeletons will not validate as-is: required fields are null and `type` is the only value " +
      "filled in, because the schema fixes it per type.",
    arrays:
      "An array of objects shows one fully-null element so the item's own fields are visible. " +
      "An empty array means the items are plain scalars.",
    openMaps:
      "These are open key/value maps with no fixed field list, so they appear as {}: " + openMaps.join(", ") +
      ". Keys are yours to choose; see record.schema.json for the key and value patterns each one allows.",
    missingTypes:
      "frequency, sop and tool are named in the design but have no schema yet, so they are absent here. " +
      "Add types/<name>.schema.json and re-run build-all-fields.mjs to include them."
  },
  envelope,
  types: {}
};
for (const { schema } of types) {
  const m = merge(schema, schema);
  const name = m.properties?.type?.const;
  if (!name) continue;
  const rec = JSON.parse(JSON.stringify(envelope));
  rec.type = name;
  rec.data = m.properties.data ? template(m.properties.data, schema, 1) : {};
  out.types[name] = rec;
}

writeFileSync(join(here, "all-fields.schema.json"), JSON.stringify(allSchema, null, 2) + "\n");
writeFileSync(join(here, "all-fields.template.json"), JSON.stringify(out, null, 2) + "\n");

const envCount = Object.keys(envelope).length;
console.log("types:            " + typeNames.join(", "));
console.log("envelope fields:  " + envCount);
for (const n of typeNames)
  console.log("  data_" + n.padEnd(18) + Object.keys(dataDefs["data_" + n].properties).length + " fields");
console.log("open maps:        " + openMaps.join(", "));
console.log("wrote all-fields.schema.json and all-fields.template.json");
