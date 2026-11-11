/*
 * mdm-client.js - one loader every app uses to read master data, wherever it lives.
 *
 *   <script src="https://repo.cameron-dietz.com/lib/mdm-client.js"></script>
 *   const mdm = MDMClient.create({ repoBase: "https://repo.cameron-dietz.com/data" });
 *   const { items, source } = await mdm.load("organization");
 *
 * Source chain (first one that answers wins; the page shows which):
 *   "mdm-api"              future Postgres/Django API:  {mdmApi}?type=<type>  -> collection
 *   "local"                window.MDM_DATA / window.MDM_RECORDS already on the page (local file use)
 *   "repo-enc:<profile>"   {repoBase}/enc/<profile-dir>/<type>.enc.json  (asks for the password once per tab)
 *   "repo-public"          {repoBase}/public/<type>.json
 *
 * Encrypted files use the c2-enc v2 envelope written by tools/mdm.py and command/tools/c2-encrypt.py:
 * AES-256-GCM data key wrapped per password with PBKDF2-HMAC-SHA256. Decryption happens in the browser
 * with WebCrypto; the unwrapped data key is kept in sessionStorage (this tab only) until lock().
 *
 * No dependencies. Works as a classic script (window.MDMClient) or an ES module import.
 */
(function (root) {
  "use strict";

  const AAD_DATA = new TextEncoder().encode("c2-enc/2/data");
  const AAD_KEY = new TextEncoder().encode("c2-enc/2/key");
  const PROFILE_DIRS = { "repo-internal": "internal", "repo-management": "management" };

  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64e = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
  const vals = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const subtle = () => (root.crypto || globalThis.crypto).subtle;

  function recordsOf(doc) {
    if (Array.isArray(doc)) return doc;
    if (doc && typeof doc === "object") {
      for (const k of ["items", "records", "upserts"]) if (Array.isArray(doc[k])) return doc[k];
      if (doc.id && doc.type) return [doc];
    }
    return [];
  }

  // ---------------------------------------------------------------- crypto
  async function deriveKek(password, env) {
    const base = await subtle().importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return subtle().deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: b64d(env.salt), iterations: env.iterations },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }

  async function unwrapDek(env, password) {
    const kek = await deriveKek(password, env);
    for (const slot of env.keys || []) {
      try {
        const raw = await subtle().decrypt({ name: "AES-GCM", iv: b64d(slot.nonce), additionalData: AAD_KEY }, kek, b64d(slot.wrapped));
        return { raw: new Uint8Array(raw), slot: slot.name };
      } catch (_) { /* try the next slot */ }
    }
    return null;
  }

  async function openWithDek(env, rawDek) {
    const key = await subtle().importKey("raw", rawDek, "AES-GCM", false, ["decrypt"]);
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: b64d(env.nonce), additionalData: AAD_DATA }, key, b64d(env.ciphertext));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /** Decrypt an envelope with a password. Returns the payload (collection or array). */
  async function decrypt(env, password) {
    const dek = await unwrapDek(env, password);
    if (!dek) throw new Error("wrong password");
    return openWithDek(env, dek.raw);
  }

  // ---------------------------------------------------------------- client
  function create(opts = {}) {
    const cfg = Object.assign({
      repoBase: "https://repo.cameron-dietz.com/data",
      mdmApi: null,                         // e.g. "https://mdm.cameron-dietz.com/api/records"
      chain: ["mdm-api", "local", "repo-enc:repo-internal", "repo-public"],
      headers: {},
      askPassword: (label) => Promise.resolve(root.prompt ? root.prompt(`Password for ${label} data`) : null),
      storage: root.sessionStorage || null, // where unlocked data keys live for this tab
      fetch: (root.fetch || globalThis.fetch).bind(root),
    }, opts);
    const cache = new Map();
    const keyName = (env) => "mdm-dek:" + env.salt;

    async function getJson(url) {
      const r = await cfg.fetch(url, { headers: Object.assign({ Accept: "application/json" }, cfg.headers), cache: "no-cache" });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    }

    async function openEnvelope(env, label) {
      // Each file has its own salt and data key: remember the unwrapped key per file and the password
      // per key slot label (tab-scoped), so one prompt opens every file of that audience.
      const stored = cfg.storage && cfg.storage.getItem(keyName(env));
      if (stored) {
        try { return await openWithDek(env, b64d(stored)); } catch (_) { cfg.storage.removeItem(keyName(env)); }
      }
      const remembered = cfg.storage && cfg.storage.getItem("mdm-pw:" + label);
      for (let attempt = 0; attempt < 3; attempt++) {
        const pw = attempt === 0 && remembered ? remembered : await cfg.askPassword(label);
        if (!pw) throw new Error("locked");
        const dek = await unwrapDek(env, pw);
        if (dek) {
          if (cfg.storage) {
            cfg.storage.setItem(keyName(env), b64e(dek.raw));
            cfg.storage.setItem("mdm-pw:" + label, pw); // tab-scoped; cleared by lock()
          }
          return openWithDek(env, dek.raw);
        }
      }
      throw new Error("wrong password");
    }

    async function trySource(src, type) {
      if (src === "mdm-api") {
        if (!cfg.mdmApi) return null;
        return recordsOf(await getJson(`${cfg.mdmApi}?type=${encodeURIComponent(type)}`));
      }
      if (src === "local") {
        const local = root.MDM_RECORDS || root.MDM_DATA;
        if (!local) return null;
        return recordsOf(local).filter((r) => r.type === type);
      }
      if (src.startsWith("repo-enc:")) {
        const profile = src.slice(9);
        const dir = PROFILE_DIRS[profile] || profile;
        const env = await getJson(`${cfg.repoBase}/enc/${dir}/${type}.enc.json`);
        return recordsOf(await openEnvelope(env, dir));
      }
      if (src === "repo-public") {
        return recordsOf(await getJson(`${cfg.repoBase}/public/${type}.json`));
      }
      throw new Error("unknown source " + src);
    }

    /** Load all live records of a type. Returns { items, source, errors }. */
    async function load(type, { chain = cfg.chain, includeDeleted = false } = {}) {
      const ck = type + "|" + chain.join(",");
      if (cache.has(ck)) return cache.get(ck);
      const errors = [];
      for (const src of chain) {
        try {
          const items = await trySource(src, type);
          if (items) {
            const res = { items: includeDeleted ? items : items.filter((r) => !r.deleted_at), source: src, errors };
            cache.set(ck, res);
            return res;
          }
        } catch (e) { errors.push(`${src}: ${e.message}`); }
      }
      return { items: [], source: null, errors };
    }

    /** Load several types and index them together. */
    async function loadAll(types, o) {
      const parts = await Promise.all(types.map((t) => load(t, o)));
      const items = parts.flatMap((p) => p.items);
      return { items, index: indexRecords(items), sources: Object.fromEntries(types.map((t, i) => [t, parts[i].source])) };
    }

    async function catalog() { return getJson(`${cfg.repoBase}/catalog.json`); }

    function lock() {
      if (!cfg.storage) return;
      for (let i = cfg.storage.length - 1; i >= 0; i--) {
        const k = cfg.storage.key(i);
        if (k && (k.startsWith("mdm-dek:") || k.startsWith("mdm-pw:"))) cfg.storage.removeItem(k);
      }
      cache.clear();
    }

    return { load, loadAll, catalog, lock, config: cfg };
  }

  // ---------------------------------------------------------------- helpers every app needs
  function indexRecords(items) {
    const rels = (r) => (Array.isArray(r.relations) ? r.relations : []);
    const byId = new Map(items.map((r) => [r.id, r]));
    const byIdentifier = new Map();
    for (const r of items) for (const [scheme, vs] of Object.entries(r.identifiers || {})) for (const v of vs) byIdentifier.set(`${scheme}:${v}`, r);
    return {
      byId,
      get: (id) => byId.get(id),
      find: (scheme, value) => byIdentifier.get(`${scheme}:${value}`),
      /** records this one points at with rel */
      out: (rec, rel) => rels(rec).filter((e) => !rel || e.rel === rel).map((e) => byId.get(e.id)).filter(Boolean),
      /** records pointing at this one with rel (reverse edges, e.g. employments of a person) */
      in: (rec, rel) => items.filter((r) => rels(r).some((e) => e.id === rec.id && (!rel || e.rel === rel))),
      children: (rec) => items.filter((r) => r.parent_id === rec.id),
      ancestors: (rec) => { const out = []; let p = byId.get(rec.parent_id); while (p && out.length < 64) { out.push(p); p = byId.get(p.parent_id); } return out; },
    };
  }

  /** category prefix match: inCategory(rec, "subject", "engineering") matches "engineering.mechanical". */
  function inCategory(rec, dim, prefix) {
    return vals((rec.category || {})[dim]).some((v) => v === prefix || v.startsWith(prefix + "."));
  }

  /** valid on a date (ISO string), using valid_from / valid_to. */
  function validOn(rec, isoDate) {
    return (!rec.valid_from || rec.valid_from <= isoDate) && (!rec.valid_to || rec.valid_to > isoDate);
  }

  /** Build a changes document the toolchain applies with: python tools/mdm.py apply-changeset FILE
   *  opts: { app, originals (records as loaded, for base checksums), status ("draft" | "submitted") } */
  function changeset(upserts, source, opts = {}) {
    const base = {};
    for (const r of opts.originals || []) if (r && r.id && r.checksum_sha256) base[r.id] = r.checksum_sha256;
    return Object.assign({ format: "mdm-changeset", version: 1, id: root.crypto && crypto.randomUUID ? crypto.randomUUID() : undefined,
      app: opts.app, schema_version: "2.1", exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      source: source || (root.location && location.href), status: opts.status || "submitted", base, upserts });
  }

  const api = { create, decrypt, recordsOf, indexRecords, inCategory, validOn, changeset, vals };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MDMClient = api;
})(typeof window !== "undefined" ? window : globalThis);
