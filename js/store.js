/* Datenspeicher auf dem Gerät (localStorage) und Datensicherung als JSON-Datei.
   Alle Schlüssel beginnen mit "wp.", weil die Leichtathletik-App auf derselben Domain (github.io) liegt. */
(function (root) {
  "use strict";
  const D = root.WPDefaults;
  const KEYS = { data: "wp.data.v1", deleted: "wp.deleted", cloud: "wp.cloud", backup: "wp.backup" };
  // Sammlung je Datensatzart (kind in der Cloud-Tabelle → Feld in den Daten)
  const KINDS = { reading: "readings", tariff: "tariffs", relief: "reliefs", degree_day: "degreeDays",
    baseline: "baseline", investment: "investments", event: "events" };
  const EPOCH = "1970-01-01T00:00:00.000Z";

  function load(key, def) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : def; } catch (e) { return def; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }
  const nowIso = () => new Date().toISOString();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  function empty() {
    const d = { config: { values: {}, updatedAt: EPOCH } };
    Object.values(KINDS).forEach((k) => { d[k] = []; });
    return d;
  }
  function data() {
    const d = load(KEYS.data, null) || empty();
    Object.values(KINDS).forEach((k) => { if (!Array.isArray(d[k])) d[k] = []; });
    if (!d.config || typeof d.config !== "object") d.config = { values: {}, updatedAt: EPOCH };
    return d;
  }
  function changed(kind) {
    root.dispatchEvent && root.dispatchEvent(new CustomEvent("wp:changed", { detail: { kind } }));
  }
  function write(d, kind) { const ok = save(KEYS.data, d); changed(kind); return ok; }

  /** Öffentliche Gradtagzahlen aus defaults.js ergänzen (nur fehlende Monate; eigene Werte bleiben). */
  function ensureDefaults() {
    const d = data(), have = new Set(d.degreeDays.map((x) => x.id));
    let n = 0;
    D.GTZ_MANNHEIM.forEach(([month, gtz, lt]) => {
      const id = "Mannheim:" + month;
      if (have.has(id)) return;
      d.degreeDays.push({ id, month, station: "Mannheim", gtz, gtzLongterm: lt, source: D.GTZ_SOURCE, updatedAt: EPOCH });
      n++;
    });
    if (n) save(KEYS.data, d);
  }

  function upsert(kind, rec) {
    const d = data(), list = d[KINDS[kind]];
    const r = Object.assign({}, rec, { id: rec.id || uid(), updatedAt: nowIso() });
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) list[i] = r; else list.push(r);
    write(d, kind);
    return r;
  }
  function upsertMany(kind, recs) {
    const d = data(), list = d[KINDS[kind]], at = nowIso();
    recs.forEach((rec) => {
      const r = Object.assign({}, rec, { id: rec.id || uid(), updatedAt: at });
      const i = list.findIndex((x) => x.id === r.id);
      if (i >= 0) list[i] = r; else list.push(r);
    });
    write(d, kind);
  }
  function remove(kind, id) {
    const d = data(), list = d[KINDS[kind]], i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    const tomb = load(KEYS.deleted, []) || [];
    tomb.push({ kind, id, at: nowIso() });
    save(KEYS.deleted, tomb);
    write(d, kind);
  }
  function setConfig(key, value) {
    const d = data();
    if (value === null || value === undefined || value === "") delete d.config.values[key];
    else d.config.values[key] = value;
    d.config.updatedAt = nowIso();
    write(d, "config");
  }
  /** Annahmen: Vorgaben aus defaults.js, überschrieben durch eigene Werte. */
  function cfg() {
    const v = data().config.values || {};
    const out = {};
    D.CONFIG.forEach(([k, def]) => { out[k] = k in v ? v[k] : def; });
    return out;
  }

  /* ---------- Datensicherung ---------- */
  function exportObject() {
    return { app: "wp-monitor", version: 1, exportedAt: nowIso(), data: data() };
  }
  /** Führt eine Sicherung zusammen: je Datensatz gewinnt die neuere Änderung; nichts wird gelöscht. */
  function importObject(obj) {
    const src = obj && obj.data;
    if (!obj || obj.app !== "wp-monitor" || !src) throw new Error("Keine WP-Monitor-Sicherung.");
    const d = data(), stats = { added: 0, updated: 0 };
    Object.values(KINDS).forEach((k) => {
      (Array.isArray(src[k]) ? src[k] : []).forEach((r) => {
        if (!r || !r.id) return;
        const i = d[k].findIndex((x) => x.id === r.id);
        const rec = Object.assign({ updatedAt: nowIso() }, r);
        if (i < 0) { d[k].push(rec); stats.added++; }
        else if ((d[k][i].updatedAt || EPOCH) < rec.updatedAt) { d[k][i] = rec; stats.updated++; }
      });
    });
    if (src.config && src.config.values && (src.config.updatedAt || EPOCH) > (d.config.updatedAt || EPOCH)) {
      d.config = { values: Object.assign({}, d.config.values, src.config.values), updatedAt: src.config.updatedAt || nowIso() };
      stats.updated++;
    }
    write(d, "import");
    return stats;
  }
  async function shareOrDownload(name, content) {
    const blob = new Blob([content], { type: "application/json" });
    try {
      const file = new File([blob], name, { type: "application/json" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function exportBackup() {
    const day = new Date().toISOString().slice(0, 10);
    await shareOrDownload(`wp-monitor-${day}.json`, JSON.stringify(exportObject(), null, 1));
    save(KEYS.backup, { at: nowIso() });
  }

  root.WP = Object.assign(root.WP || {}, { KEYS, KINDS, EPOCH, load, save, data, cfg, upsert, upsertMany, remove,
    setConfig, ensureDefaults, exportObject, importObject, exportBackup, uid });
})(typeof window !== "undefined" ? window : globalThis);
