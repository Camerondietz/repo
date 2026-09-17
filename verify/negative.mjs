// Confirms the schemas REJECT bad input. A schema that accepts everything
// would pass validate.mjs too, so this is the half that actually proves it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(process.cwd(), "verify", "mdm-v2");
const read = p => JSON.parse(readFileSync(p, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

for (const f of [
  join(root, "record.schema.json"),
  join(root, "collection.schema.json"),
  join(root, "atlas-export.schema.json"),
  ...readdirSync(join(root, "types")).map(f => join(root, "types", f)),
]) ajv.addSchema(read(f));

const S = n => ajv.getSchema("https://mdm.cameron-dietz.com/schema/" + n);
const base = read(join(root, "examples", "record.example.json"));
const person = read(join(root, "examples", "person.example.json"));
const clone = o => JSON.parse(JSON.stringify(o));

const mut = (src, fn) => { const c = clone(src); fn(c); return c; };

const cases = [
  ["unknown top-level field",        S("record.schema.json"), mut(base, r => { r.craeted_at = "2026-01-01T00:00:00Z"; })],
  ["missing required label",         S("record.schema.json"), mut(base, r => { delete r.label; })],
  ["id not a uuid",                  S("record.schema.json"), mut(base, r => { r.id = "nims-doctrine-2023"; })],
  ["slug not kebab-case",            S("record.schema.json"), mut(base, r => { r.slug = "Things To Do"; })],
  ["uppercase tag",                  S("record.schema.json"), mut(base, r => { r.tags = ["High-Priority"]; })],
  ["category value with a space",    S("record.schema.json"), mut(base, r => { r.category.primary = "emergency management"; })],
  ["category not an object",         S("record.schema.json"), mut(base, r => { r.category = "reference"; })],
  ["bad status enum",                S("record.schema.json"), mut(base, r => { r.status = "published"; })],
  ["bad visibility enum",            S("record.schema.json"), mut(base, r => { r.visibility = "secret"; })],
  ["checksum not 64 hex",            S("record.schema.json"), mut(base, r => { r.checksum_sha256 = "deadbeef"; })],
  ["relation missing id",            S("record.schema.json"), mut(base, r => { r.relations = [{ rel: "author" }]; })],
  ["relation id not a uuid",         S("record.schema.json"), mut(base, r => { r.relations[0].id = "fema"; })],
  ["identifiers value not an array", S("record.schema.json"), mut(base, r => { r.identifiers = { sku: "AIT-44821" }; })],

  ["FLIPPED coordinates [lat,lon]",  S("record.schema.json"), mut(base, r => { r.geo.point = [30.2672, -97.7431]; })],
  ["longitude out of range",         S("record.schema.json"), mut(base, r => { r.geo.point = [-197.7431, 30.2672]; })],
  ["position with one element",      S("record.schema.json"), mut(base, r => { r.geo.point = [-97.7431]; })],
  ["unknown key inside geo",         S("record.schema.json"), mut(base, r => { r.geo.lat = 30.2672; })],
  ["ring with under 4 positions",    S("record.schema.json"), mut(base, r => {
      r.geo.shapes = [{ role: "boundary", geometry: { type: "Polygon", coordinates: [[[-98, 30], [-97, 30], [-97, 31]]] } }];
    })],
  ["Point given Polygon coords",     S("record.schema.json"), mut(base, r => {
      r.geo.shapes = [{ role: "location", geometry: { type: "Point", coordinates: [[[-98, 30]]] } }];
    })],

  ["wrong type for person schema",   S("types/person.schema.json"), mut(person, r => { r.type = "organization"; })],
  ["person without pii flag",        S("types/person.schema.json"), mut(person, r => { delete r.pii; })],
  ["location without geo",           S("types/location.schema.json"), (() => {
      const l = read(join(root, "examples", "location.example.json")); delete l.geo; return l;
    })()],
  ["employment missing person edge", S("types/employment.schema.json"), (() => {
      const e = read(join(root, "examples", "employment.example.json"));
      e.relations = e.relations.filter(x => x.rel !== "person"); return e;
    })()],
  ["place without category.kind",    S("types/place.schema.json"), (() => {
      const p = read(join(root, "examples", "place.example.json")); delete p.category.kind; return p;
    })()],
  ["item price as a float",          S("types/item.schema.json"), (() => {
      const i = read(join(root, "examples", "item.example.json")); i.data.pricing.list_minor = 18.99; return i;
    })()],
];

let wrong = 0;
for (const [name, validate, instance] of cases) {
  if (validate(instance)) {
    wrong++;
    console.error(`NOT REJECTED  ${name}`);
  } else {
    console.log(`  rejected  ${name}`);
  }
}
console.log(wrong === 0
  ? `\nAll ${cases.length} bad inputs correctly rejected.`
  : `\n${wrong} case(s) wrongly accepted.`);
process.exit(wrong === 0 ? 0 : 1);
