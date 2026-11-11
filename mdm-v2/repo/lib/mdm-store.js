/*
 * mdm-store.js - read and write the warehouse folder straight from the browser.
 *
 *   <script src="../repo/lib/mdm-store.js"></script>        (before mdm-app.js)
 *
 * The warehouse is plain JSON, one file per type, in two stores:
 *   data/warehouse/<type>.json             shared data
 *   data/warehouse/internal/<type>.json    internal-only data (C2: org units, personnel, plan elements)
 * registry/types.json `store` says where a type lives by default. A record stays in the file it came from.
 *
 * Folder access uses the browser's File System Access API (Chrome or Edge). You pick the MASTER folder
 * (or data/warehouse) once; the browser remembers it and may ask for one click per visit. Every save
 * rewrites that type's file and keeps the version it replaced as _<type>.prev.json next to it.
 * Without folder access the apps still work with Import / Export .json.
 *
 * Also here: a small JSON Schema checker (the subset the master schema uses) for the editor and raw paste.
 * No dependencies.
 */
(function (root) {
  "use strict";

  const DB = "mdm-store", OS = "handles", KEY = "warehouse";
  let dir = null;            // FileSystemDirectoryHandle of data/warehouse
  let label = "";            // what to show: "MASTER/data/warehouse"
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(api.status()); } catch (_) { /* listener error */ } });

  // ------------------------------------------------------------------ IndexedDB (remembers the folder)
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(OS);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction(OS, mode);
        const r = fn(tx.objectStore(OS));
        tx.oncomplete = () => resolve(r && "result" in r ? r.result : null);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const remember = (h) => (root.MDM_STORE_NO_REMEMBER ? Promise.resolve(null) : idb("readwrite", (s) => s.put(h, KEY)).catch(() => null));
  const recall = () => idb("readonly", (s) => s.get(KEY)).catch(() => null);
  const forget = () => idb("readwrite", (s) => s.delete(KEY)).catch(() => null);

  // ------------------------------------------------------------------ folder handling
  async function child(h, name, kind) {
    try { return kind === "dir" ? await h.getDirectoryHandle(name) : await h.getFileHandle(name); } catch (_) { return null; }
  }
  /** Accept the MASTER folder, its data folder, or data/warehouse itself. */
  async function findWarehouse(h) {
    const data = await child(h, "data", "dir");
    if (data) { const w = await child(data, "warehouse", "dir"); if (w) return { w, label: `${h.name}/data/warehouse` }; }
    if (h.name === "data") { const w = await child(h, "warehouse", "dir"); if (w) return { w, label: "data/warehouse" }; }
    if (h.name === "warehouse" || (await child(h, "_manifest.json", "file"))) return { w: h, label: h.name };
    return null;
  }
  async function permitted(h, ask) {
    if (!h.queryPermission) return true; // origin private file system and older builds
    const opts = { mode: "readwrite" };
    if ((await h.queryPermission(opts)) === "granted") return true;
    return ask ? (await h.requestPermission(opts)) === "granted" : false;
  }

  const api = {
    supported: () => typeof root.showDirectoryPicker === "function",
    connected: () => !!dir,
    status: () => ({ connected: !!dir, label, supported: api.supported() }),
    onChange: (f) => { listeners.add(f); return () => listeners.delete(f); },

    /** Ask for the folder (needs a click). Returns true when connected. */
    async connect() {
      if (!api.supported()) throw new Error("This browser cannot open folders. Use Chrome or Edge, or Import / Export .json.");
      const picked = await root.showDirectoryPicker({ id: "mdm-master", mode: "readwrite" });
      const found = await findWarehouse(picked);
      if (!found) throw new Error(`"${picked.name}" is not the MASTER folder or data/warehouse.`);
      if (!(await permitted(found.w, true))) throw new Error("Write access was not given.");
      dir = found.w; label = found.label;
      await remember({ handle: found.w, label });
      emit();
      return true;
    },
    /** On page load: reuse the remembered folder. "granted" | "prompt" (needs reconnect click) | "none". */
    async restore() {
      // If the last restore never finished (the tab died while reading the saved folder), start clean.
      const GUARD = "mdm-store:restoring";
      // A guard older than 15 s means a restore died; a fresh one is another app on this page restoring now.
      try { const g = Number(localStorage.getItem(GUARD)); if (g && Date.now() - g > 15000) { localStorage.removeItem(GUARD); await forget(); return "none"; } localStorage.setItem(GUARD, String(Date.now())); } catch (_) { /* storage blocked */ }
      let saved = null;
      try { saved = await recall(); } finally { try { localStorage.removeItem(GUARD); } catch (_) { /* storage blocked */ } }
      if (!saved || !saved.handle) return "none";
      label = saved.label || saved.handle.name;
      if (await permitted(saved.handle, false)) { dir = saved.handle; emit(); return "granted"; }
      api._pending = saved.handle;
      return "prompt";
    },
    /** Reconnect the remembered folder after a restore() that said "prompt" (needs a click). */
    async reconnect() {
      const h = api._pending || ((await recall()) || {}).handle;
      if (!h) return api.connect();
      if (!(await permitted(h, true))) throw new Error("Access was not given.");
      dir = h; api._pending = null; emit();
      return true;
    },
    /** The connected folder, so a page can hand it to the apps it shows (same origin only). */
    handle: () => (dir ? { dir, label } : null),
    async disconnect() { dir = null; label = ""; api._pending = null; await forget(); emit(); },
    /** Use a directory handle you already have (tests, or a page that picked it itself). */
    async use(h, lbl) { const found = (await findWarehouse(h)) || { w: h, label: h.name }; dir = found.w; label = lbl || found.label; emit(); },

    /** Every type file in both stores: [{type, store, name}] */
    async list() {
      if (!dir) return [];
      const out = [];
      const scan = async (h, store) => {
        for await (const [name, e] of h.entries()) if (e.kind === "file" && /\.json$/.test(name) && !name.startsWith("_")) out.push({ type: name.replace(/\.json$/, ""), store, name });
      };
      await scan(dir, "shared");
      const internal = await child(dir, "internal", "dir");
      if (internal) await scan(internal, "internal");
      return out.sort((a, b) => a.type.localeCompare(b.type) || a.store.localeCompare(b.store));
    },
    /** Read one type: [{store, doc}] for each store that has the file. */
    async read(type) {
      if (!dir) return [];
      const out = [];
      for (const store of ["shared", "internal"]) {
        const folder = store === "internal" ? await child(dir, "internal", "dir") : dir;
        const fh = folder && (await child(folder, `${type}.json`, "file"));
        if (!fh) continue;
        const text = await (await fh.getFile()).text();
        let doc;
        try { doc = JSON.parse(text); } catch (e) { throw new Error(`${store === "internal" ? "internal/" : ""}${type}.json is not valid JSON: ${e.message}`); }
        out.push({ store, doc });
      }
      return out;
    },
    /** Write one type file. Keeps what it replaced as _<type>.prev.json. */
    async write(type, store, doc) {
      if (!dir) throw new Error("No folder connected");
      let folder = dir;
      if (store === "internal") folder = await dir.getDirectoryHandle("internal", { create: true });
      const name = `${type}.json`;
      const old = await child(folder, name, "file");
      if (old) {
        const prev = await folder.getFileHandle(`_${type}.prev.json`, { create: true });
        const w = await prev.createWritable(); await w.write(await old.getFile()); await w.close();
      }
      const fh = await folder.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(doc, null, 2) + "\n");
      await w.close();
    },
    /** A warehouse collection file, the same shape tools/mdm.py writes. */
    collection(type, items, store, meta) {
      return {
        $schema: (store === "internal" ? "../" : "") + "../../schema/collection.schema.json",
        meta: Object.assign({}, meta || {}, { type, count: items.length, generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), tool: "mdm-app", schema_version: (root.MDM_REGISTRY || {}).schema_version || "2.2" }),
        items: [...items].sort((a, b) => String(a.id).localeCompare(String(b.id))),
      };
    },
    /** Default store of a type from registry/types.json. */
    storeOf(type) { return (((root.MDM_REGISTRY || {}).types || {})[type] || {}).store || "shared"; },
  };

  // ------------------------------------------------------------------ JSON Schema check (subset)
  // Covers what the master schema uses: $ref (relative files + fragments), allOf, type, const, enum,
  // required, properties, additionalProperties:false, items, pattern, maxLength, minimum/maximum, format (date, uuid, email).
  const schemas = () => ((root.MDM_REGISTRY || {}).schemas) || {};
  function resolve(ref, basePath) {
    const [file, frag] = ref.split("#");
    let path = basePath;
    if (file) {
      const parts = ((basePath.includes("/") ? basePath.replace(/[^/]+$/, "") : "") + file).split("/"); const norm = [];
      for (const p of parts) { if (p === "..") norm.pop(); else if (p && p !== ".") norm.push(p); }
      path = norm.join("/");
    }
    let node = schemas()[path];
    for (const k of (frag || "").split("/").filter(Boolean)) node = node && node[k];
    return { node, path };
  }
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  const FORMATS = {
    date: /^\d{4}-\d{2}-\d{2}$/, "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, email: /^[^@\s]+@[^@\s]+$/,
  };
  function check(v, s, path, base, errs, depth) {
    if (!s || depth > 40 || errs.length > 50) return;
    if (s.$ref) { const r = resolve(s.$ref, base); check(v, r.node, path, r.path, errs, depth + 1); }
    for (const sub of s.allOf || []) check(v, sub, path, base, errs, depth + 1);
    const where = path || "(record)";
    if (s.const !== undefined && JSON.stringify(v) !== JSON.stringify(s.const)) errs.push(`${where}: must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(v))) errs.push(`${where}: "${v}" is not one of ${s.enum.filter((x) => x != null).join(", ")}`);
    if (s.type) {
      const t = typeOf(v), want = [].concat(s.type);
      if (!want.includes(t) && !(t === "integer" && want.includes("number"))) { errs.push(`${where}: should be ${want.join(" or ")}, not ${t}`); return; }
    }
    if (typeof v === "string") {
      if (s.maxLength && v.length > s.maxLength) errs.push(`${where}: longer than ${s.maxLength} characters`);
      if (s.pattern && !new RegExp(s.pattern, "u").test(v)) errs.push(`${where}: "${v.slice(0, 60)}" does not match the expected pattern`);
      if (s.format && FORMATS[s.format] && v && !FORMATS[s.format].test(v)) errs.push(`${where}: "${v.slice(0, 60)}" is not a valid ${s.format}`);
    }
    if (typeof v === "number") {
      if (s.minimum != null && v < s.minimum) errs.push(`${where}: below ${s.minimum}`);
      if (s.maximum != null && v > s.maximum) errs.push(`${where}: above ${s.maximum}`);
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const k of s.required || []) if (!(k in v)) errs.push(`${path ? path + "." : ""}${k}: required`);
      for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) check(v[k], sub, path ? `${path}.${k}` : k, base, errs, depth + 1);
      if (s.additionalProperties === false && s.properties) for (const k of Object.keys(v)) if (!(k in s.properties)) errs.push(`${path ? path + "." : ""}${k}: not a known field here (put extra fields in metadata or ext)`);
    }
    if (Array.isArray(v) && s.items) v.forEach((x, i) => check(x, s.items, `${path}[${i}]`, base, errs, depth + 1));
  }
  /** Check a record against record.schema.json + its type schema. Returns a list of problems (empty = fine). */
  api.validate = function (rec) {
    const errs = [];
    if (!rec || typeof rec !== "object") return ["not a record"];
    for (const k of ["id", "type", "label"]) if (!rec[k]) errs.push(`${k}: required`);
    const all = schemas();
    if (!Object.keys(all).length) return errs;
    let typePath = null;
    for (const [p, sch] of Object.entries(all)) {
      if (!p.startsWith("types/")) continue;
      const t = (sch.properties || {}).type || {};
      if (t.const === rec.type || (t.enum || []).includes(rec.type)) { typePath = p; break; }
    }
    if (typePath) check(rec, all[typePath], "", typePath, errs, 0);
    else { check(rec, all["record.schema.json"], "", "record.schema.json", errs, 0); errs.push(`type: "${rec.type}" has no type schema`); }
    return [...new Set(errs)];
  };

  root.MDMStore = api;
})(typeof window !== "undefined" ? window : globalThis);
