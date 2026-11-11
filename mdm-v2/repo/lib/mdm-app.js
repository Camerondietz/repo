/*
 * mdm-app.js - the shared shell every internal app is built on (Org/People, Job, Product, Marketing, DOC...).
 *
 *   (an app in manage/<app>/index.html; paths are relative to the page)
 *   <link rel="stylesheet" href="../../repo/lib/mdm-app.css">
 *   <script src="../../repo/lib/mdm-client.js"></script>
 *   <script src="../../repo/lib/mdm-registry.js"></script>      schemas + registry (tools/mdm.py bundle)
 *   <script src="../../repo/lib/mdm-store.js"></script>         folder access + schema check
 *   <script src="../../data/marts/job.js"></script>              local data (tools/mdm.py marts); optional fallback
 *   <script src="../../repo/lib/mdm-app.js"></script>
 *   <script> MDMApp.start({ id: "job", title: "Job manager", types: [...], views: [...] }) </script>
 *
 * What it gives every app, the same way:
 *   - loading: the warehouse folder (Connect folder, remembered) -> local mart (window.MDM_DATA)
 *     -> mdm-client source chain (MDM API / repo) -> Import .json
 *   - saving: with the folder connected, every save writes data/warehouse/<type>.json (or internal/<type>.json)
 *     right away; without it, changes stay in this browser until you Export the files
 *   - categories and taxonomies always loaded: pick terms when editing, Categorize records (one or all shown),
 *     filter by any term
 *   - links: relations both ways, link targets loaded too, "Open in <app>" for records another app manages
 *   - raw JSON: copy any record, paste records or whole files, view and edit a whole file
 *   - views: table, board (drag a card to change a field), tree (parent_id), or a custom renderer
 *   - editor generated from the type's JSON Schema (so new schema fields appear by themselves) + JSON tab;
 *     every save is checked against the schema
 *   - must-carry: fields the form does not know are kept exactly as loaded; records an app does not show
 *     (other types, above its ceiling) are kept in the file untouched
 *   - classification ceiling: records above the app's max_classification are never shown
 *   - readOnly: true hides editing; cfg.actions still show, for view-only tools
 */
