/*
 * mdm-taxonomy.js - shared taxonomy helpers for apps built on mdm-app.js.
 *
 *   <script src="../../repo/lib/mdm-taxonomy.js"></script>    (after mdm-app.js)
 *
 *   MDMTaxonomy.browser(box, app, { storageKey })   term browser: tree + list, search, scheme / status / level
 *                                                   filters. Only the rows on screen are in the page, so a
 *                                                   fully expanded ETIM tree stays fast.
 *   MDMTaxonomy.attributeIndex(app)                 lookups for the functions below
 *   MDMTaxonomy.resolveAttributes(term, ix)         a term's own + inherited attributes
 *   MDMTaxonomy.attributesPanel(term, app, ix)      the same as a detail-panel section
 *
 * Attributes are taxonomy terms in the `attributes` scheme (data.attribute_def). Their key is the snake_case
 * data.path_segment (record slugs are kebab-case only). A term lists the ones it uses in
 * data.attributes [{key, required, facet, order, source, exclude, unit}]. Inheritance, in order:
 *   1. the parent term's resolved attributes
 *   2. ETIM classes mapped to this term (a mapping record: source = ETIM group or class, target = this term)
 *   3. the term's own entries; { key, exclude: true } drops an inherited attribute here and below
 *
 * No dependencies beyond the app object mdm-app.js passes in.
 */
