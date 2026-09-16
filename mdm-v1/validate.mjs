#!/usr/bin/env node
// Validates every schema compiles and every example passes.
//   npm i ajv ajv-formats && node validate.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = dirname(fileURLToPath(import.meta.url));
const read = p => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// Load the master, the wrappers, and every type schema.
const schemaFiles = [
  join(root, "record.schema.json"),
  join(root, "collection.schema.json"),
  join(root, "atlas-export.schema.json"),
  ...readdirSync(join(root, "types"))
    .filter(f => f.endsWith(".json"))
    .map(f => join(root, "types", f)),
];

for (const file of schemaFiles) ajv.addSchema(read(file));

// Each example names the schema it should satisfy in its own "$schema" field.
const exampleDir = join(root, "examples");
const examples = readdirSync(exampleDir).filter(f => f.endsWith(".json"));

let failures = 0;

for (const name of examples) {
  const instance = read(join(exampleDir, name));

  // "../types/person.schema.json" -> the $id that schema registered under.
  const rel = instance.$schema ?? "../record.schema.json";
  const id = "https://mdm.cameron-dietz.com/schema/" + rel.replace(/^\.\.\//, "");

  const validate = ajv.getSchema(id);
  if (!validate) {
    console.error(`FAIL ${name}: no schema registered for ${id}`);
    failures++;
    continue;
  }

  if (validate(instance)) {
    console.log(`  ok  ${name}  ->  ${basename(id)}`);
  } else {
    failures++;
    console.error(`FAIL ${name}  ->  ${basename(id)}`);
    for (const e of validate.errors) {
      console.error(`        ${e.instancePath || "/"} ${e.message}`);
    }
  }
}

// Every example must also satisfy the master envelope on its own,
// except the two that are wrappers rather than records.
const envelope = ajv.getSchema("https://mdm.cameron-dietz.com/schema/record.schema.json");
const wrappers = new Set(["collection.example.json", "atlas-export.example.json"]);

for (const name of examples) {
  if (wrappers.has(name)) continue;
  const instance = read(join(exampleDir, name));
  if (!envelope(instance)) {
    failures++;
    console.error(`FAIL ${name} against the master envelope`);
    for (const e of envelope.errors) {
      console.error(`        ${e.instancePath || "/"} ${e.message}`);
    }
  }
}

console.log(
  failures === 0
    ? `\nAll ${examples.length} examples valid against ${schemaFiles.length} schemas.`
    : `\n${failures} failure(s).`
);
process.exit(failures === 0 ? 0 : 1);