(function (root) {
  "use strict";

  const SCHEMA_VERSION = "2.1";
  // The MASTER folder, worked out from where this script was loaded (repo/lib/mdm-app.js), so links to other
  // apps and files work from any folder depth. Falls back to the page's parent folder.
  const ROOT = (() => {
    try { const s = document.currentScript && document.currentScript.src; if (s && /repo\/lib\/mdm-app\.js(\?|#|$)/.test(s)) return new URL("../../", s).href; } catch (_) { /* no script url */ }
    return "../";
  })();
  const VIS_TO_C = { public: 0, internal: 1, restricted: 3, confidential: 4 };
  const C_NAMES = ["C0 Public", "C1 Internal", "C2 Sensitive", "C3 Restricted", "C4 Confidential", "C5 Secret", "C6 Top secret", "C7 Black"];

  // ------------------------------------------------------------------ small utilities
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const vals = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const uuid = () => (root.crypto && crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16);
  }));
  function getPath(o, path) {
    if (typeof path === "function") return path(o);
    return String(path).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
  }
  function setPath(o, path, v) {
    const ks = path.split("."); let cur = o;
    ks.slice(0, -1).forEach((k) => { if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k]; });
    cur[ks[ks.length - 1]] = v;
  }
  function prune(o) {
    if (Array.isArray(o)) return o.map(prune).filter((v) => !(v === "" || v == null || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) || (Array.isArray(v) && !v.length)));
    if (o && typeof o === "object") {
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        const p = prune(v);
        if (p === "" || p == null) continue;
        if (Array.isArray(p) && !p.length && !Array.isArray(o[k])) continue;
        if (typeof p === "object" && !Array.isArray(p) && !Object.keys(p).length) continue;
        out[k] = p;
      }
      return out;
    }
    return o;
  }
  const humanize = (k) => String(k).replace(/_/g, " ").replace(/\./g, " › ");
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function download(name, text, type = "application/json") {
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function fmtMoney(m) {
    if (!m || typeof m !== "object" || !m.currency) return null;
    const n = m.amount != null ? Number(m.amount) : m.amount_minor != null ? m.amount_minor / 100 : null;
    if (n == null || isNaN(n)) return null;
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency, maximumFractionDigits: m.amount ? 6 : 2 }).format(n); }
    catch (_) { return `${n} ${m.currency}`; }
  }
  function fmtQty(q) {
    if (!q || typeof q !== "object" || q.value == null || !q.unit) return null;
    return `${q.value}${q.tol != null ? " ±" + q.tol : ""} ${q.unit}`;
  }
  function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s); if (isNaN(d)) return s;
    return s.length <= 10 ? d.toLocaleDateString(undefined, { timeZone: "UTC" }) : d.toLocaleString();
  }

  // canonical checksum, same rules as tools/mdm.py (sorted keys, volatile fields left out)
  const VOLATILE = new Set(["updated_at", "updated_by", "checksum_sha256"]);
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    return JSON.stringify(v);
  }

  // ------------------------------------------------------------------ registry + schema helpers
  const REG = () => root.MDM_REGISTRY || { schemas: {}, types: {}, vocabularies: {}, apps: [], classification: {} };
  function typeSchema(type) {
    const s = REG().schemas;
    for (const [path, sch] of Object.entries(s)) {
      if (!path.startsWith("types/")) continue;
      const t = (sch.properties || {}).type || {};
      if (t.const === type || (t.enum || []).includes(type)) return { path, sch };
    }
    return null;
  }
  function resolveRef(ref, ctx) {
    // ctx = { path: "types/person.schema.json", sch }
    const [file, frag] = ref.split("#");
    let base = ctx;
    if (file) {
      const dir = ctx.path.includes("/") ? ctx.path.replace(/[^/]+$/, "") : "";
      const parts = (dir + file).split("/"); const norm = [];
      for (const p of parts) { if (p === "..") norm.pop(); else if (p && p !== ".") norm.push(p); }
      const path = norm.join("/");
      base = { path, sch: REG().schemas[path] };
      if (!base.sch) return { node: null, ctx };
    }
    let node = base.sch;
    for (const k of (frag || "").split("/").filter(Boolean)) node = node && node[k];
    return { node, ctx: base };
  }
  function deref(node, ctx, depth = 0) {
    while (node && node.$ref && depth < 12) {
      const extra = Object.assign({}, node); delete extra.$ref;
      const r = resolveRef(node.$ref, ctx); ctx = r.ctx;
      node = r.node ? Object.assign({}, r.node, extra) : null; depth++;
    }
    return { node, ctx };
  }
  function dataSchema(type) {
    const ts = typeSchema(type);
    if (!ts) return { node: null, ctx: null };
    const d = (ts.sch.properties || {}).data;
    return d ? deref(d, ts) : { node: null, ctx: ts };
  }
  function envelopeEnum(field) {
    const rec = REG().schemas["record.schema.json"];
    return rec && rec.properties && rec.properties[field] && rec.properties[field].enum;
  }
  function relationVocab() { return (REG().vocabularies || {}).relations || []; }
  function inverseName(rel) { const r = relationVocab().find((x) => x.rel === rel); return r ? r.inverse : rel + " (of)"; }

  function effectiveC(r) {
    const cl = r.classification || {};
    if (cl.c != null) return cl.c;
    if (r.visibility in VIS_TO_C) return VIS_TO_C[r.visibility];
    const d = (REG().types[r.type] || {}).default || {};
    return d.c != null ? d.c : 2;
  }

  // ------------------------------------------------------------------ the app
  // records another app manages: type -> { id, name, entry } from registry/apps.json (data.produces)
  function ownerApps() {
    const out = {};
    for (const a of REG().apps || []) {
      if (!a.entry || a.access !== "edit") continue;
      for (const p of (a.data || {}).produces || []) for (const t of p.types || []) if (t !== "*" && !out[t]) out[t] = { id: a.id, name: a.name, entry: a.entry };
    }
    return out;
  }
  const TAXO = ["taxonomy_scheme", "taxonomy_term"];
  function recordsOf(doc) {
    if (root.MDMClient) return root.MDMClient.recordsOf(doc);
    if (Array.isArray(doc)) return doc;
    for (const k of ["items", "records", "upserts"]) if (doc && Array.isArray(doc[k])) return doc[k];
    return doc && doc.id && doc.type ? [doc] : [];
  }

  function start(cfg) {
    const appReg = (REG().apps || []).find((a) => a.id === cfg.id) || {};
    const ceiling = cfg.maxC != null ? cfg.maxC : appReg.max_classification != null ? appReg.max_classification : 2;
    const LS = `mdm-app:${cfg.id}:`;
    const Store = root.MDMStore || null;
    const canFolder = !!Store && cfg.readOnly !== true && (cfg.chrome || {}).open !== false;
    const store = {
      get(k, d) { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
      set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (_) { toast("Browser storage is full or blocked; export your changes now."); } },
    };
    const state = {
      originals: new Map(),                                   // saved records (as in the files)
      drafts: new Map(Object.entries(store.get("unsaved", {}))), // changes not written to a file yet
      home: new Map(Object.entries(store.get("unsaved-home", {}))), // id -> "shared" | "internal" (which file)
      files: new Map(),                                        // "store/type" -> { type, store, all: Map, meta, complete }
      folder: "none",                                          // none | prompt | connected | unsupported
      saving: false, source: "none", generated: null, hiddenAboveCeiling: 0, view: null, selected: null, q: "", facets: {}, sort: null, limit: 400,
    };
    let incoming = new Map();
    const owners = ownerApps();

    const app = {
      cfg, esc, h, vals, getPath, setPath, clone, fmtMoney, fmtQty, fmtDate, effectiveC, uuid, nowIso, toast,
      get: (id) => state.drafts.get(id) || state.originals.get(id),
      all: () => { const m = new Map(state.originals); for (const [id, r] of state.drafts) m.set(id, r); return [...m.values()].filter((r) => !r.deleted_at); },
      byType: (...types) => app.all().filter((r) => types.flat().includes(r.type)),
      incoming: (id, rel) => (incoming.get(id) || []).filter((e) => !rel || e.rel === rel).map((e) => ({ rel: e.rel, rec: app.get(e.from) })).filter((x) => x.rec && !x.rec.deleted_at),
      out: (r, rel) => vals(r && r.relations).filter((e) => e && (!rel || e.rel === rel)).map((e) => ({ edge: e, rec: app.get(e.id) })),
      children: (id) => app.all().filter((r) => r.parent_id === id),
      isDraft: (id) => state.drafts.has(id),
      select, saveDraft, save: saveDraft, newRecord, openEditor, refresh, state, label, prune, humanize, download, kv: (o) => kv(o), modal: (...a) => modal(...a), pick: (...a) => pick(...a),
      edge: (rel, rec, extra) => Object.assign({ rel, type: rec.type, id: rec.id, label: rec.label }, extra || {}),
      storeOf: (r) => state.home.get(r.id) || (cfg.storeFor && cfg.storeFor(r)) || (Store ? Store.storeOf(r.type) : "shared"),
      flush: () => flush(), categorize: (...a) => categorize(...a), terms: () => taxonomy(),
      ceiling, C_NAMES,
    };

    function label(id) { const r = app.get(id); return r ? r.label : "(not loaded)"; }

    // ---------------------------------------------------------------- loading
    const fileKey = (type, st) => `${st}/${type}`;
    function ingest(items, sourceLabel, file) {
      let n = 0, hidden = 0;
      for (const r of items) {
        if (!r || !r.id || !r.type) continue;
        if (file) { file.all.set(r.id, r); state.home.set(r.id, file.store); }
        if (effectiveC(r) > ceiling) { hidden++; continue; }
        state.originals.set(r.id, r); n++;
      }
      state.hiddenAboveCeiling += hidden;
      if (sourceLabel) state.source = state.source === "none" ? sourceLabel : state.source.includes(sourceLabel) ? state.source : state.source + " + " + sourceLabel;
      return { n, hidden };
    }
    function ingestFile(type, st, doc, complete, sourceLabel) {
      const items = recordsOf(doc).filter((r) => r && r.type === type);
      const file = { type, store: st, all: new Map(), meta: (doc && doc.meta) || {}, complete };
      state.files.set(fileKey(type, st), file);
      return ingest(items, sourceLabel, file);
    }
    function wantedTypes() {
      const t = new Set(vals(cfg.types).filter((x) => x !== "*"));
      if (cfg.taxonomies !== false) TAXO.forEach((x) => t.add(x));
      vals(cfg.contextTypes).forEach((x) => t.add(x));
      return t;
    }
    async function loadFromFolder() {
      state.originals.clear(); state.files.clear(); state.hiddenAboveCeiling = 0; state.source = "none";
      const present = await Store.list();
      const allTypes = vals(cfg.types).includes("*") || cfg.acceptAnyType;
      const want = allTypes ? new Set(present.map((f) => f.type)) : wantedTypes();
      const readType = async (t) => { for (const { store: st, doc } of await Store.read(t)) ingestFile(t, st, doc, true, null); };
      for (const t of want) await readType(t);
      // link targets: load the files of types that loaded records point at, so links and labels resolve
      if (cfg.linkTargets !== false) {
        const more = new Set();
        for (const r of state.originals.values()) for (const e of vals(r.relations)) if (e && e.type && !want.has(e.type)) more.add(e.type);
        for (const r of state.originals.values()) if (r.parent_id && !state.originals.has(r.parent_id)) more.add(r.type === "org_unit" ? "organization" : r.type);
        for (const t of more) if (present.some((f) => f.type === t)) await readType(t);
      }
      state.source = "folder " + Store.status().label;
      state.generated = null;
      refresh();
      if (state.drafts.size) flush(); // changes made while the folder was not connected
    }
    async function load() {
      if (canFolder) {
        if (!Store.supported()) state.folder = "unsupported";
        else {
          const st = Store.connected() ? "granted" : await Store.restore().catch(() => "none");
          if (state.folder === "connected") return; // connected meanwhile (restore or the management page): already loading
          if (st === "granted") { state.folder = "connected"; try { await loadFromFolder(); return; } catch (e) { toast(e.message); } }
          else state.folder = st;
        }
      }
      const local = root.MDM_DATA;
      if (local) {
        const items = recordsOf(local);
        ingest(items, `local mart (data/marts/${cfg.id}.js)`);
        state.generated = (local.meta || {}).generated || null;
        state.hiddenAboveCeiling += (local.meta || {}).hidden_above_ceiling || 0;
      } else if (root.MDMClient && location.protocol !== "file:" && cfg.client !== false) {
        try {
          const client = MDMClient.create(cfg.client || {});
          const res = await client.loadAll(cfg.types);
          if (state.folder === "connected") return;
          const srcs = [...new Set(Object.values(res.sources).filter(Boolean))];
          if (res.items.length) ingest(res.items, "repo: " + srcs.join(", "));
          try { state.generated = (await client.catalog()).generated; } catch (_) { /* optional */ }
        } catch (e) { console.warn(e); }
      }
      refresh();
    }
    let connecting = false;
    async function connectFolder() {
      connecting = true;
      try {
        if (state.folder === "prompt") await Store.reconnect(); else await Store.connect();
        state.folder = "connected"; toast("Folder connected: " + Store.status().label);
        await loadFromFolder();
      } catch (e) { if (e && e.name !== "AbortError") toast(e.message || String(e)); }
      connecting = false;
    }
    // the folder can also be connected from outside this app (the management page hands it over)
    if (canFolder) Store.onChange((st) => {
      if (connecting) return;
      if (st.connected && state.folder !== "connected") { state.folder = "connected"; loadFromFolder().catch((e) => toast(e.message)); }
      else if (!st.connected && state.folder === "connected") { state.folder = "none"; renderAll(); }
    });

    // Import: warehouse collections, marts, plain arrays, single records, encrypted files
    async function readJsonFile(f) {
      let text = await f.text();
      const m = text.match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)?window\.[A-Za-z_$][\w$]*\s*=\s*/);
      if (m) text = text.slice(m[0].length).replace(/;\s*$/, "");
      let doc = JSON.parse(text);
      if (doc && (doc.format === "c2-enc" || doc.format === "mdm-enc")) {
        const pw = prompt(`Password for ${f.name}`);
        if (!pw) return null;
        doc = await MDMClient.decrypt(doc, pw);
      }
      return doc;
    }
    async function openFiles(files) {
      let total = 0;
      const upserts = [];
      for (const f of files) {
        let doc;
        try { doc = await readJsonFile(f); } catch (e) { toast(`${f.name}: ${e.message}`); continue; }
        if (!doc) continue;
        const items = recordsOf(doc).filter((r) => r && r.id && r.type && (!cfg.types || cfg.types.includes("*") || cfg.types.includes(r.type) || cfg.acceptAnyType || TAXO.includes(r.type)));
        if (state.folder === "connected") { upserts.push(...items); continue; }
        const metaType = doc.meta && doc.meta.type;
        if (metaType && !doc.format) { // a whole warehouse file: keep it complete so it can be exported back
          const st = /internal/i.test(f.name) || (f.webkitRelativePath || "").includes("internal/") ? "internal" : (Store ? Store.storeOf(metaType) : "shared");
          const res = ingestFile(metaType, st, doc, true, "imported files"); total += res.n;
          if (res.hidden) toast(`${res.hidden} records above this app's ${C_NAMES[ceiling]} ceiling are kept in the file but not shown`);
        } else { const res = ingest(items, "imported files"); total += res.n; }
      }
      if (upserts.length) {
        if (!confirm(`Add or update ${upserts.length} records in the warehouse folder?\nRecords with the same id are replaced.`)) return;
        upserts.forEach((r) => saveDraft(r, { silent: true, defer: true }));
        refresh(); flush();
        return;
      }
      toast(`Loaded ${total} records`);
      refresh();
    }

    // ---------------------------------------------------------------- saving
    function persistDrafts() {
      store.set("unsaved", Object.fromEntries(state.drafts));
      store.set("unsaved-home", Object.fromEntries([...state.drafts.keys()].filter((id) => state.home.has(id)).map((id) => [id, state.home.get(id)])));
    }
    function stamp(r) {
      r.updated_at = nowIso();
      r.updated_by = { type: "person", label: cfg.actor || "app:" + cfg.id };
      delete r.checksum_sha256; // recomputed by the toolchain
      return r;
    }
    /** Save a record: written to its warehouse file right away when the folder is connected. */
    function saveDraft(r, { silent, defer, store: st } = {}) {
      const rec = stamp(clone(r));
      const ts = typeSchema(rec.type);
      if (ts) for (const [k, v] of Object.entries(ts.sch.properties || {})) if (v && v.const !== undefined && k !== "type") rec[k] = v.const;
      if (!rec.apps) rec.apps = [];
      if (!rec.apps.includes(cfg.id)) rec.apps.push(cfg.id);
      const before = state.home.get(rec.id);
      if (st && before && st !== before) moves.set(rec.id, before);
      if (st) state.home.set(rec.id, st);
      state.drafts.set(rec.id, rec);
      persistDrafts();
      if (!silent && state.folder !== "connected") toast("Changed in this browser. Connect the folder to save it, or Export the file.");
      if (!defer) { refresh(); flush(); }
      return rec;
    }
    const moves = new Map(); // id -> store it is leaving
    let flushTimer = null, flushing = null;
    function flush() {
      clearTimeout(flushTimer);
      if (state.folder !== "connected" || !state.drafts.size) { renderStatus(); return Promise.resolve(); }
      return new Promise((resolve) => { flushTimer = setTimeout(() => resolve(doFlush()), 250); });
    }
    async function doFlush() {
      if (flushing) { await flushing; return flush(); }
      flushing = (async () => {
        state.saving = true; renderStatus();
        const groups = new Map();
        for (const [id, r] of state.drafts) {
          const st = app.storeOf(r);
          const key = fileKey(r.type, st);
          if (!groups.has(key)) groups.set(key, { type: r.type, store: st, recs: [] });
          groups.get(key).recs.push(r);
          if (moves.has(id)) { const ok = fileKey(r.type, moves.get(id)); if (!groups.has(ok)) groups.set(ok, { type: r.type, store: moves.get(id), recs: [] }); }
        }
        const written = [];
        for (const [key, g] of groups) {
          try {
            if (!state.files.has(key)) { // not loaded yet: read the whole file first so nothing in it is lost
              const found = (await Store.read(g.type)).find((x) => x.store === g.store);
              state.files.set(key, { type: g.type, store: g.store, all: new Map(found ? recordsOf(found.doc).map((x) => [x.id, x]) : []), meta: found ? found.doc.meta || {} : {}, complete: true });
            }
            const file = state.files.get(key);
            for (const r of g.recs) file.all.set(r.id, r);
            for (const [id, from] of moves) if (fileKey(g.type, from) === key) file.all.delete(id);
            await Store.write(g.type, g.store, Store.collection(g.type, [...file.all.values()], g.store, file.meta));
            for (const r of g.recs) { state.originals.set(r.id, r); state.drafts.delete(r.id); moves.delete(r.id); }
            written.push((g.store === "internal" ? "internal/" : "") + g.type + ".json");
          } catch (e) { toast(`Could not save ${key}.json: ${e.message}`); }
        }
        persistDrafts();
        state.saving = false;
        if (written.length) toast("Saved " + written.join(", "));
        renderAll();
      })();
      await flushing; flushing = null;
    }
    function newRecord(type, partial = {}) {
      const id = uuid();
      const r = Object.assign({ id, uri: `https://mdm.cameron-dietz.com/id/${type}/${id}`, type, label: "", status: "active", created_at: nowIso() }, clone(partial));
      return r;
    }
    function discard(id) { state.drafts.delete(id); moves.delete(id); persistDrafts(); refresh(); }
    window.addEventListener("beforeunload", (e) => { if (state.folder === "connected" && state.drafts.size) { e.preventDefault(); e.returnValue = ""; } });

    /** Upsert records from pasted or imported JSON: a record, an array, a collection or a changeset. */
    function upsertParsed(doc) {
      const items = doc && !Array.isArray(doc) && doc.type && !doc.items && !doc.upserts ? [doc] : recordsOf(doc);
      if (!items.length) throw new Error("No records found: paste a record, a list of records, or a whole file");
      const problems = [];
      const ready = items.map((r) => {
        r = clone(r);
        if (!r.type) throw new Error("Every record needs a type");
        if (!r.id) { r.id = uuid(); r.uri = `https://mdm.cameron-dietz.com/id/${r.type}/${r.id}`; r.created_at = r.created_at || nowIso(); }
        const errs = Store ? Store.validate(r) : [];
        if (errs.length) problems.push(`${r.label || r.id}: ${errs.slice(0, 3).join("; ")}`);
        return r;
      });
      if (problems.length && !confirm(`Schema check found problems in ${problems.length} record(s):\n\n${problems.slice(0, 8).join("\n")}\n\nSave anyway?`)) return 0;
      ready.forEach((r) => saveDraft(r, { silent: true, defer: true }));
      refresh(); flush();
      return ready.length;
    }

    // ---------------------------------------------------------------- categories + taxonomies
    let taxoCache = null, taxoStamp = -1;
    /** { dims: Map(dimension -> { schemes: [scheme], terms: Map(path -> term) }), byId } built from loaded schemes + terms */
    function taxonomy() {
      const stamp = state.originals.size * 7 + state.drafts.size;
      if (taxoCache && taxoStamp === stamp) return taxoCache;
      const dims = new Map(), schemeBySlug = new Map();
      for (const s of app.byType("taxonomy_scheme")) {
        const dim = (s.data || {}).dimension || s.slug;
        if (!dim) continue;
        schemeBySlug.set(s.slug, s);
        if (!dims.has(dim)) dims.set(dim, { schemes: [], terms: new Map() });
        dims.get(dim).schemes.push(s);
      }
      for (const t of app.byType("taxonomy_term")) {
        const d = t.data || {};
        const s = schemeBySlug.get(d.scheme);
        const dim = s ? (s.data || {}).dimension || s.slug : d.scheme;
        if (!dim || !d.path) continue;
        if (!dims.has(dim)) dims.set(dim, { schemes: [], terms: new Map() });
        dims.get(dim).terms.set(d.path, t);
      }
      taxoCache = { dims }; taxoStamp = stamp;
      return taxoCache;
    }
    function termLabel(dim, val) {
      const d = taxonomy().dims.get(String(dim).replace(/^category\./, ""));
      const t = d && d.terms.get(val);
      return t ? t.label : null;
    }
    /** Values already used in a dimension across loaded records (app-specific categories). */
    function usedValues(dim) {
      const c = new Map();
      for (const r of state.originals.values()) for (const v of vals((r.category || {})[dim])) if (typeof v === "string") c.set(v, (c.get(v) || 0) + 1);
      return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
    }
    /** Ask for a term (or a free value) and add it to category[dim] on each record. */
    function categorize(records, title) {
      records = vals(records);
      const tx = taxonomy();
      const types = new Set(records.map((r) => r.type));
      const fits = (s) => !vals((s.data || {}).applies_to).length || vals(s.data.applies_to).some((t) => types.has(t));
      const pool = [], later = [];
      for (const [dim, d] of tx.dims) {
        const list = !d.schemes.length || d.schemes.some(fits) ? pool : later; // taxonomies meant for these types first
        for (const [path, t] of d.terms) list.push({ id: t.id, label: t.label, type: dim, summary: path, aliases: [path], _dim: dim, _path: path });
      }
      pool.push(...later);
      const extra = [];
      for (const dim of Object.keys((REG().vocabularies || {}).category_dimensions || {})) for (const v of usedValues(dim).slice(0, 200)) if (!(tx.dims.get(dim) || { terms: new Map() }).terms.has(v)) extra.push({ id: dim + ":" + v, label: humanize(v), type: dim + " (in use)", summary: v, aliases: [v], _dim: dim, _path: v });
      pick(title || `Categorize ${records.length === 1 ? records[0].label : records.length + " records"}`, pool.concat(extra), (t) => {
        let n = 0;
        for (const r of records) {
          const c = clone(r); c.category = Object.assign({}, c.category);
          const cur = vals(c.category[t._dim]);
          if (cur.includes(t._path)) continue;
          c.category[t._dim] = cur.length ? cur.concat([t._path]) : t._path;
          saveDraft(c, { silent: true, defer: true }); n++;
        }
        refresh(); flush();
        toast(`${t._dim}: ${t._path} added to ${n} record${n === 1 ? "" : "s"}`);
      }, "Terms from the taxonomies that apply to these records, then values other records already use. Keeps existing values.");
    }
    function filterByCategory() {
      const pool = [];
      for (const [dim, d] of taxonomy().dims) for (const [path, t] of d.terms) pool.push({ id: t.id, label: t.label, type: dim, summary: path, aliases: [path], _dim: dim, _path: path });
      for (const dim of Object.keys((REG().vocabularies || {}).category_dimensions || {})) for (const v of usedValues(dim).slice(0, 300)) pool.push({ id: dim + ":" + v, label: humanize(v), type: dim + " (in use)", summary: v, aliases: [v], _dim: dim, _path: v });
      pick("Filter by category", pool, (t) => { state.facets["category." + t._dim] = t._path; state.limit = 400; renderMain(); }, "Shows records with this term or anything under it.");
    }

    // ---------------------------------------------------------------- DOM skeleton
    document.title = cfg.title;
    document.body.innerHTML = "";
    const theme = store.get("theme", null); if (theme) document.documentElement.dataset.theme = theme;
    const fileInput = h("input", { type: "file", multiple: true, accept: ".json,.js", style: "display:none", onchange: (e) => openFiles([...e.target.files]) });
    const search = h("input", { class: "mdm-search", type: "search", placeholder: "Search  (press /)", oninput: (e) => { state.q = e.target.value.trim().toLowerCase(); state.limit = 400; renderMain(); } });
    const srcPill = h("span", { class: "mdm-pill" });
    const chrome = cfg.chrome || {}; // { open: false, changes: false } hides those header buttons (public apps)
    const editable = cfg.readOnly !== true;
    const folderBtn = h("button", { class: "mdm-btn", onclick: () => (state.folder === "connected" ? showFiles() : connectFolder()) });
    const saveState = h("span", { class: "mdm-pill" });
    const exportBtn = h("button", { class: "mdm-btn", onclick: showFiles, title: "Files: download, view or edit raw JSON" }, "Export");
    const top = h("header", { class: "mdm-top" },
      h("div", { class: "mdm-brand" }, h("b", {}, cfg.title), h("small", {}, cfg.subtitle || "")),
      search, srcPill,
      ...(cfg.headerButtons || []).map((b) => h("button", { class: "mdm-btn", onclick: () => b.run(app) }, b.label)),
      canFolder ? folderBtn : null, canFolder ? saveState : null,
      chrome.open !== false ? h("button", { class: "mdm-btn", onclick: () => fileInput.click(), title: "Load .json files: warehouse files, marts, exported records or encrypted files" }, "Import") : null,
      chrome.changes !== false && editable ? exportBtn : null,
      chrome.open !== false && editable ? h("button", { class: "mdm-btn", onclick: showPaste, title: "Paste one record, a list of records or a whole file" }, "Paste JSON") : null,
      h("button", { class: "mdm-btn", onclick: showDataPanel }, "Data"),
      h("button", { class: "mdm-btn", title: "Light / dark", onclick: () => {
        const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        const next = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = next; store.set("theme", next);
      } }, "◐"), fileInput);
    const nav = h("nav", { class: "mdm-nav" });
    const main = h("main", { class: "mdm-main" });
    const detail = h("aside", { class: "mdm-detail" });
    const body = h("div", { class: "mdm-body no-detail" }, nav, main, detail);
    document.body.append(h("div", { class: "mdm-app" }, top, body));
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); search.focus(); }
      if (e.key === "Escape") { const m = document.querySelector(".mdm-modal"); if (m) m.remove(); else select(null); }
    });
    window.addEventListener("hashchange", fromHash);

    function fromHash() {
      const [v, id] = decodeURIComponent(location.hash.slice(1)).split("/");
      if (v === "id" && id) { state.pendingGo = id; state.selected = id; renderAll(); return; } // #id/<uuid> from another app
      if (v && cfg.views.some((x) => x.id === v)) state.view = v;
      state.selected = id || null;
      renderAll();
    }
    function toHash() { history.replaceState(null, "", "#" + [state.view, state.selected].filter(Boolean).join("/")); }

    // ---------------------------------------------------------------- render
    function refresh() {
      incoming = new Map();
      for (const r of app.all()) for (const e of vals(r.relations)) if (e && e.id) { if (!incoming.has(e.id)) incoming.set(e.id, []); incoming.get(e.id).push({ from: r.id, rel: e.rel }); }
      renderAll();
      if (state.drafts.size && state.folder === "connected") flush(); // apps that save several records then refresh once
    }
    function renderStatus() {
      const n = state.drafts.size;
      exportBtn.innerHTML = "Export" + (n && state.folder !== "connected" ? `<span class="mdm-badge" title="changes not in a file yet">${n}</span>` : "");
      folderBtn.textContent = state.folder === "connected" ? "📁 " + (Store.status().label || "folder") : state.folder === "prompt" ? "Reconnect folder" : "Connect folder";
      folderBtn.title = state.folder === "connected" ? "Saving straight to the warehouse folder. Click for files." : "Pick the MASTER folder (or data/warehouse) so saves go straight to the files";
      folderBtn.className = "mdm-btn" + (state.folder === "prompt" ? " primary" : "");
      folderBtn.style.display = state.folder === "unsupported" ? "none" : "";
      saveState.style.display = state.folder === "connected" || n ? "" : "none";
      saveState.className = "mdm-pill " + (state.saving ? "warn" : n ? "warn" : "ok");
      saveState.textContent = state.saving ? "Saving…" : n ? `${n} unsaved` : "All saved";
    }
    function renderAll() {
      if (!state.view) state.view = cfg.views[0].id;
      if (state.pendingGo && app.get(state.pendingGo)) { const id = state.pendingGo; state.pendingGo = null; goTo(id); return; }
      renderStatus();
      const cnt = state.originals.size;
      srcPill.className = "mdm-pill " + (cnt ? "ok" : "warn");
      srcPill.textContent = cnt ? `${cnt.toLocaleString()} records · ${state.source}${state.generated ? " · as of " + fmtDate(state.generated) : ""}` : "no data loaded";
      renderNav(); renderMain(); renderDetail(); toHash();
    }
    function viewRecords(v) {
      let rs = v.records ? v.records(app) : app.all().filter((r) => (!v.type || vals(v.type).includes(r.type)) && (!v.filter || v.filter(r, app)));
      return rs;
    }
    function renderNav() {
      nav.innerHTML = "";
      let group = null;
      for (const v of cfg.views) {
        if (v.group && v.group !== group) { group = v.group; nav.append(h("h4", {}, group)); }
        const count = v.kind === "custom" && !v.type && !v.records ? "" : viewRecords(v).length.toLocaleString();
        nav.append(h("button", { class: v.id === state.view ? "on" : "", onclick: () => { state.view = v.id; state.facets = {}; state.limit = 400; state.sort = null; renderAll(); } },
          h("span", {}, v.label), h("span", {}, count)));
      }
    }
    function matchesQuery(r) {
      if (!state.q) return true;
      const hay = [r.label, r.summary, ...(r.aliases || []), ...(r.tags || []), ...Object.values(r.identifiers || {}).flat(), r.slug, r.data && r.data.notation, r.data && r.data.path,
        ...vals(r.data && r.data.contact_points).map((c) => c.value), r.data && r.data.contact && r.data.contact.email].join(" ").toLowerCase();
      return state.q.split(/\s+/).every((t) => hay.includes(t));
    }
    function facetFilter(rs, v) {
      for (const [dim, val] of Object.entries(state.facets)) rs = rs.filter((r) => vals(getPath(r, dim)).some((x) => String(x) === val || String(x).startsWith(val + ".")));
      return rs;
    }
    function renderFacets(rs, v) {
      const dims = v.facets || cfg.facets || [];
      const box = h("div", { class: "mdm-facets" });
      const chipText = (dim, val) => (dim.startsWith("category.") && termLabel(dim, val)) || humanize(val);
      // filters set with "Filter by category" that are not one of the chips below
      for (const [dim, val] of Object.entries(state.facets)) if (!dims.includes(dim) || String(val).includes(".")) {
        box.append(h("button", { class: "mdm-chip on", title: "Remove this filter", onclick: () => { delete state.facets[dim]; renderMain(); } }, humanize(dim.replace(/^category\./, "")) + ": " + chipText(dim, val) + " ✕"));
      }
      for (const dim of dims) {
        const counts = new Map();
        for (const r of rs) for (const x of vals(getPath(r, dim))) { const top = typeof x === "string" && v.facetDepth !== 0 ? x.split(".").slice(0, (v.facetDepth || 1)).join(".") : String(x); counts.set(top, (counts.get(top) || 0) + 1); }
        if (!counts.size) continue;
        box.append(h("span", { class: "mdm-muted", style: "font-size:12px;padding-top:3px" }, humanize(dim.replace(/^(category|data)\./, "")) + ":"));
        [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([val, n]) => {
          const on = state.facets[dim] === val;
          box.append(h("button", { class: "mdm-chip" + (on ? " on" : ""), onclick: () => { if (on) delete state.facets[dim]; else state.facets[dim] = val; state.limit = 400; renderMain(); } }, chipText(dim, val) + " ", h("b", {}, n)));
        });
      }
      if (v.kind !== "custom" && cfg.taxonomies !== false && (taxonomy().dims.size || dims.some((d) => d.startsWith("category.")))) box.append(h("button", { class: "mdm-chip", onclick: filterByCategory, title: "Filter by any taxonomy term or category value" }, "+ category filter"));
      return box.children.length ? box : null;
    }
    function currentView() { return cfg.views.find((x) => x.id === state.view) || cfg.views[0]; }
    function renderMain() {
      const v = currentView();
      main.innerHTML = "";
      const all = v.kind === "custom" && !v.type && !v.records ? [] : viewRecords(v);
      let rs = facetFilter(all.filter(matchesQuery), v);
      const head = h("div", { class: "mdm-viewhead" }, h("h2", {}, v.label), h("span", { class: "mdm-muted" }, v.kind === "custom" && !all.length ? "" : `${rs.length.toLocaleString()} of ${all.length.toLocaleString()}`), h("span", { class: "grow" }));
      const newType = v.newType || (typeof v.type === "string" ? v.type : null);
      if (newType && v.allowNew !== false && cfg.readOnly !== true) head.append(h("button", { class: "mdm-btn primary", onclick: () => openEditor(newRecord(newType, v.newTemplate ? v.newTemplate(app) : {}), true) }, "New " + humanize(newType)));
      for (const b of v.buttons || []) head.append(h("button", { class: "mdm-btn", onclick: () => b.run(app, rs) }, b.label));
      if (cfg.readOnly !== true && cfg.taxonomies !== false && v.kind !== "custom" && rs.length && taxonomy().dims.size) head.append(h("button", { class: "mdm-btn", title: "Add a category or taxonomy term to every record shown", onclick: () => { if (rs.length < 2 || confirm(`Add a category to all ${rs.length} records shown?`)) categorize(rs); } }, `Categorize ${rs.length === all.length ? "all" : "shown"}`));
      main.append(head);
      if (v.intro) main.append(h("p", { class: "mdm-muted", html: v.intro }));
      if (!state.originals.size && !state.drafts.size && v.kind !== "custom") { main.append(emptyState()); return; }
      const facets = renderFacets(all.filter(matchesQuery), v); if (facets) main.append(facets);
      if (v.kind === "board") main.append(renderBoard(rs, v));
      else if (v.kind === "tree") main.append(renderTree(rs, v));
      else if (v.kind === "custom") { const box = h("div", {}); main.append(box); v.render(box, app, rs); }
      else main.append(renderTable(rs, v));
    }
    function emptyState() {
      const box = h("div", { class: "mdm-empty", html: `<p><b>No data loaded yet.</b></p>
        <p>${canFolder && state.folder !== "unsupported" ? "<b>Connect folder</b> and pick the MASTER folder: records load from <code>data/warehouse/</code> and every save goes straight back to those files.<br>Or " : ""}
        click <b>Import</b> and pick files from <code>data/warehouse/</code> (or a published <code>.enc.json</code>), then <b>Export</b> them back.</p>
        <p>You can still create new records; they stay in this browser until they are saved to a file.</p>` });
      if (canFolder && state.folder !== "unsupported") box.append(h("button", { class: "mdm-btn primary", onclick: connectFolder }, state.folder === "prompt" ? "Reconnect folder" : "Connect folder"));
      return box;
    }
    function cellValue(r, c) {
      const v = typeof c.get === "function" ? c.get(r, app) : getPath(r, c.get);
      if (v == null) return "";
      if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(", ");
      if (typeof v === "object") return fmtMoney(v) || fmtQty(v) || JSON.stringify(v);
      if (c.date) return fmtDate(v);
      return v;
    }
    function renderTable(rs, v) {
      const cols = v.columns || [{ label: "Name", get: "label" }, { label: "Status", get: "status" }];
      if (state.sort) {
        const c = cols[state.sort.i];
        rs = [...rs].sort((a, b) => { const x = String(cellValue(a, c)).toLowerCase(), y = String(cellValue(b, c)).toLowerCase(); return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir; });
      } else if (v.sort) rs = [...rs].sort(v.sort);
      else rs = [...rs].sort((a, b) => String(a.label).localeCompare(String(b.label)));
      const t = h("table", { class: "mdm-table" });
      t.append(h("thead", {}, h("tr", {}, cols.map((c, i) => h("th", { onclick: () => { state.sort = { i, dir: state.sort && state.sort.i === i ? -state.sort.dir : 1 }; renderMain(); } },
        c.label + (state.sort && state.sort.i === i ? (state.sort.dir > 0 ? " ▲" : " ▼") : ""))))));
      const tb = h("tbody");
      for (const r of rs.slice(0, state.limit)) {
        const tr = h("tr", { class: r.id === state.selected ? "on" : "", onclick: () => select(r.id) });
        cols.forEach((c, i) => {
          const val = cellValue(r, c);
          const td = h("td", { class: c.num ? "num" : "" });
          if (i === 0 && app.isDraft(r.id)) td.append(h("span", { class: "mdm-draft", title: "not saved to a file yet" }, "● "));
          td.append(c.html ? h("span", { html: c.html(r, app) }) : String(val));
          tr.append(td);
        });
        tb.append(tr);
      }
      t.append(tb);
      const wrap = h("div", {}, t);
      if (rs.length > state.limit) wrap.append(h("div", { class: "mdm-more" }, `${rs.length - state.limit} more · `, h("button", { class: "mdm-btn small", onclick: () => { state.limit += 1000; renderMain(); } }, "Show more")));
      return wrap;
    }
    function boardGroups(v) {
      if (v.groups) return v.groups;
      const m = String(v.groupBy).match(/^data\.(\w+)$/);
      if (m) { const ds = dataSchema(vals(v.type)[0]).node; const p = ds && ds.properties && ds.properties[m[1]]; if (p && p.enum) return p.enum; }
      return null;
    }
    function renderBoard(rs, v) {
      let groups = boardGroups(v);
      const keyOf = (r) => getPath(r, v.groupBy) || v.emptyGroup || "(none)";
      if (!groups) groups = [...new Set(rs.map(keyOf))];
      if (rs.some((r) => !getPath(r, v.groupBy)) && !groups.includes(v.emptyGroup || "(none)")) groups = [v.emptyGroup || "(none)", ...groups];
      const board = h("div", { class: "mdm-board" });
      for (const g of groups) {
        const items = rs.filter((r) => keyOf(r) === g);
        if (v.hideEmpty && !items.length) continue;
        const col = h("div", { class: "mdm-col", ondragover: (e) => { e.preventDefault(); col.classList.add("drop"); }, ondragleave: () => col.classList.remove("drop"),
          ondrop: (e) => {
            e.preventDefault(); col.classList.remove("drop");
            const r = app.get(e.dataTransfer.getData("text/plain")); if (!r || keyOf(r) === g) return;
            const c = clone(r); setPath(c, v.groupBy, g === (v.emptyGroup || "(none)") ? null : g);
            if (v.onMove) v.onMove(c, g, app);
            saveDraft(prune(c), { silent: true }); toast(`${c.label} → ${humanize(g)}`);
          } }, h("h3", {}, h("span", {}, humanize(g)), h("span", { class: "mdm-muted" }, items.length)));
        for (const r of items.slice(0, 300)) {
          col.append(h("div", { class: "mdm-card" + (r.id === state.selected ? " on" : ""), draggable: "true", ondragstart: (e) => e.dataTransfer.setData("text/plain", r.id), onclick: () => select(r.id) },
            app.isDraft(r.id) ? h("span", { class: "mdm-draft" }, "● ") : null, r.label, v.card ? h("small", { html: v.card(r, app) }) : null));
        }
        board.append(col);
      }
      return board;
    }
    function renderTree(rs, v) {
      const ids = new Set(rs.map((r) => r.id));
      const kids = new Map();
      for (const r of rs) { const p = r.parent_id && ids.has(r.parent_id) ? r.parent_id : "_root"; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r); }
      for (const list of kids.values()) list.sort(v.sort || ((a, b) => String(a.label).localeCompare(String(b.label))));
      const open = new Set(store.get("open:" + v.id, []));
      if (state.q || Object.keys(state.facets).length) rs.forEach((r) => { let p = r.parent_id; while (p && ids.has(p)) { open.add(p); p = app.get(p).parent_id; } });
      const box = h("div", { class: "mdm-tree" });
      function ul(pid) {
        const list = kids.get(pid) || []; const u = h("ul");
        for (const r of list.slice(0, 2000)) {
          const has = kids.has(r.id); const isOpen = open.has(r.id);
          const li = h("li", {}, h("span", { class: "tw", onclick: (e) => { e.stopPropagation(); if (isOpen) open.delete(r.id); else open.add(r.id); store.set("open:" + v.id, [...open]); renderMain(); } }, has ? (isOpen ? "▾" : "▸") : "·"),
            h("span", { class: "node" + (r.id === state.selected ? " on" : ""), onclick: () => select(r.id) }, app.isDraft(r.id) ? h("span", { class: "mdm-draft" }, "●") : null, r.label,
              has ? h("span", { class: "cnt" }, kids.get(r.id).length) : null, v.nodeNote ? h("span", { class: "cnt", html: v.nodeNote(r, app) }) : null));
          if (has && isOpen) li.append(ul(r.id));
          u.append(li);
        }
        if (list.length > 2000) u.append(h("li", { class: "mdm-muted" }, `${list.length - 2000} more (use search)`));
        return u;
      }
      box.append(ul("_root"));
      return box;
    }

    // ---------------------------------------------------------------- detail
    function select(id) { state.selected = id; renderAll(); if (id && innerWidth < 900) detail.scrollIntoView({ behavior: "smooth" }); }
    function kv(obj, depth = 0) {
      const dl = h("dl", { class: "mdm-kv" });
      for (const [k, v] of Object.entries(obj || {})) {
        if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
        dl.append(h("dt", {}, humanize(k)), h("dd", {}, renderValue(v, depth, k)));
      }
      return dl;
    }
    function renderValue(v, depth, key) {
      if (Array.isArray(v)) {
        if (v.every((x) => typeof x !== "object")) return v.join(", ");
        if (key === "contact_points") return h("div", {}, v.map((c) => h("div", {}, `${humanize(c.kind)}${c.label ? " (" + c.label + ")" : ""}: `, linkify(c), c.primary ? " ★" : "")));
        return h("div", {}, v.map((x) => h("div", { class: "mdm-sub" }, typeof x === "object" ? kv(x, depth + 1) : String(x))));
      }
      if (v && typeof v === "object") { const s = fmtMoney(v) || fmtQty(v); return s ? s : depth > 3 ? JSON.stringify(v) : kv(v, depth + 1); }
      if (typeof v === "boolean") return v ? "yes" : "no";
      if (typeof v === "string" && /^https?:\/\//.test(v)) return h("a", { href: v, target: "_blank", rel: "noopener" }, v);
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return fmtDate(v);
      return String(v);
    }
    function linkify(c) {
      const v = c.value;
      if (/email/.test(c.kind)) return h("a", { href: "mailto:" + v }, v);
      if (/phone|mobile|sms|fax/.test(c.kind)) return h("a", { href: "tel:" + v.replace(/[^\d+]/g, "") }, v);
      if (/^https?:/.test(v)) return h("a", { href: v, target: "_blank", rel: "noopener" }, v);
      return v;
    }
    /** Where a record of this type is managed, when that is another app: { name, href } */
    function elsewhere(type, id) {
      const o = owners[type];
      if (!o || o.id === cfg.id || cfg.views.some((v) => v.type && vals(v.type).includes(type))) return null;
      return { name: o.name, href: ROOT + o.entry + "#id/" + encodeURIComponent(id) };
    }
    function relLink(id, text, type) {
      const r = app.get(id);
      const away = elsewhere((r && r.type) || type, id);
      if (r && !away) return h("a", { href: "#", onclick: (e) => { e.preventDefault(); goTo(id); } }, text);
      if (away) return h("span", {}, r ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); goTo(id); } }, text) : h("span", {}, text), " ", h("a", { class: "mdm-muted", href: away.href, title: "Open in " + away.name }, "↗"));
      return h("span", { class: "mdm-muted", title: "not loaded in this app" }, text);
    }
    function copyText(text, what) {
      const done = () => toast((what || "JSON") + " copied");
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
      else fallbackCopy(text, done);
    }
    function fallbackCopy(text, done) {
      const ta = h("textarea", { style: "position:fixed;left:-9999px" }, text); document.body.append(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (_) { toast("Copy blocked: select the text and press Ctrl+C"); }
      ta.remove();
    }
    app.copy = copyText;
    function goTo(id) {
      const r = app.get(id); if (!r) return;
      const v = cfg.views.find((x) => x.id === state.view);
      const fits = v && (!v.type || vals(v.type).includes(r.type)) && (!v.filter || v.filter(r, app));
      if (!fits) { const alt = cfg.views.find((x) => x.type && vals(x.type).includes(r.type) && (!x.filter || x.filter(r, app))); if (alt) state.view = alt.id; }
      select(id);
    }
    app.goTo = goTo;
    function renderDetail() {
      const r = state.selected && app.get(state.selected);
      body.classList.toggle("no-detail", !r);
      detail.innerHTML = "";
      if (!r) return;
      const c = effectiveC(r);
      detail.append(
        h("div", { style: "display:flex;justify-content:space-between;gap:8px" }, h("h2", {}, r.label), h("button", { class: "mdm-btn small", onclick: () => select(null), title: "Close (Esc)" }, "✕")),
        h("div", { class: "mdm-meta" },
          h("span", { class: "mdm-pill" }, humanize(r.type)), r.status && r.status !== "active" ? h("span", { class: "mdm-pill warn" }, r.status) : null,
          r.state ? h("span", { class: "mdm-pill" }, humanize(r.state)) : null,
          h("span", { class: "mdm-pill" }, h("span", { class: "mdm-c c" + c }, C_NAMES[c] || "C" + c)),
          app.storeOf(r) === "internal" ? h("span", { class: "mdm-pill", title: "kept in data/warehouse/internal/" }, "internal") : null,
          app.isDraft(r.id) ? h("span", { class: "mdm-pill", style: "color:var(--draft)" }, (state.originals.has(r.id) ? "edited" : "new") + ", not saved") : null,
          r.deleted_at ? h("span", { class: "mdm-pill bad" }, "deleted") : null));
      const acts = h("div", { class: "mdm-actions" });
      if (cfg.readOnly !== true) acts.append(h("button", { class: "mdm-btn primary", onclick: () => openEditor(r) }, "Edit"));
      for (const a of (cfg.actions || []).concat(currentView().actions || [])) if (!a.when || a.when(r, app)) acts.append(h("button", { class: "mdm-btn" + (a.primary ? " primary" : ""), onclick: () => a.run(r, app) }, a.label));
      if (cfg.readOnly !== true) {
        acts.append(h("button", { class: "mdm-btn", onclick: () => { const d = clone(r); d.id = uuid(); d.uri = `https://mdm.cameron-dietz.com/id/${d.type}/${d.id}`; d.label += " (copy)"; delete d.source_record_id; delete d.slug; d.created_at = nowIso(); openEditor(d, true); } }, "Duplicate"));
        acts.append(h("button", { class: "mdm-btn danger", onclick: () => { if (confirm(`Delete "${r.label}"? It stays in the file marked deleted (deleted_at), so it can be restored.`)) { const d = clone(r); d.deleted_at = nowIso(); saveDraft(d); select(null); } } }, "Delete"));
      }
      if (cfg.readOnly !== true && cfg.taxonomies !== false && taxonomy().dims.size) acts.append(h("button", { class: "mdm-btn", onclick: () => categorize([r]) }, "Categorize"));
      if (app.isDraft(r.id)) acts.append(h("button", { class: "mdm-btn", onclick: () => { if (confirm("Undo your unsaved change to this record?")) discard(r.id); } }, "Undo change"));
      const away = elsewhere(r.type, r.id);
      if (away) acts.append(h("a", { class: "mdm-btn", href: away.href }, "Open in " + away.name));
      detail.append(acts);
      if (r.summary) detail.append(h("p", {}, r.summary));
      const sec = (title, el) => { if (el) detail.append(h("div", { class: "mdm-sec" }, h("h4", {}, title), el)); };
      for (const x of (cfg.detailExtras ? vals(cfg.detailExtras(r, app)) : [])) if (x) sec(x.title, x.el);
      if (r.data && Object.keys(r.data).length) sec("Details", kv(r.data));
      if (r.category && Object.keys(r.category).length) sec("Categories", h("dl", { class: "mdm-kv" }, Object.entries(r.category).flatMap(([dim, v]) => [h("dt", {}, humanize(dim)),
        h("dd", {}, vals(v).map((x, i) => h("span", {}, i ? ", " : "", h("a", { href: "#", title: "Show every record with this value", onclick: (e) => { e.preventDefault(); state.facets["category." + dim] = x; renderMain(); } }, termLabel(dim, x) ? `${termLabel(dim, x)} (${x})` : String(x)))))])));
      if (r.identifiers && Object.keys(r.identifiers).length) sec("Identifiers", kv(r.identifiers));
      if (r.parent_id) sec("Part of", h("div", {}, relLink(r.parent_id, label(r.parent_id))));
      const outs = vals(r.relations).filter((e) => e && e.id);
      if (outs.length) sec("Links", h("div", {}, outs.map((e) => h("div", { class: "mdm-rel" }, h("span", {}, relLink(e.id, (app.get(e.id) || {}).label || e.label || e.id, e.type)), h("small", {}, humanize(e.rel) + (e.props ? " " + JSON.stringify(e.props) : ""))))));
      const ins = app.incoming(r.id);
      if (ins.length) {
        const byRel = {}; ins.forEach((x) => (byRel[x.rel] = byRel[x.rel] || []).push(x.rec));
        sec("Linked from", h("div", {}, Object.entries(byRel).map(([rel, list]) => h("div", {}, h("small", { class: "mdm-muted" }, humanize(inverseName(rel)) + ` (${list.length})`),
          list.slice(0, 50).map((x) => h("div", { class: "mdm-rel" }, relLink(x.id, x.label), h("small", {}, humanize(x.type))))))));
      }
      const kids = app.children(r.id);
      if (kids.length) sec(`Contains (${kids.length})`, h("div", {}, kids.slice(0, 60).map((k) => h("div", { class: "mdm-rel" }, relLink(k.id, k.label), h("small", {}, humanize(k.type))))));
      if (r.geo && Object.keys(r.geo).length) sec("Where", kv(Object.assign({}, r.geo.address || {}, r.geo.point ? { point: r.geo.point.join(", ") } : {})));
      if (vals(r.attachments).length) sec("Files", h("div", {}, r.attachments.map((a) => h("div", {}, h("a", { href: a.href || (ROOT + (a.path || "")), target: "_blank", rel: "noopener" }, a.label || a.path || a.href), " ", h("small", { class: "mdm-muted" }, a.role)))));
      if (r.url || vals(r.links).length) sec("Web", h("div", {}, r.url ? h("div", {}, h("a", { href: r.url, target: "_blank", rel: "noopener" }, r.url)) : null, vals(r.links).map((l) => h("div", {}, h("a", { href: l.href, target: "_blank", rel: "noopener" }, l.label || l.href), " ", h("small", { class: "mdm-muted" }, l.rel)))));
      if (r.ext && Object.keys(r.ext).length) sec("App extensions", kv(r.ext));
      if (r.metadata && Object.keys(r.metadata).length) sec("Other source fields", kv(r.metadata));
      const meta = { id: r.id, slug: r.slug, source: [r.source_system, r.source_record_id].filter(Boolean).join(" · "), created: fmtDate(r.created_at), updated: fmtDate(r.updated_at), valid: [r.valid_from && fmtDate(r.valid_from), r.valid_to && fmtDate(r.valid_to)].filter(Boolean).join(" → "), apps: vals(r.apps).join(", ") };
      sec("Record", kv(meta));
      const json = JSON.stringify(r, null, 2);
      detail.append(h("details", {}, h("summary", { class: "mdm-muted" }, "JSON"),
        h("div", { class: "mdm-actions" }, h("button", { class: "mdm-btn small", onclick: () => copyText(json) }, "Copy"), cfg.readOnly !== true ? h("button", { class: "mdm-btn small", onclick: () => openEditor(r, false, "json") }, "Edit JSON") : null),
        h("pre", { class: "mdm-json" }, json)));
    }

    // ---------------------------------------------------------------- editor
    function modal(title, bodyEl, buttons, headExtra) {
      const m = h("div", { class: "mdm-modal", onclick: (e) => { if (e.target === m) m.remove(); } });
      const d = h("div", { class: "mdm-dialog" }, h("header", {}, h("h3", {}, title), headExtra || null, h("button", { class: "mdm-btn small", onclick: () => m.remove() }, "✕")), h("div", { class: "body" }, bodyEl),
        h("footer", {}, buttons.map((b) => h("button", { class: "mdm-btn " + (b.cls || ""), onclick: () => b.run(m) }, b.label))));
      m.append(d); document.body.append(m);
      return m;
    }
    // pick(title, records, onPick, hint): a searchable list in a modal; onPick(record)
    function pick(title, records, onPick, hint) {
      const inp = h("input", { type: "search", class: "mdm-search", style: "width:100%", placeholder: "Type to filter" });
      const list = h("div", { style: "max-height:55vh;overflow:auto;margin-top:8px" });
      const draw = () => {
        const q = inp.value.trim().toLowerCase(); list.innerHTML = "";
        const hits = records.filter((r) => !q || q.split(/\s+/).every((t) => [r.label, r.type, r.summary, ...(r.aliases || [])].join(" ").toLowerCase().includes(t)));
        hits.slice(0, 200).forEach((r) => list.append(h("div", { class: "mdm-rel", style: "cursor:pointer", onclick: () => { m.remove(); onPick(r); } }, h("span", {}, r.label), h("small", {}, r._path ? `${r.type} · ${r._path}` : humanize(r.type)))));
        if (hits.length > 200) list.append(h("p", { class: "mdm-muted" }, `${hits.length - 200} more: keep typing`));
        if (!hits.length) list.append(h("p", { class: "mdm-muted" }, "Nothing matches."));
      };
      inp.addEventListener("input", draw);
      const m = modal(title, h("div", {}, hint ? h("p", { class: "mdm-muted" }, hint) : null, inp, list), [{ label: "Cancel", run: (mm) => mm.remove() }]);
      draw(); inp.focus();
    }
    function inputFor(schema, value, ctx, path) {
      const { node } = deref(schema, ctx);
      const s = node || {};
      const types = vals(s.type);
      const t = types.find((x) => x !== "null") || (s.enum ? "string" : s.properties ? "object" : null);
      const id = "f-" + path.replace(/\W/g, "_");
      if (s.const !== undefined) return { el: h("span", { class: "mdm-muted" }, String(s.const)), read: () => s.const };
      if (s.enum) {
        const sel = h("select", { id }, h("option", { value: "" }, "—"), s.enum.filter((x) => x != null).map((x) => h("option", { value: JSON.stringify(x), selected: JSON.stringify(x) === JSON.stringify(value) ? true : null }, humanize(x))));
        if (value != null && !s.enum.includes(value)) sel.append(h("option", { value: JSON.stringify(value), selected: true }, String(value) + " (not in list)"));
        return { el: sel, read: () => (sel.value ? JSON.parse(sel.value) : undefined) };
      }
      if (t === "boolean") { const cb = h("input", { type: "checkbox", id, checked: value ? true : null }); return { el: cb, read: () => cb.checked }; }
      if (t === "number" || t === "integer") {
        const inp = h("input", { type: "number", id, step: t === "integer" ? "1" : "any", value: value != null ? value : "" });
        return { el: inp, read: () => (inp.value === "" ? undefined : t === "integer" ? parseInt(inp.value, 10) : Number(inp.value)) };
      }
      if (t === "string") {
        const long = (s.maxLength || 0) > 400 || /(_md|notes|description|abstract|body|agenda|outcome|definition)$/.test(path);
        if (long) { const ta = h("textarea", { id }, value || ""); return { el: ta, read: () => ta.value }; }
        const f = s.format;
        const typ = f === "date" ? "date" : f === "date-time" ? "datetime-local" : f === "email" ? "email" : f === "uri" ? "url" : "text";
        let v = value || "";
        if (typ === "datetime-local" && v) v = String(v).replace(/Z$/, "").slice(0, 16);
        const inp = h("input", { type: typ, id, value: v });
        return { el: inp, read: () => (inp.value === "" ? undefined : typ === "datetime-local" ? new Date(inp.value).toISOString().replace(/\.\d{3}Z$/, "Z") : inp.value) };
      }
      if (t === "array") {
        const it = deref(s.items || {}, ctx);
        const itemT = vals((it.node || {}).type)[0];
        if (!it.node || itemT === "string" || itemT === "number" || (it.node.enum && !it.node.properties)) {
          const inp = h("input", { type: "text", id, value: vals(value).join(", ") });
          const help = h("small", {}, "comma-separated");
          return { el: h("div", {}, inp, help), read: () => { const xs = inp.value.split(",").map((x) => x.trim()).filter(Boolean); return itemT === "number" ? xs.map(Number) : xs; } };
        }
        if (it.node.properties) return rowsEditor(it.node, it.ctx, vals(value), path);
      }
      if (t === "object" && s.properties && Object.keys(s.properties).length) {
        const sub = objectEditor(s, ctx, value || {}, path);
        return { el: h("div", { class: "mdm-sub" }, sub.el), read: sub.read };
      }
      const ta = h("textarea", { class: "json", id }, value === undefined ? "" : JSON.stringify(value, null, 2));
      return { el: h("div", {}, ta, h("small", {}, "JSON")), read: () => { if (!ta.value.trim()) return undefined; try { return JSON.parse(ta.value); } catch (e) { throw new Error(`${path}: not valid JSON`); } } };
    }
    function objectEditor(schema, ctx, value, path) {
      const box = h("div", {});
      const readers = [];
      const known = new Set(Object.keys(schema.properties || {}));
      for (const [k, ps] of Object.entries(schema.properties || {})) {
        const { node } = deref(ps, ctx);
        const inp = inputFor(ps, value[k], ctx, path + "." + k);
        const req = (schema.required || []).includes(k);
        box.append(h("div", { class: "mdm-field" }, h("label", { title: (node && node.description) || "" }, humanize(k), req ? h("span", { class: "req" }, " *") : null), inp.el));
        readers.push([k, inp.read]);
      }
      const extra = Object.fromEntries(Object.entries(value || {}).filter(([k]) => !known.has(k)));
      let extraTa = null;
      if (Object.keys(extra).length || schema.additionalProperties !== false) {
        extraTa = h("textarea", { class: "json" }, Object.keys(extra).length ? JSON.stringify(extra, null, 2) : "");
        box.append(h("details", { open: Object.keys(extra).length ? true : null }, h("summary", { class: "mdm-muted" }, `Other fields${Object.keys(extra).length ? ` (${Object.keys(extra).length}, kept as loaded)` : ""}`), extraTa));
      }
      return {
        el: box,
        read: () => {
          const out = {};
          if (extraTa && extraTa.value.trim()) { try { Object.assign(out, JSON.parse(extraTa.value)); } catch (e) { throw new Error(`${path}: other fields are not valid JSON`); } }
          for (const [k, rd] of readers) { const v = rd(); if (v !== undefined) out[k] = v; else delete out[k]; }
          return out;
        },
      };
    }
    function rowsEditor(itemSchema, ctx, rows, path) {
      const box = h("div", { class: "mdm-rows" });
      const list = h("div", {});
      const readers = [];
      function add(v) {
        const ed = objectEditor(itemSchema, ctx, v || {}, path + "[]");
        const wrap = h("div", { class: "mdm-sub" }, ed.el);
        const entry = { read: ed.read, wrap };
        wrap.append(h("button", { class: "mdm-btn small danger", type: "button", onclick: () => { wrap.remove(); readers.splice(readers.indexOf(entry), 1); } }, "Remove"));
        readers.push(entry); list.append(wrap);
      }
      rows.forEach(add);
      box.append(list, h("button", { class: "mdm-btn small", type: "button", onclick: () => add({}) }, "+ Add"));
      return { el: box, read: () => readers.map((r) => prune(r.read())).filter((x) => x && Object.keys(x).length) };
    }
    function pairRows(obj, keyOptions, valueIsList, keyLabel, valLabel) {
      const box = h("div", { class: "mdm-rows" });
      const list = h("div", {});
      const dl = "dl-" + Math.random().toString(36).slice(2);
      box.append(h("datalist", { id: dl }, (keyOptions || []).map((k) => h("option", { value: k }))));
      function add(k, v) {
        const ki = h("input", { type: "text", list: dl, value: k || "", placeholder: keyLabel });
        const vi = h("input", { type: "text", value: valueIsList ? vals(v).join(", ") : vals(v).join(", "), placeholder: valLabel });
        const row = h("div", { class: "row" }, ki, vi, h("button", { class: "mdm-btn small danger", type: "button", onclick: () => row.remove() }, "✕"));
        row._read = () => [ki.value.trim(), vi.value.split(",").map((x) => x.trim()).filter(Boolean)];
        list.append(row);
      }
      Object.entries(obj || {}).forEach(([k, v]) => add(k, v));
      box.append(list, h("button", { class: "mdm-btn small", type: "button", onclick: () => add() }, "+ Add"));
      return { el: box, read: () => { const out = {}; [...list.children].forEach((row) => { const [k, v] = row._read(); if (k && v.length) out[k] = valueIsList ? v : (v.length === 1 ? v[0] : v); }); return out; } };
    }
    /** category editor: dimension -> value(s), with taxonomy terms and values already in use offered for each dimension */
    function categoryRows(obj) {
      const box = h("div", { class: "mdm-rows" });
      const list = h("div", {});
      const tx = taxonomy();
      const dimNames = [...new Set([...tx.dims.keys(), ...Object.keys((REG().vocabularies || {}).category_dimensions || {})])];
      const dlDim = "dl-dim-" + Math.random().toString(36).slice(2);
      box.append(h("datalist", { id: dlDim }, dimNames.map((k) => h("option", { value: k }, ((REG().vocabularies || {}).category_dimensions || {})[k] || (tx.dims.get(k) ? "taxonomy: " + tx.dims.get(k).schemes.map((x) => x.label).join(", ") : "")))));
      function optionsFor(dim, dl) {
        dl.innerHTML = "";
        const d = tx.dims.get(dim);
        const seen = new Set();
        if (d) for (const [path, t] of [...d.terms].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 3000)) { seen.add(path); dl.append(h("option", { value: path }, t.label)); }
        for (const v of usedValues(dim).slice(0, 300)) if (!seen.has(v)) dl.append(h("option", { value: v }, "in use"));
      }
      function add(k, v) {
        const dl = h("datalist", { id: "dl-val-" + Math.random().toString(36).slice(2) });
        const ki = h("input", { type: "text", list: dlDim, value: k || "", placeholder: "dimension" });
        const vi = h("input", { type: "text", list: dl.id, value: vals(v).join(", "), placeholder: "term path or value (comma-separated)" });
        const hint = h("small", { class: "mdm-muted" });
        const showHint = () => { const xs = vi.value.split(",").map((x) => x.trim()).filter(Boolean); hint.textContent = xs.map((x) => termLabel(ki.value.trim(), x) || "").filter(Boolean).join(", "); };
        ki.addEventListener("change", () => { optionsFor(ki.value.trim(), dl); showHint(); });
        vi.addEventListener("input", showHint);
        if (k) optionsFor(k, dl);
        const row = h("div", { class: "row" }, ki, vi, h("button", { class: "mdm-btn small", type: "button", title: "Pick a term", onclick: () => {
          const d = tx.dims.get(ki.value.trim());
          const pool = d ? [...d.terms].map(([path, t]) => ({ id: t.id, label: t.label, type: ki.value.trim(), summary: path, aliases: [path], _path: path })) : [];
          if (!pool.length) return toast(ki.value.trim() ? `No taxonomy for "${ki.value.trim()}": type a value` : "Pick a dimension first");
          pick("Pick a term", pool, (t) => { const xs = vi.value.split(",").map((x) => x.trim()).filter(Boolean); if (!xs.includes(t._path)) xs.push(t._path); vi.value = xs.join(", "); showHint(); });
        } }, "…"), h("button", { class: "mdm-btn small danger", type: "button", onclick: () => row.remove() }, "✕"), dl, hint);
        row._read = () => [ki.value.trim(), vi.value.split(",").map((x) => x.trim()).filter(Boolean)];
        list.append(row); showHint();
      }
      Object.entries(obj || {}).forEach(([k, v]) => add(k, v));
      box.append(list, h("button", { class: "mdm-btn small", type: "button", onclick: () => add() }, "+ Add"));
      return { el: box, read: () => { const out = {}; [...list.children].forEach((row) => { if (!row._read) return; const [k, v] = row._read(); if (k && v.length) out[k] = v.length === 1 ? v[0] : v; }); return out; } };
    }
    function relationRows(r) {
      const box = h("div", { class: "mdm-rows" });
      const list = h("div", {});
      const rels = relationVocab();
      const dlRel = "dl-rel-" + Math.random().toString(36).slice(2);
      const dlRec = "dl-rec-" + Math.random().toString(36).slice(2);
      const taxoTargets = ["taxonomy_term", "taxonomy_scheme", "mapping"].includes(r.type);
      const candidates = app.all().filter((x) => x.id !== r.id && (taxoTargets || !TAXO.includes(x.type) || vals(cfg.types).includes(x.type))).sort((a, b) => String(a.label).localeCompare(String(b.label)));
      const byKey = new Map();
      const recOpts = candidates.slice(0, 5000).map((x) => { const key = `${x.label} · ${x.type} · ${x.id.slice(0, 8)}`; byKey.set(key, x); return h("option", { value: key }); });
      box.append(h("datalist", { id: dlRel }, rels.filter((x) => x.from.includes("*") || x.from.includes(r.type)).map((x) => h("option", { value: x.rel }, x.description))), h("datalist", { id: dlRec }, recOpts));
      function add(e) {
        e = e || {};
        const ri = h("input", { type: "text", list: dlRel, value: e.rel || "", placeholder: "relation" });
        const cur = e.id ? app.get(e.id) : null;
        const ti = h("input", { type: "text", list: dlRec, value: cur ? `${cur.label} · ${cur.type} · ${cur.id.slice(0, 8)}` : e.id ? `${e.label || ""} · ${e.type || ""} · ${e.id}` : "", placeholder: "target (type to search)" });
        const pi = h("input", { type: "text", value: e.props ? JSON.stringify(e.props) : "", placeholder: 'props JSON, e.g. {"qty":4}' });
        const row = h("div", { class: "row" }, ri, ti, pi, h("button", { class: "mdm-btn small danger", type: "button", onclick: () => row.remove() }, "✕"));
        row._read = () => {
          const rel = ri.value.trim(); if (!rel) return null;
          let target = byKey.get(ti.value);
          let id = target ? target.id : (ti.value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
          if (!id) throw new Error(`relation "${rel}": pick a target from the list`);
          target = target || app.get(id);
          const out = Object.assign({}, e, { rel, id, type: target ? target.type : e.type, label: target ? target.label : e.label });
          if (pi.value.trim()) { try { out.props = JSON.parse(pi.value); } catch (_) { throw new Error(`relation "${rel}": props is not valid JSON`); } } else delete out.props;
          return prune(out);
        };
        list.append(row);
      }
      vals(r.relations).forEach(add);
      box.append(list, h("button", { class: "mdm-btn small", type: "button", onclick: () => add() }, "+ Add link"));
      return { el: box, read: () => [...list.children].map((row) => row._read()).filter(Boolean) };
    }
    function openEditor(rec, isNew, startMode) {
      const r = clone(rec);
      const tabs = h("div", { class: "mdm-tabs" });
      const formBox = h("div", { class: "mdm-form" });
      const jsonBox = h("div", { class: "mdm-form", style: "display:none" });
      const recSchema = REG().schemas["record.schema.json"] || { properties: {} };
      const envCtx = { path: "record.schema.json", sch: recSchema };
      const f = {};
      const field = (labelText, el, req, help) => h("div", { class: "mdm-field" }, h("label", {}, labelText, req ? h("span", { class: "req" }, " *") : null), h("div", {}, el, help ? h("small", {}, help) : null));
      // envelope
      const env = h("fieldset", {}, h("legend", {}, "Record"));
      f.label = h("input", { type: "text", value: r.label || "" });
      f.summary = h("textarea", {}, r.summary || "");
      f.status = inputFor(recSchema.properties.status || {}, r.status, envCtx, "status");
      f.state = h("input", { type: "text", value: r.state || "" });
      f.tags = h("input", { type: "text", value: vals(r.tags).join(", ") });
      f.url = h("input", { type: "url", value: r.url || "" });
      f.valid_from = h("input", { type: "date", value: (r.valid_from || "").slice(0, 10) });
      f.valid_to = h("input", { type: "date", value: (r.valid_to || "").slice(0, 10) });
      f.c = h("select", {}, h("option", { value: "" }, `type default (${C_NAMES[effectiveC(Object.assign({}, r, { classification: undefined, visibility: undefined }))]})`),
        C_NAMES.slice(0, ceiling + 1).map((n, i) => h("option", { value: i, selected: (r.classification || {}).c === i ? true : null }, n)));
      env.append(field("Name", f.label, true), field("Summary", f.summary), field("Status", f.status.el), field("State", f.state, false, "domain condition, e.g. in_progress, to_visit"),
        field("Tags", f.tags, false, "comma-separated, kebab-case"), field("Web address", f.url), field("Valid from", f.valid_from), field("Valid to", f.valid_to),
        field("Confidentiality", f.c, false, `this app holds up to ${C_NAMES[ceiling]}`));
      const curStore = app.storeOf(r);
      f.store = h("select", {}, ["shared", "internal"].map((x) => h("option", { value: x, selected: x === curStore ? true : null }, x === "internal" ? "internal (data/warehouse/internal/)" : "shared (data/warehouse/)")));
      env.append(field("Saved in", f.store, false, "internal = C2 and other internal-only data, published only encrypted"));
      const voc = REG().vocabularies || {};
      f.category = categoryRows(r.category);
      f.identifiers = pairRows(r.identifiers, Object.keys(voc.identifier_schemes || {}), true, "scheme", "value(s)");
      const parentOpts = app.all().filter((x) => x.type === r.type && x.id !== r.id);
      const dlp = "dl-par-" + Math.random().toString(36).slice(2);
      const pmap = new Map(parentOpts.slice(0, 5000).map((x) => [`${x.label} · ${x.id.slice(0, 8)}`, x.id]));
      const parentCur = r.parent_id && app.get(r.parent_id);
      f.parent = h("input", { type: "text", list: dlp, value: parentCur ? `${parentCur.label} · ${parentCur.id.slice(0, 8)}` : r.parent_id || "" });
      f.relations = relationRows(r);
      const links = h("fieldset", {}, h("legend", {}, "Classification, identifiers and links"),
        field("Categories", f.category.el, false, "dimension → term path or value; … picks from the taxonomy; dots for depth (engineering.mechanical)"), field("Identifiers", f.identifiers.el), field("Part of", h("div", {}, f.parent, h("datalist", { id: dlp }, [...pmap.keys()].map((k) => h("option", { value: k })))), false, "containment parent (same type)"),
        field("Links", f.relations.el, false, "relation names come from registry/vocabularies.json"));
      // payload from the type schema
      const ds = dataSchema(r.type);
      let dataEd = null;
      const dataSet = h("fieldset", {}, h("legend", {}, humanize(r.type) + " details"));
      if (ds.node && ds.node.properties) { dataEd = objectEditor(ds.node, ds.ctx, r.data || {}, "data"); dataSet.append(dataEd.el); }
      else { const ta = h("textarea", { class: "json" }, r.data ? JSON.stringify(r.data, null, 2) : ""); dataSet.append(ta, h("small", { class: "mdm-muted" }, "No type schema loaded: edit as JSON")); dataEd = { read: () => (ta.value.trim() ? JSON.parse(ta.value) : undefined) }; }
      formBox.append(env, dataSet, links);
      const jsonTa = h("textarea", { class: "json", style: "min-height:60vh" });
      jsonBox.append(h("div", { class: "mdm-actions" }, h("button", { class: "mdm-btn small", type: "button", onclick: () => copyText(jsonTa.value) }, "Copy"),
          h("button", { class: "mdm-btn small", type: "button", onclick: async () => { try { jsonTa.value = await navigator.clipboard.readText(); } catch (_) { toast("Paste blocked: click in the box and press Ctrl+V"); } } }, "Paste from clipboard")),
        jsonTa, h("small", { class: "mdm-muted" }, "The whole record. Anything valid in the master schema can be edited here; it is checked when you save."));
      let mode = "form";
      function readForm() {
        const out = clone(r);
        out.label = f.label.value.trim();
        const set = (k, v) => { if (v === undefined || v === "" || (Array.isArray(v) && !v.length) || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) delete out[k]; else out[k] = v; };
        set("summary", f.summary.value.trim()); set("status", f.status.read()); set("state", f.state.value.trim());
        set("tags", f.tags.value.split(",").map((x) => x.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean)); set("url", f.url.value.trim());
        set("valid_from", f.valid_from.value ? f.valid_from.value + "T00:00:00Z" : undefined); set("valid_to", f.valid_to.value ? f.valid_to.value + "T00:00:00Z" : undefined);
        const cl = Object.assign({}, r.classification || {}); if (f.c.value === "") delete cl.c; else cl.c = parseInt(f.c.value, 10); set("classification", cl);
        set("category", f.category.read()); set("identifiers", f.identifiers.read());
        const pv = f.parent.value.trim(); set("parent_id", pv ? pmap.get(pv) || (pv.match(/[0-9a-f-]{36}/i) || [])[0] : undefined);
        set("relations", f.relations.read());
        set("data", prune(dataEd.read() || {}));
        return out;
      }
      function show(m) {
        try {
          if (m === "json" && mode === "form") jsonTa.value = JSON.stringify(readForm(), null, 2);
          if (m === "form" && mode === "json") { const parsed = JSON.parse(jsonTa.value); modalEl.remove(); openEditor(parsed, isNew); return; }
          if (m === "json" && mode === "json") jsonTa.value = JSON.stringify(r, null, 2);
        } catch (e) { toast(e.message); return; }
        mode = m; formBox.style.display = m === "form" ? "" : "none"; jsonBox.style.display = m === "json" ? "" : "none";
        [...tabs.children].forEach((b) => b.classList.toggle("on", b.dataset.m === m));
      }
      tabs.append(h("button", { class: "on", "data-m": "form", onclick: () => show("form") }, "Form"), h("button", { "data-m": "json", onclick: () => show("json") }, "JSON"));
      const modalEl = modal((isNew ? "New " : "Edit ") + humanize(r.type), h("div", {}, formBox, jsonBox), [
        { label: "Cancel", run: (m) => m.remove() },
        { label: "Save", cls: "primary", run: (m) => {
          let out;
          try { out = mode === "json" ? JSON.parse(jsonTa.value) : readForm(); } catch (e) { return toast(e.message); }
          if (!out.label) return toast("Name is required");
          if (!out.id || !out.type) return toast("id and type are required");
          if (effectiveC(out) > ceiling) return toast(`This app holds up to ${C_NAMES[ceiling]}; lower the confidentiality or use an app with a higher ceiling`);
          if (cfg.beforeSave) { const msg = cfg.beforeSave(out, app); if (msg) return toast(msg); }
          out = prune(out);
          const errs = Store ? Store.validate(out) : [];
          if (errs.length && !confirm(`The schema check found ${errs.length} problem${errs.length === 1 ? "" : "s"}:\n\n${errs.slice(0, 10).join("\n")}\n\nSave anyway?`)) return;
          m.remove(); saveDraft(out, { store: f.store.value }); state.selected = out.id; renderAll();
        } },
      ], tabs);
      if (startMode === "json") show("json");
    }

    // ---------------------------------------------------------------- panels
    /** Files: what is loaded, what is unsaved; download a file, view or edit its raw JSON, connect or disconnect the folder. */
    function fileRecords(key) {
      const f = state.files.get(key);
      const m = new Map(f ? f.all : []);
      for (const r of state.drafts.values()) if (fileKey(r.type, app.storeOf(r)) === key) m.set(r.id, r);
      for (const [id, from] of moves) if (fileKey((app.get(id) || {}).type, from) === key) m.delete(id);
      return [...m.values()];
    }
    function showFiles() {
      const keys = new Set(state.files.keys());
      for (const r of state.drafts.values()) keys.add(fileKey(r.type, app.storeOf(r)));
      const connected = state.folder === "connected";
      const rows = [...keys].sort().map((key) => {
        const [st, type] = key.split("/");
        const f = state.files.get(key);
        const unsaved = [...state.drafts.values()].filter((r) => fileKey(r.type, app.storeOf(r)) === key).length;
        const name = (st === "internal" ? "internal/" : "") + type + ".json";
        const complete = !f || f.complete;
        return h("div", { class: "mdm-rel" },
          h("span", {}, h("b", {}, name), " ", h("small", { class: "mdm-muted" }, `${fileRecords(key).length.toLocaleString()} records${unsaved ? ` · ${unsaved} unsaved` : ""}${complete ? "" : " · partial (from a mart or the repo)"}`)),
          h("span", {},
            h("button", { class: "mdm-btn small", onclick: () => rawFile(key) }, "Raw JSON"), " ",
            complete ? h("button", { class: "mdm-btn small", onclick: () => download(name.replace("/", "-"), JSON.stringify(Store.collection(type, fileRecords(key), st, (f || {}).meta), null, 2)) }, "Download")
              : h("button", { class: "mdm-btn small", disabled: !unsaved, title: "This app only has part of the file: download just the changed records, then Import them in an app connected to the folder", onclick: () => download(`${type}-changes.json`, JSON.stringify({ items: [...state.drafts.values()].filter((r) => r.type === type) }, null, 2)) }, "Download changes")));
      });
      const intro = connected
        ? `Saving straight to <code>${esc(Store.status().label)}</code>. Each save rewrites that type's file and keeps the version it replaced as <code>_&lt;type&gt;.prev.json</code>.`
        : `No folder connected, so changes stay in this browser. ${canFolder && state.folder !== "unsupported" ? "<b>Connect folder</b> to save straight to the warehouse, or " : ""}download a file and put it in <code>data/warehouse/</code> (internal files in <code>data/warehouse/internal/</code>).`;
      const btns = [{ label: "Close", run: (mm) => mm.remove() }];
      if (connected) btns.unshift({ label: "Disconnect folder", run: async (mm) => { await Store.disconnect(); state.folder = "none"; mm.remove(); toast("Folder disconnected"); renderAll(); } }, { label: "Reload from folder", run: async (mm) => { mm.remove(); await loadFromFolder(); toast("Reloaded"); } });
      else if (canFolder && state.folder !== "unsupported") btns.unshift({ label: state.folder === "prompt" ? "Reconnect folder" : "Connect folder", cls: "primary", run: (mm) => { mm.remove(); connectFolder(); } });
      if (state.drafts.size && !connected) btns.unshift({ label: "Download all changes", run: () => download(`${cfg.id}-changes.json`, JSON.stringify({ items: [...state.drafts.values()] }, null, 2)) });
      modal("Files", h("div", {}, h("p", { class: "mdm-muted", html: intro }), rows.length ? h("div", {}, rows) : h("p", { class: "mdm-muted" }, "No files loaded yet.")), btns);
    }
    /** The whole file as JSON: copy it, or edit it and apply (replaces that file's records). */
    function rawFile(key) {
      const [st, type] = key.split("/");
      const f = state.files.get(key);
      const ta = h("textarea", { class: "json", style: "min-height:60vh;width:100%" }, JSON.stringify(Store ? Store.collection(type, fileRecords(key), st, (f || {}).meta) : { items: fileRecords(key) }, null, 2));
      modal(`Raw JSON: ${st === "internal" ? "internal/" : ""}${type}.json`, h("div", {}, ta, h("small", { class: "mdm-muted" }, "Apply replaces every record in this file with what is in the box (records you remove are removed from the file).")), [
        { label: "Close", run: (mm) => mm.remove() },
        { label: "Copy", run: () => copyText(ta.value) },
        cfg.readOnly !== true ? { label: "Apply", cls: "primary", run: async (mm) => {
          let doc; try { doc = JSON.parse(ta.value); } catch (e) { return toast("Not valid JSON: " + e.message); }
          const items = recordsOf(doc).filter((r) => r && r.id);
          if (items.some((r) => r.type !== type)) return toast(`Every record in this file must have type "${type}"`);
          const problems = items.map((r) => [r, Store ? Store.validate(r) : []]).filter(([, e]) => e.length);
          if (problems.length && !confirm(`Schema check found problems in ${problems.length} record(s):\n\n${problems.slice(0, 8).map(([r, e]) => `${r.label || r.id}: ${e[0]}`).join("\n")}\n\nApply anyway?`)) return;
          const before = fileRecords(key); const keep = new Set(items.map((r) => r.id));
          if (!confirm(`Replace ${before.length} records with ${items.length}? ${before.filter((r) => !keep.has(r.id)).length} will be removed from the file.`)) return;
          for (const r of before) if (!keep.has(r.id)) { state.originals.delete(r.id); state.drafts.delete(r.id); if (f) f.all.delete(r.id); }
          if (f) for (const id of [...f.all.keys()]) if (!keep.has(id)) f.all.delete(id);
          const file = f || { type, store: st, all: new Map(), meta: {}, complete: true };
          state.files.set(key, file);
          for (const r of items) { state.home.set(r.id, st); state.drafts.set(r.id, r); }
          persistDrafts(); mm.remove(); refresh();
          if (state.folder === "connected") { file.all = new Map(items.map((r) => [r.id, r])); await flush(); }
          else toast("Applied in this browser. Download the file or connect the folder to save it.");
        } } : null,
      ].filter(Boolean));
    }
    function showPaste() {
      const ta = h("textarea", { class: "json", style: "min-height:45vh;width:100%", placeholder: '{ "type": "person", "label": "…" }   or   [ {…}, {…} ]   or a whole warehouse file' });
      modal("Paste JSON", h("div", {}, h("p", { class: "mdm-muted" }, "Paste one record, a list of records, or a whole file. Records with an id that already exists are replaced; records without an id are added as new. Each one is checked against the schema."), ta), [
        { label: "Cancel", run: (mm) => mm.remove() },
        { label: "Paste from clipboard", run: async () => { try { ta.value = await navigator.clipboard.readText(); } catch (_) { toast("Paste blocked: click in the box and press Ctrl+V"); } } },
        { label: "Add / update", cls: "primary", run: (mm) => {
          let doc; try { doc = JSON.parse(ta.value); } catch (e) { return toast("Not valid JSON: " + e.message); }
          try { const n = upsertParsed(doc); if (n) { mm.remove(); toast(`${n} record${n === 1 ? "" : "s"} added or updated${state.folder === "connected" ? "" : " in this browser"}`); } } catch (e) { toast(e.message); }
        } },
      ]);
      ta.focus();
    }
    function showDataPanel() {
      const counts = {};
      for (const r of app.all()) counts[r.type] = (counts[r.type] || 0) + 1;
      const policy = cfg.policyUrl || "../docs/governance/DATA-GOVERNANCE.md";
      const levels = ((REG().classification || {}).confidentiality || []);
      const old = store.get("drafts", {});
      const body = h("div", {},
        kv({ app: `${cfg.title} (${cfg.id})`, source: state.source, folder: state.folder === "connected" ? Store.status().label : state.folder, "as of": state.generated ? fmtDate(state.generated) : state.folder === "connected" ? "live files" : "unknown", "schema version": (REG().schema_version || "?") + " (app built for " + SCHEMA_VERSION + ")",
          ceiling: `${C_NAMES[ceiling]}: records above it are never shown here (they stay in the files untouched)`, "left out (above ceiling)": state.hiddenAboveCeiling, "unsaved changes": state.drafts.size }),
        h("div", { class: "mdm-sec" }, h("h4", {}, "Records loaded"), kv(counts)),
        Object.keys(old).length ? h("div", { class: "mdm-sec" }, h("h4", {}, "Old drafts"), h("p", { class: "mdm-muted" }, `${Object.keys(old).length} drafts from the earlier changeset version of this app are still in this browser.`),
          h("button", { class: "mdm-btn small", onclick: () => { if (!confirm("Load them as unsaved changes? With the folder connected they are written to the files.")) return; Object.values(old).forEach((r) => saveDraft(r, { silent: true, defer: true })); store.set("drafts", {}); refresh(); flush(); } }, "Load as changes"), " ",
          h("button", { class: "mdm-btn small", onclick: () => download(`${cfg.id}-old-drafts.json`, JSON.stringify({ items: Object.values(old) }, null, 2)) }, "Download"), " ",
          h("button", { class: "mdm-btn small danger", onclick: () => { if (confirm("Throw the old drafts away?")) { store.set("drafts", {}); toast("Old drafts removed"); } } }, "Remove")) : null,
        levels.length ? h("div", { class: "mdm-sec" }, h("h4", {}, "Confidentiality levels"), h("div", {}, levels.slice(0, ceiling + 2).map((l) => h("div", {}, h("span", { class: "mdm-c c" + l.level }, `C${l.level} ${l.name || ""}`), " ", h("small", { class: "mdm-muted" }, l.summary || l.description || ""))))) : null,
        h("p", {}, h("a", { href: policy, target: "_blank" }, "Data governance policy"), " · ", h("a", { href: "../registry/index.html", target: "_blank" }, "Registry")));
      modal("Data and governance", body, [
        { label: "Lock encrypted data", run: (m) => { if (root.MDMClient) MDMClient.create(cfg.client || {}).lock(); toast("Encrypted data keys cleared for this tab"); m.remove(); } },
        { label: "Close", cls: "primary", run: (m) => m.remove() }]);
    }
    let toastTimer;
    function toast(msg) {
      document.querySelectorAll(".mdm-toast").forEach((t) => t.remove());
      const t = h("div", { class: "mdm-toast" }, msg); document.body.append(t);
      clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 4200);
    }

    fromHash();
    load();
    root.mdmApp = app; // handy from the console
    return app;
  }

  root.MDMApp = { start, effectiveC, typeSchema, dataSchema, deref, esc, version: SCHEMA_VERSION };
})(typeof window !== "undefined" ? window : globalThis);