(function (root) {
  "use strict";

  const ROW_H = 30, OVERSCAN = 12, ATTR_SCHEME = "attributes";
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const dataOf = (t) => t.data || {};
  const statusOf = (t) => t.status || "active";
  const hayCache = new WeakMap();

  /** Lowercase search text of a term: label, notation, path, slug, aliases, identifiers. */
  function hay(t) {
    let s = hayCache.get(t);
    if (s === undefined) {
      const d = dataOf(t);
      s = [t.label, d.notation, d.path, t.slug, ...(t.aliases || []), ...Object.values(t.identifiers || {}).flat()].filter(Boolean).join(" ").toLowerCase();
      hayCache.set(t, s);
    }
    return s;
  }
  const bySibling = (a, b) => (dataOf(a).order ?? 1e9) - (dataOf(b).order ?? 1e9) || collator.compare(String(a.label), String(b.label));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage full or blocked */ } };

  // ------------------------------------------------------------------ term browser
  // State lives outside the DOM because the shell rebuilds the main panel whenever a record is selected.
  const browsers = new Map();
  function uiFor(key) {
    if (!browsers.has(key)) {
      const saved = lsGet(key, {});
      browsers.set(key, { scheme: saved.scheme || "", status: saved.status || "", level: saved.level || "", mode: saved.mode || "tree", sort: saved.sort || { col: "path", dir: 1 },
        open: new Set(saved.open || []), openOver: new Set(), closeOver: new Set(), filterKey: "", scrollTop: 0, lastSel: null });
    }
    return browsers.get(key);
  }

  function highlight(h, text, toks) {
    const s = String(text == null ? "" : text);
    if (!toks.length) return s;
    const re = new RegExp("(" + toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "ig");
    return s.split(re).map((part, i) => (i % 2 ? h("mark", {}, part) : part)).filter((p) => p !== "");
  }

  function browser(box, app, opts) {
    const h = app.h, key = (opts && opts.storageKey) || "mdm-taxonomy:browser", ui = uiFor(key);
    const save = () => lsSet(key, { scheme: ui.scheme, status: ui.status, level: ui.level, mode: ui.mode, sort: ui.sort, open: [...ui.open] });
    const terms = app.byType("taxonomy_term");
    if (!terms.length) {
      box.append(h("div", { class: "mdm-empty" }, h("p", {}, h("b", {}, "No terms loaded.")), h("p", {}, "Click Connect folder and pick the MASTER folder, or Import data/warehouse/taxonomy_term.json.")));
      return;
    }
    const schemeRecs = app.byType("taxonomy_scheme");
    const schemeLabel = (slug) => (schemeRecs.find((s) => s.slug === slug) || {}).label || slug || "(no scheme)";

    // structure: children of each term (a parent that is missing or in another scheme makes it a root of its scheme)
    const byId = new Map(terms.map((t) => [t.id, t]));
    const kids = new Map(), roots = new Map(), bySchemeCount = new Map();
    for (const t of terms) {
      const s = dataOf(t).scheme || "";
      bySchemeCount.set(s, (bySchemeCount.get(s) || 0) + 1);
      const p = t.parent_id && byId.get(t.parent_id);
      if (p && (dataOf(p).scheme || "") === s && p.id !== t.id) { if (!kids.has(p.id)) kids.set(p.id, []); kids.get(p.id).push(t); }
      else { if (!roots.has(s)) roots.set(s, []); roots.get(s).push(t); }
    }
    for (const list of kids.values()) list.sort(bySibling);
    for (const list of roots.values()) list.sort(bySibling);
    const totals = new Map();
    const total = (id, guard) => {
      if (totals.has(id)) return totals.get(id);
      guard = guard || new Set(); if (guard.has(id)) return 0; guard.add(id);
      let n = 0; for (const k of kids.get(id) || []) n += 1 + total(k.id, guard);
      totals.set(id, n); return n;
    };

    // ---- toolbar
    const schemes = [...bySchemeCount.keys()].sort((a, b) => collator.compare(schemeLabel(a), schemeLabel(b)));
    if (ui.scheme && !bySchemeCount.has(ui.scheme)) ui.scheme = "";
    const select = (label, value, options, onchange) => h("label", { class: "mdm-tx-field" }, h("span", {}, label),
      h("select", { onchange: (e) => { onchange(e.target.value); ui.scrollTop = 0; save(); recompute(); paint(); drawTools(); } }, options.map(([v, text]) => h("option", { value: v, selected: v === value ? true : null }, text))));
    const toolsEl = h("div", { class: "mdm-tx-tools" });
    const headEl = h("div", { class: "mdm-tx-listhead" });
    const scroller = h("div", { class: "mdm-tx-scroll", tabindex: "0", onscroll: () => { if (!scroller.isConnected) return; ui.scrollTop = scroller.scrollTop; schedule(); } });
    const spacer = h("div", { class: "mdm-tx-spacer" }), win = h("div", { class: "mdm-tx-win" });
    spacer.append(win); scroller.append(spacer);
    box.append(toolsEl, headEl, scroller);

    let toks = [], filtering = false, shown = null, matched = null, auto = new Set(), rows = [], listScope = [];
    const levelOf = (t) => Number(dataOf(t).level || 0);

    function drawTools() {
      const scope = ui.scheme ? terms.filter((t) => (dataOf(t).scheme || "") === ui.scheme) : terms;
      const statuses = [...new Set(scope.map(statusOf))].sort();
      const levels = [...new Set(scope.map(levelOf))].sort((a, b) => a - b);
      const seg = (m, text) => h("button", { class: "mdm-btn small" + (ui.mode === m ? " primary" : ""), "aria-pressed": ui.mode === m ? "true" : "false", onclick: () => { ui.mode = m; ui.scrollTop = 0; save(); recompute(); paint(); drawTools(); } }, text);
      const summary = matched ? `${matched.size.toLocaleString()} of ${scope.length.toLocaleString()} terms` : `${scope.length.toLocaleString()} terms`;
      toolsEl.replaceChildren(...[
        select("Scheme", ui.scheme, [["", `All schemes (${terms.length.toLocaleString()})`]].concat(schemes.map((s) => [s, `${schemeLabel(s)} (${bySchemeCount.get(s).toLocaleString()})`])), (v) => { ui.scheme = v; ui.status = ""; ui.level = ""; }),
        select("Status", ui.status, [["", "Any"]].concat(statuses.map((s) => [s, s])), (v) => { ui.status = v; }),
        select("Level", ui.level, [["", "Any"]].concat(levels.map((l) => [String(l), l === 0 ? "0 (top)" : String(l)])), (v) => { ui.level = v; }),
        h("span", { class: "mdm-tx-seg" }, seg("tree", "Tree"), seg("list", "List")),
        ui.mode === "tree" ? h("button", { class: "mdm-btn small", onclick: expandAll, title: "Open every branch" }, "Expand all") : null,
        ui.mode === "tree" ? h("button", { class: "mdm-btn small", onclick: collapseAll }, "Collapse all") : null,
        filtering ? h("button", { class: "mdm-btn small", onclick: clearFilters }, "Clear filters") : null,
        h("span", { class: "mdm-muted mdm-tx-sum", role: "status" }, summary + (toks.length ? " · searching label, notation and path" : ""))].filter(Boolean));
    }
    function clearFilters() {
      ui.status = ""; ui.level = "";
      if (app.state.q) { app.state.q = ""; const s = document.querySelector(".mdm-search"); if (s) s.value = ""; }
      ui.scrollTop = 0; save(); recompute(); paint(); drawTools();
    }

    // ---- filtering
    function recompute() {
      toks = String(app.state.q || "").toLowerCase().split(/\s+/).filter(Boolean);
      const lv = ui.level === "" ? null : Number(ui.level);
      filtering = !!(toks.length || ui.status || lv != null);
      const fk = [toks.join(" "), ui.status, ui.level, ui.scheme].join("\u0000");
      if (fk !== ui.filterKey) { ui.filterKey = fk; ui.openOver.clear(); ui.closeOver.clear(); }
      const scope = ui.scheme ? terms.filter((t) => (dataOf(t).scheme || "") === ui.scheme) : terms;
      const M = scope.filter((t) => (!ui.status || statusOf(t) === ui.status) && (lv == null || levelOf(t) === lv) && (!toks.length || toks.every((x) => hay(t).includes(x))));
      listScope = M;
      matched = filtering ? new Set(M.map((t) => t.id)) : null;
      shown = null; auto = new Set();
      if (filtering) {
        shown = new Set(matched);
        for (const t of M) {
          auto.add("scheme:" + (dataOf(t).scheme || ""));
          let p = t.parent_id && byId.get(t.parent_id), guard = 0;
          while (p && guard++ < 64) { shown.add(p.id); auto.add(p.id); p = p.parent_id && byId.get(p.parent_id); }
        }
        if (toks.length && lv == null) {  // a matching term's children stay reachable (collapsed) under it
          const walk = (id) => { for (const k of kids.get(id) || []) if ((!ui.status || statusOf(k) === ui.status) && !shown.has(k.id)) { shown.add(k.id); walk(k.id); } };
          for (const t of M) walk(t.id);
        }
      }
      rows = ui.mode === "list" ? listRows() : treeRows();
      spacer.style.height = rows.length * ROW_H + "px";
      drawHead();
    }
    const isOpen = (id) => (filtering ? (auto.has(id) && !ui.closeOver.has(id)) || ui.openOver.has(id) : ui.open.has(id));
    const visibleKids = (id) => { const k = kids.get(id) || []; return shown ? k.filter((x) => shown.has(x.id)) : k; };
    function treeRows() {
      const out = [];
      const walk = (list, depth, seen) => {
        for (const t of list) {
          if (seen.has(t.id)) continue; seen.add(t.id);
          const vis = visibleKids(t.id), open = vis.length > 0 && isOpen(t.id);
          out.push({ t, depth, has: vis.length > 0, open, vis: vis.length });
          if (open && depth < 64) walk(vis, depth + 1, seen);
        }
      };
      const seen = new Set();
      const slugs = ui.scheme ? [ui.scheme] : schemes;
      for (const s of slugs) {
        const list = (roots.get(s) || []).filter((t) => !shown || shown.has(t.id));
        if (!list.length) continue;
        if (ui.scheme) { walk(list, 0, seen); continue; }
        const sid = "scheme:" + s, open = isOpen(sid);
        out.push({ scheme: s, sid, depth: 0, has: true, open, vis: list.length, n: bySchemeCount.get(s) });
        if (open) walk(list, 1, seen);
      }
      return out;
    }
    const COLS = [
      { id: "label", label: "Term", get: (t) => t.label }, { id: "scheme", label: "Scheme", get: (t) => schemeLabel(dataOf(t).scheme) },
      { id: "notation", label: "Notation", get: (t) => dataOf(t).notation || "" }, { id: "path", label: "Path", get: (t) => dataOf(t).path || "" },
      { id: "level", label: "Level", get: levelOf, num: true }, { id: "status", label: "Status", get: statusOf },
    ];
    function listRows() {
      const c = COLS.find((x) => x.id === ui.sort.col) || COLS[3], dir = ui.sort.dir;
      return [...listScope].sort((a, b) => (c.num ? c.get(a) - c.get(b) : collator.compare(String(c.get(a)), String(c.get(b)))) * dir || collator.compare(String(a.label), String(b.label))).map((t) => ({ t, list: true }));
    }
    function drawHead() {
      headEl.style.display = ui.mode === "list" ? "" : "none";
      if (ui.mode !== "list") return;
      headEl.replaceChildren(...COLS.map((c) => h("button", { class: c.num ? "num" : "", onclick: () => { ui.sort = { col: c.id, dir: ui.sort.col === c.id ? -ui.sort.dir : 1 }; ui.scrollTop = 0; scroller.scrollTop = 0; save(); recompute(); paint(); } },
        c.label + (ui.sort.col === c.id ? (ui.sort.dir > 0 ? " ▲" : " ▼") : ""))));
    }

    // ---- expand / collapse
    function toggle(id) {
      if (filtering) { if (isOpen(id)) { ui.closeOver.add(id); ui.openOver.delete(id); } else { ui.openOver.add(id); ui.closeOver.delete(id); } }
      else { if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id); save(); }
      recompute(); paint();
    }
    function allParents() {
      const ids = schemes.filter((s) => !ui.scheme || s === ui.scheme).map((s) => "scheme:" + s);
      for (const [id, list] of kids) if (list.length && (!ui.scheme || (dataOf(byId.get(id)).scheme || "") === ui.scheme)) ids.push(id);
      return ids;
    }
    function expandAll() { if (filtering) { ui.closeOver.clear(); allParents().forEach((id) => ui.openOver.add(id)); } else { allParents().forEach((id) => ui.open.add(id)); save(); } recompute(); paint(); }
    function collapseAll() {
      if (filtering) { ui.openOver.clear(); auto.forEach((id) => ui.closeOver.add(id)); }
      else { if (ui.scheme) allParents().forEach((id) => ui.open.delete(id)); else ui.open.clear(); save(); }
      ui.scrollTop = 0; scroller.scrollTop = 0; recompute(); paint();
    }

    // ---- drawing: only the rows in view exist in the page
    function drawRow(r) {
      if (r.scheme !== undefined) {
        return h("div", { class: "mdm-tx-row scheme", onclick: () => toggle(r.sid) },
          h("button", { class: "tw", "aria-expanded": r.open ? "true" : "false", "aria-label": (r.open ? "Collapse " : "Expand ") + schemeLabel(r.scheme) }, r.open ? "▾" : "▸"),
          h("span", { class: "lbl" }, schemeLabel(r.scheme)), h("span", { class: "cnt", title: `${r.n.toLocaleString()} terms in this scheme` }, r.n.toLocaleString()));
      }
      const t = r.t, d = dataOf(t), on = app.state.selected === t.id, draft = app.isDraft(t.id);
      if (r.list) {
        return h("div", { class: "mdm-tx-row list" + (on ? " on" : ""), onclick: () => app.select(t.id) },
          h("span", { class: "lbl" }, draft ? h("span", { class: "mdm-draft" }, "● ") : null, highlight(h, t.label, toks)),
          h("span", { class: "mdm-muted" }, schemeLabel(d.scheme)), h("code", {}, highlight(h, d.notation || "", toks)), h("code", { title: d.path || "" }, highlight(h, d.path || "", toks)),
          h("span", { class: "num" }, levelOf(t)), h("span", {}, statusOf(t)));
      }
      const all = (kids.get(t.id) || []).length, tot = all ? total(t.id) : 0, dim = matched && !matched.has(t.id);
      return h("div", { class: "mdm-tx-row" + (on ? " on" : "") + (dim ? " dim" : ""), style: `padding-left:${6 + r.depth * 18}px`, onclick: () => app.select(t.id) },
        h("button", { class: "tw", disabled: r.has ? null : true, "aria-expanded": r.has ? (r.open ? "true" : "false") : null, "aria-label": r.has ? (r.open ? "Collapse " : "Expand ") + t.label : null, onclick: (e) => { e.stopPropagation(); if (r.has) toggle(t.id); } }, r.has ? (r.open ? "▾" : "▸") : "·"),
        draft ? h("span", { class: "mdm-draft" }, "●") : null,
        h("span", { class: "lbl" }, highlight(h, t.label, toks)),
        d.notation && d.notation !== t.slug ? h("code", {}, highlight(h, d.notation, toks)) : null,
        all ? h("span", { class: "cnt", title: `${all.toLocaleString()} direct, ${tot.toLocaleString()} in total` }, filtering && r.vis !== all ? `${r.vis}/${all}` : all.toLocaleString()) : null,
        statusOf(t) !== "active" ? h("span", { class: "mdm-pill warn" }, statusOf(t)) : null);
    }
    function paint() {
      const view = scroller.clientHeight || 600;
      const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - OVERSCAN);
      const last = Math.min(rows.length, Math.ceil((scroller.scrollTop + view) / ROW_H) + OVERSCAN);
      win.style.transform = `translateY(${first * ROW_H}px)`;
      win.replaceChildren(...rows.slice(first, last).map(drawRow));
      if (!rows.length) win.replaceChildren(h("div", { class: "mdm-tx-none" }, "Nothing matches these filters."));
    }
    let queued = false;
    function schedule() { if (queued) return; queued = true; setTimeout(() => { queued = false; paint(); }, 16); }

    // ---- first draw; a term picked from a link elsewhere is opened and scrolled into view
    recompute();
    const sel = app.state.selected;
    let target = null;
    if (sel && sel !== ui.lastSel && byId.has(sel) && (!ui.scheme || (dataOf(byId.get(sel)).scheme || "") === ui.scheme)) {
      if (ui.mode === "tree" && !filtering) {
        const t = byId.get(sel); ui.open.add("scheme:" + (dataOf(t).scheme || ""));
        let p = t.parent_id && byId.get(t.parent_id), guard = 0;
        while (p && guard++ < 64) { ui.open.add(p.id); p = p.parent_id && byId.get(p.parent_id); }
        save(); recompute();
      }
      target = rows.findIndex((r) => r.t && r.t.id === sel);
    }
    ui.lastSel = sel;
    drawTools();
    scroller.scrollTop = ui.scrollTop;
    if (target != null && target >= 0) {
      const y = target * ROW_H, view = scroller.clientHeight || 600;
      if (y < scroller.scrollTop || y > scroller.scrollTop + view - ROW_H) scroller.scrollTop = ui.scrollTop = Math.max(0, y - view / 3);
    }
    paint();
  }

  // ------------------------------------------------------------------ attributes
  /** Lookups used by resolveAttributes. Build once per detail view. */
  function attributeIndex(app) {
    const terms = app.byType("taxonomy_term");
    const byId = new Map(terms.map((t) => [t.id, t]));
    const byKey = new Map(), kids = new Map(), usedBy = new Map(), sources = new Map();
    for (const t of terms) {
      const d = dataOf(t);
      if (d.scheme === ATTR_SCHEME && (d.path_segment || t.slug)) byKey.set(d.path_segment || t.slug, t);
      if (t.parent_id) { if (!kids.has(t.parent_id)) kids.set(t.parent_id, []); kids.get(t.parent_id).push(t); }
      for (const a of d.attributes || []) if (a && a.key && !a.exclude) usedBy.set(a.key, (usedBy.get(a.key) || 0) + 1);
    }
    for (const m of app.byType("mapping")) {
      const rels = m.relations || [];
      const src = rels.find((e) => e.rel === "source"), tgt = rels.find((e) => e.rel === "target");
      if (src && tgt && byId.has(src.id) && byId.has(tgt.id)) { if (!sources.has(tgt.id)) sources.set(tgt.id, []); sources.get(tgt.id).push(byId.get(src.id)); }
    }
    return { byId, byKey, kids, usedBy, sources, memo: new Map() };
  }
  /** The terms carrying attributes at or under a mapped ETIM term. */
  function carriers(t, ix, out, guard) {
    out = out || []; guard = guard || new Set();
    if (guard.has(t.id)) return out; guard.add(t.id);
    if ((dataOf(t).attributes || []).length) out.push(t);
    for (const k of ix.kids.get(t.id) || []) carriers(k, ix, out, guard);
    return out;
  }
  /** { effective, own, inherited, excluded }, each entry { key, required, facet, order, source, unit, from } */
  function resolveAttributes(term, ix, depth) {
    if (ix.memo.has(term.id)) return ix.memo.get(term.id);
    const map = new Map();
    ix.memo.set(term.id, { effective: [], own: [], inherited: [], excluded: [] });  // cycle guard
    const parent = term.parent_id && ix.byId.get(term.parent_id);
    if (parent && (depth || 0) < 64) for (const e of resolveAttributes(parent, ix, (depth || 0) + 1).effective) map.set(e.key, Object.assign({}, e, { from: e.from.kind === "own" ? { kind: "parent", term: parent } : e.from }));
    for (const src of ix.sources.get(term.id) || []) {
      const classes = carriers(src, ix);
      const seen = new Map();
      for (const c of classes) for (const a of dataOf(c).attributes) {
        if (!a || !a.key || a.exclude) continue;
        if (!seen.has(a.key)) seen.set(a.key, { key: a.key, n: 0, req: 0, facet: false, order: a.order ?? 1e9, source: a.source, unit: a.unit });
        const s = seen.get(a.key); s.n++; if (a.required) s.req++; if (a.facet) s.facet = true; s.order = Math.min(s.order, a.order ?? 1e9);
      }
      for (const s of seen.values()) if (!map.has(s.key)) map.set(s.key, { key: s.key, required: s.req === classes.length, facet: s.facet, order: s.order, source: s.source, unit: s.unit, from: { kind: "mapped", term: src, classes: s.n, of: classes.length } });
    }
    const own = [], excluded = [];
    for (const a of dataOf(term).attributes || []) {
      if (!a || !a.key) continue;
      if (a.exclude) { map.delete(a.key); excluded.push(a.key); continue; }
      map.set(a.key, Object.assign({}, map.get(a.key) || {}, a, { from: { kind: "own" } }));
      own.push(a.key);
    }
    const effective = [...map.values()].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.key).localeCompare(String(b.key)));
    const res = { effective, own: effective.filter((e) => e.from.kind === "own"), inherited: effective.filter((e) => e.from.kind !== "own"), excluded };
    ix.memo.set(term.id, res);
    return res;
  }
  function fromText(e) {
    if (e.from.kind === "own") return "own";
    if (e.from.kind === "parent") return "from " + e.from.term.label;
    return `ETIM ${e.from.term.label}` + (e.from.of > 1 ? ` (${e.from.classes}/${e.from.of} classes)` : "");
  }
  /** Detail-panel element listing a term's own and inherited attributes, or null when it has none. */
  function attributesPanel(term, app, ix) {
    const h = app.h, res = resolveAttributes(term, ix);
    if (!res.effective.length && !res.excluded.length) return null;
    const LIMIT = 60;
    const row = (e) => {
      const def = ix.byKey.get(e.key), ad = def ? dataOf(def).attribute_def || {} : {};
      const name = def ? h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); app.goTo(def.id); } }, def.label) : h("code", {}, e.key);
      return h("tr", {}, h("td", {}, name, h("div", { class: "mdm-muted" }, ad.etim_feature || e.key)),
        h("td", {}, [ad.datatype, e.unit || ad.unit].filter(Boolean).join(" · ")),
        h("td", {}, [e.required ? "required" : "", e.facet ? "facet" : ""].filter(Boolean).join(", ")),
        h("td", { class: "mdm-muted" }, fromText(e)));
    };
    const table = (list, wrap) => {
      let shown = false;
      const draw = () => {
        wrap.replaceChildren(...[h("table", { class: "mdm-tx-attrs" }, h("thead", {}, h("tr", {}, ["Attribute", "Type", "Use", "Source"].map((x) => h("th", {}, x)))), h("tbody", {}, (shown ? list : list.slice(0, LIMIT)).map(row))),
          list.length > LIMIT && !shown ? h("button", { class: "mdm-btn small", onclick: () => { shown = true; draw(); } }, `Show all ${list.length}`) : null].filter(Boolean));
      };
      draw(); return wrap;
    };
    const box = h("div", {});
    if (res.own.length) box.append(h("h5", { class: "mdm-tx-h" }, `Own (${res.own.length})`), table(res.own, h("div", {})));
    if (res.inherited.length) box.append(h("h5", { class: "mdm-tx-h" }, `Inherited (${res.inherited.length})`), table(res.inherited, h("div", {})));
    if (res.excluded.length) box.append(h("h5", { class: "mdm-tx-h" }, `Excluded here (${res.excluded.length})`), h("div", { class: "mdm-muted" }, res.excluded.join(", ")));
    return box;
  }

  root.MDMTaxonomy = { browser, attributeIndex, resolveAttributes, attributesPanel, ATTR_SCHEME };
})(typeof window !== "undefined" ? window : globalThis);
