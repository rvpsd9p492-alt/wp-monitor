"use strict";
/* Oberfläche: Erfassen, Auswertung, Stammdaten, Sicherung. Daten über WP (store.js), Rechnung über WPReport. */
const C = window.WPCalc, R = window.WPReport, DEF = window.WPDefaults;
const $ = (s, el = document) => el.querySelector(s);
const nf = (v, d = 1) => (v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }));
const eur = (v) => (v == null ? "–" : nf(v, 0) + " €");
const pct = (v) => (v == null ? "–" : nf(v * 100, 1) + " %");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (v) => { const s = String(v ?? "").trim().replace(/\s/g, "").replace(",", "."); return s === "" ? null : Number(s); };
const fmtTs = (t) => C.isoBerlin(t).slice(0, 16).replace(/(\d{4})-(\d{2})-(\d{2})T/, "$3.$2.$1 ");

WP.ensureDefaults();

// ------------------------------------------------------------------ Tabs
const TABS = { entry: loadEntry, dash: loadDashboard, master: loadMaster, backup: loadBackup };
let currentTab = "entry";
function showTab(name) {
  currentTab = name;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === name));
  TABS[name]();
}
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
window.addEventListener("wp:synced", () => { if (currentTab !== "entry") TABS[currentTab](); else loadRecent(); });

// ------------------------------------------------------------------ Erfassen
const meters = DEF.METERS.filter((m) => !m.historyOnly && !m.hidden);
const meterName = Object.fromEntries(DEF.METERS.map((m) => [m.id, m.name]));

function lastReadings() {
  const last = {};
  WP.data().readings.forEach((r) => { const t = C.parseTs(r.ts); if (!last[r.meter] || last[r.meter].t < t) last[r.meter] = { t, value: r.value }; });
  return last;
}
function loadEntry() {
  const form = $("#entry-form"), last = lastReadings();
  form.ts.value = C.localInput(Date.now());
  $("#meter-fields").innerHTML = meters.map((m) => `
    <div class="meter" data-id="${m.id}">
      <div class="head"><span>${esc(m.name)}</span><span class="src">${m.source === "controller" ? "Regelung, geschätzt" : "geeicht"}</span></div>
      <div class="row">
        <input type="text" inputmode="decimal" name="${m.id}" placeholder="${last[m.id] ? nf(last[m.id].value, m.decimals) : ""}">
        <span class="unit">${esc(m.unit)}</span>
        ${m.kind === "gauge" ? '<span class="reset hint">Anzeige</span>' : `<label class="reset"><input type="checkbox" name="reset_${m.id}"> Reset</label>`}
      </div>
      <div class="delta">${last[m.id] ? `zuletzt ${nf(last[m.id].value, m.decimals)} am ${fmtTs(last[m.id].t)}` : "noch keine Ablesung"}</div>
    </div>`).join("");
  $("#entry-issues").innerHTML = "";
  form.oninput = debounce(() => check(false), 300);
  form.onsubmit = (e) => { e.preventDefault(); check(true); };
  loadRecent();
}
function collect() {
  const form = $("#entry-form"), values = {}, resets = [];
  meters.forEach((m) => {
    const v = num(form[m.id].value);
    if (v !== null) values[m.id] = v;
    if (form["reset_" + m.id] && form["reset_" + m.id].checked) resets.push(m.id);
  });
  return { t: C.parseTs(form.ts.value), values, resets, note: form.note.value.trim() || null };
}
function check(doSave) {
  const p = collect();
  if (!Object.keys(p.values).length) { $("#entry-issues").innerHTML = doSave ? '<div class="error">Kein Wert eingetragen.</div>' : ""; return; }
  const { issues, deltas } = R.validate(WP.data(), meters, WP.cfg(), p.t, p.values, p.resets);
  meters.forEach((m) => {
    const el = $(`.meter[data-id="${m.id}"] .delta`), d = deltas[m.id];
    if (d) el.textContent = `Δ ${nf(d.delta, m.decimals)} ${m.unit} in ${nf(d.days, 1)} Tagen (${nf(d.delta / d.days, 2)}/Tag)`;
    el.classList.toggle("bad", issues.some((i) => i.meter === m.id && i.level === "error"));
  });
  const list = issues.slice();
  if (deltas.household) list.push({ level: "ok", message: `Haushaltsstrom ${nf(deltas.household.delta, 1)} kWh = ${nf(deltas.household.perDay, 1)} kWh/Tag` });
  const errors = issues.filter((i) => i.level === "error");
  if (doSave && !errors.length) {
    const ts = C.isoBerlin(p.t);
    WP.upsertMany("reading", Object.entries(p.values).map(([meter, value]) => ({ meter, ts, value, reset: p.resets.includes(meter), note: p.note })));
    $("#entry-form").reset();
    loadEntry();
    $("#entry-issues").innerHTML = `<div class="ok">Gespeichert: ${Object.keys(p.values).length} Werte am ${fmtTs(p.t)}.</div>`;
    return;
  }
  if (doSave) list.unshift({ level: "error", message: "Nicht gespeichert – bitte die rot markierten Werte prüfen." });
  $("#entry-issues").innerHTML = list.map((i) => `<div class="${i.level}">${esc(i.message)}</div>`).join("");
}
function loadRecent() {
  const rs = WP.data().readings.slice().sort((a, b) => C.parseTs(b.ts) - C.parseTs(a.ts)).slice(0, 40);
  $("#recent").innerHTML = rs.length ? `<table><tr><th>Zeit</th><th>Zähler</th><th>Wert</th><th></th></tr>${rs.map((r) => `
    <tr><td>${fmtTs(C.parseTs(r.ts))}</td><td class="text">${esc(meterName[r.meter] || r.meter)}${r.reset ? " (Reset)" : ""}</td>
    <td>${nf(r.value, 2)}</td><td><button class="icon" data-del="${esc(r.id)}" aria-label="Löschen">✕</button></td></tr>`).join("")}</table>`
    : '<p class="hint">Noch keine Ablesungen. Startdaten unter „Sicherung“ importieren.</p>';
  $("#recent").onclick = (e) => {
    const id = e.target.dataset.del;
    if (id && confirm("Ablesung löschen?")) { WP.remove("reading", id); loadEntry(); }
  };
}
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

// ------------------------------------------------------------------ Auswertung
const charts = {};
function kpi(label, value, sub, detail) {
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div>
    ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
    ${detail ? `<details><summary>Rechnung</summary><pre>${esc(JSON.stringify(detail, null, 1))}</pre></details>` : ""}</div>`;
}
function loadDashboard() {
  let d;
  try { d = R.build(WP.data(), WP.cfg()); } catch (e) { $("#kpis").innerHTML = `<div class="issues"><div class="error">Auswertung fehlgeschlagen: ${esc(e.message)}</div></div>`; return; }
  renderWarnings(d.warnings);
  if (d.empty) { ["#kpis", "#months", "#amort", "#sens"].forEach((s) => { $(s).innerHTML = ""; }); return; }
  const k = d.kpis, sy = k.savingsPerYear, am = d.amortization;
  $("#kpis").innerHTML = [
    kpi(k.az.label, nf(k.az.value, 2), k.az.note, k.az.window && { von: fmtTs(k.az.window[0]), bis: fmtTs(k.az.window[1]) }),
    kpi("Break-even-AZ", nf(k.breakEvenAz.value, 2), "AP Strom / (AP Gas / η)", k.breakEvenAz.inputs),
    kpi("Ersparnis seit Inbetriebnahme", eur(k.savingsSinceStart.value), k.savingsSinceStart.estimated ? "teilweise geschätzt aus Baseline" : ""),
    kpi("Ersparnis pro Jahr", eur(sy && sy.savings), sy && sy.method,
      sy && { waerme_kwh: Math.round(sy.heat), az: sy.az, kosten_wp: Math.round(sy.costHp), kosten_gas: Math.round(sy.costGas) }),
    kpi("Amortisation vs. Gaskessel", am && am.vsGasYears ? nf(am.vsGasYears, 1) + " J." : "–", `Investitionsdelta ${eur(d.investment.delta)}`, d.investment),
    kpi("Amortisation Vollinvestition", am && am.fullYears ? nf(am.fullYears, 1) + " J." : "–", `Eigenanteil ${eur(d.investment.hpOwnShare)}`),
    kpi("Heizstab-Anteil am WP-Strom", pct(k.backupShare.value), k.backupShare.source || "nicht verfügbar",
      k.backupShare.backupKwh != null && { heizstab_kwh: Math.round(k.backupShare.backupKwh * 10) / 10, anzeige_prozent: k.backupShare.pct }),
    kpi("Haushaltsstrom", nf(k.householdDay.value, 1) + " kWh/Tag", "Hauszähler − WP-Zähler"),
    kpi("Laufzeit je Kompressorstart (Heizung)", k.cycling.heating ? nf(k.cycling.heating.avgRuntimeMin, 0) + " min" : "–",
      k.cycling.heating ? `${nf(k.cycling.heating.startsPerHour, 1)} Starts je Betriebsstunde` : "Starts/Stunden Heizung nicht erfasst",
      (k.cycling.heating || k.cycling.total) && { heizung_min: k.cycling.heating && Math.round(k.cycling.heating.avgRuntimeMin),
        warmwasser_min: k.cycling.dhw && Math.round(k.cycling.dhw.avgRuntimeMin), gesamt_min: k.cycling.total && Math.round(k.cycling.total.avgRuntimeMin) }),
  ].join("");
  renderMonths(d.months);
  renderAmort(d);
  renderSens(d.sensitivity);
}
function renderWarnings(ws) { $("#warnings").innerHTML = (ws || []).map((w) => `<div class="${w.level}">${esc(w.text)}</div>`).join(""); }
function renderMonths(months) {
  const cols = [
    ["Monat", (m) => m.month + (m.partialMonth ? " (Teil)" : "") + (m.interpolated ? " ~" : "")],
    ["Tage", (m) => nf(m.days, 1)],
    ["WP-Strom", (m) => nf(m.hpEl, 1)],
    ["Wärme", (m) => `<span class="${m.heatEstimated ? "est" : ""}">${nf(m.heat, 0)}</span>`],
    ["AZ", (m) => (m.az == null ? `<span title="${esc(m.azNote || "")}">–</span>` : nf(m.az, 2))],
    ["AZ Heizen", (m) => nf(m.azHeating, 2)],
    ["AZ WW", (m) => nf(m.azDhw, 2)],
    ["Heizstab", (m) => (m.backupShare != null ? pct(m.backupShare) : m.backupPct != null ? nf(m.backupPct, 0) + " % Anz." : "–")],
    ["Haushalt/Tag", (m) => nf(m.householdDay, 1)],
    ["min/Start Heizen", (m) => (m.cyclingHeating ? nf(m.cyclingHeating.avgRuntimeMin, 0) : "–")],
    ["min/Start WW", (m) => (m.cyclingDhw ? nf(m.cyclingDhw.avgRuntimeMin, 0) : "–")],
    ["Heizen erwartet", (m) => nf(m.heatingExpected, 0)],
    ["Kosten WP", (m) => eur(m.economics && m.economics.costHp)],
    ["Kosten Gas", (m) => eur(m.economics && m.economics.costGas)],
    ["Ersparnis", (m) => eur(m.economics && m.economics.savings)],
  ];
  $("#months").innerHTML = `<table><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr>
    ${months.map((m) => `<tr>${cols.map((c) => `<td>${c[1](m)}</td>`).join("")}</tr>`).join("")}</table>
    <p class="hint">~ = anteilig interpoliert · gelb = Wärme geschätzt aus Baseline · Wärme = Herstellerangabe, nicht geeicht</p>`;
  if (!window.Chart) return;
  if (charts.months) charts.months.destroy();
  charts.months = new Chart($("#chart-months"), {
    data: { labels: months.map((m) => m.month), datasets: [
      { type: "bar", label: "WP-Strom kWh", data: months.map((m) => m.hpEl), yAxisID: "y" },
      { type: "bar", label: "Wärme kWh", data: months.map((m) => m.heat), yAxisID: "y" },
      { type: "line", label: "AZ", data: months.map((m) => m.az), yAxisID: "az" },
    ] },
    options: { maintainAspectRatio: false, scales: { y: { beginAtZero: true }, az: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false } } } },
  });
}
function renderAmort(d) {
  const t = d.amortization && d.amortization.escalation;
  if (!t) { $("#amort").innerHTML = '<p class="hint">Noch keine Hochrechnung möglich (AZ, Tarife oder Baseline fehlen).</p>'; return; }
  $("#amort").innerHTML = `<p class="hint">Saldo gegen vermiedene Gas-Investition (${eur(d.investment.delta)}).
    Break-even: ${t.breakEvenYear ? "Jahr " + t.breakEvenYear : "nicht innerhalb von 20 Jahren"}.</p>`;
  if (!window.Chart) return;
  if (charts.amort) charts.amort.destroy();
  charts.amort = new Chart($("#chart-amort"), { type: "line",
    data: { labels: t.rows.map((r) => r.year), datasets: [
      { label: "kumulierter Saldo €", data: t.rows.map((r) => r.cumulative) },
      { label: "Break-even", data: t.rows.map(() => 0), borderDash: [4, 4], pointRadius: 0 },
    ] }, options: { maintainAspectRatio: false } });
}
function renderSens(s) {
  if (!s) { $("#sens").innerHTML = ""; return; }
  const azs = [...new Set(s.rows.map((r) => r.az))], etas = [...new Set(s.rows.map((r) => r.eta))];
  const cell = (eta, az) => { const r = s.rows.find((x) => x.eta === eta && x.az === az);
    return `${eur(r.savings)}<br><span class="hint">${r.paybackVsGas ? nf(r.paybackVsGas, 1) + " J." : "–"}</span>`; };
  $("#sens").innerHTML = `<table><tr><th>η \\ AZ</th>${azs.map((a) => `<th>${nf(a, 1)}</th>`).join("")}</tr>
    ${etas.map((e) => `<tr><td>${nf(e, 2)}</td>${azs.map((a) => `<td>${cell(e, a)}</td>`).join("")}</tr>`).join("")}</table>
    <p class="hint">Ersparnis pro Jahr und Amortisation gegen die Gas-Alternative. ${esc(s.note)}</p>`;
}

// ------------------------------------------------------------------ Stammdaten
const COLUMNS = {
  tariff: [["energy", "Energie (electricity/gas)"], ["provider", "Anbieter"], ["product", "Produkt"], ["validFrom", "gültig ab"], ["validTo", "gültig bis"],
    ["ct", "Arbeitspreis ct/kWh", 1], ["baseYear", "Grundpreis €/a", 1], ["guaranteeUntil", "Preisgarantie bis"]],
  relief: [["validFrom", "gültig ab"], ["validTo", "gültig bis"], ["module", "Modul (none/modul1/modul2/modul1+3)"], ["amountYear", "€/a", 1],
    ["confirmed", "bestätigt (0/1)", 1], ["note", "Notiz"]],
  investment: [["scenario", "Szenario (heatpump/gas_alternative)"], ["item", "Position"], ["gross", "brutto €", 1], ["subsidy", "Zuschuss €", 1],
    ["date", "Datum"], ["status", "Status (offer/invoice/paid)"]],
  degree_day: [["month", "Monat"], ["station", "Station"], ["gtz", "GTZ", 1], ["gtzLongterm", "langj. Mittel", 1], ["source", "Quelle"]],
  baseline: [["year", "Jahr", 1], ["gasM3", "Gas m³", 1], ["factor", "kWh/m³", 1], ["householdKwh", "Haushalt kWh", 1], ["days", "Tage", 1], ["note", "Notiz"]],
  event: [["ts", "Zeitpunkt"], ["category", "Kategorie (setting/maintenance/fault/tariff/other)"], ["text", "Text"]],
};
const SORT = { tariff: "validFrom", relief: "validFrom", degree_day: "month", baseline: "year", event: "ts", investment: "scenario" };
$("#master-table").addEventListener("change", loadMaster);

function loadMaster() {
  const kind = $("#master-table").value;
  $("#gtz-import").hidden = kind !== "degree_day";
  if (kind === "config") return renderConfig();
  const cols = COLUMNS[kind], key = SORT[kind];
  const rows = WP.data()[WP.KINDS[kind]].slice().sort((a, b) => String(b[key]).localeCompare(String(a[key]), "de", { numeric: true }));
  const input = (c, v) => `<td><input data-col="${c[0]}" value="${esc(v ?? "")}" ${c[2] ? 'inputmode="decimal"' : ""}></td>`;
  $("#master-body").innerHTML = `<table><tr>${cols.map((c) => `<th>${esc(c[1])}</th>`).join("")}<th></th></tr>
    <tr data-id="" class="new">${cols.map((c) => input(c, "")).join("")}<td><button class="icon" data-act="add" aria-label="Hinzufügen">＋</button></td></tr>
    ${rows.map((r) => `<tr data-id="${esc(r.id)}">${cols.map((c) => input(c, r[c[0]])).join("")}
      <td class="nowrap"><button class="icon" data-act="save" aria-label="Speichern">✓</button><button class="icon" data-act="del" aria-label="Löschen">✕</button></td></tr>`).join("")}</table>`;
  $("#master-body").onclick = (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const tr = e.target.closest("tr"), id = tr.dataset.id;
    if (act === "del") { if (confirm("Zeile löschen?")) { WP.remove(kind, id); loadMaster(); } return; }
    const rec = id ? Object.assign({}, WP.data()[WP.KINDS[kind]].find((x) => x.id === id)) : {};
    cols.forEach((c) => { const v = $(`input[data-col="${c[0]}"]`, tr).value.trim(); rec[c[0]] = c[2] ? num(v) : (v || null); });
    if (kind === "relief") rec.confirmed = !!rec.confirmed;
    if (kind === "degree_day" && !id) rec.id = (rec.station || "Mannheim") + ":" + rec.month;
    WP.upsert(kind, rec);
    loadMaster();
  };
}
function renderConfig() {
  const v = WP.data().config.values || {};
  $("#master-body").innerHTML = `<table><tr><th>Annahme</th><th>Wert</th><th>Status</th><th>Bedeutung</th><th></th></tr>
    ${DEF.CONFIG.map(([key, def, status, desc]) => `<tr data-key="${key}"><td>${key}</td>
      <td><input value="${esc(JSON.stringify(key in v ? v[key] : def))}"></td><td>${status}${key in v ? "" : " · Vorgabe"}</td>
      <td class="text">${esc(desc)}</td><td><button class="icon" aria-label="Speichern">✓</button></td></tr>`).join("")}</table>
    <p class="hint">Werte als JSON: Zahlen mit Punkt (0.9), Text in Anführungszeichen, leer = <code>null</code> (Vorgabe).</p>`;
  $("#master-body").onclick = (e) => {
    if (e.target.tagName !== "BUTTON") return;
    const tr = e.target.closest("tr");
    try {
      const raw = $("input", tr).value.trim();
      WP.setConfig(tr.dataset.key, raw === "" ? null : JSON.parse(raw));
      renderConfig();
    } catch (err) { alert("Ungültiger Wert: " + err.message); }
  };
}
$("#gtz-btn").addEventListener("click", () => {
  const lt = {}; // Monatsmittel aus den Vorgaben als langjähriges Mittel, falls nicht angegeben
  DEF.GTZ_MANNHEIM.forEach(([m, , l]) => { lt[m.slice(5)] = l; });
  const recs = [], bad = [];
  $("#gtz-csv").value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !/^month/i.test(l)).forEach((l) => {
    const f = l.split(/[;\t]/).map((x) => x.trim());
    const month = f[0];
    const full = f.length >= 3;
    const gtz = num(full ? f[2] : f[1]);
    if (!/^\d{4}-\d{2}$/.test(month) || gtz === null || !isFinite(gtz)) { bad.push(l); return; }
    const station = full ? f[1] || "Mannheim" : "Mannheim";
    recs.push({ id: station + ":" + month, month, station, gtz, gtzLongterm: num(f[3]) ?? lt[month.slice(5)] ?? null, source: f[4] || "manuell" });
  });
  if (recs.length) WP.upsertMany("degree_day", recs);
  alert(`${recs.length} Monat(e) übernommen.` + (bad.length ? `\nNicht erkannt:\n${bad.join("\n")}` : ""));
  $("#gtz-csv").value = "";
  loadMaster();
});

// ------------------------------------------------------------------ Sicherung
function loadBackup() {
  renderCloud(WP.cloud.status());
  const kinds = Object.keys(WP.KINDS);
  $("#csv-links").innerHTML = kinds.map((k) => `<button type="button" data-csv="${k}">${k}</button>`).join("");
}
function renderCloud(s) {
  const badge = $("#cloud-badge");
  badge.hidden = !s.loggedIn;
  badge.textContent = s.syncing ? "Abgleich …" : s.error ? "Cloud-Fehler" : s.pending ? `${s.pending} offen` : "gesichert";
  badge.className = "badge " + (s.error ? "error" : s.pending ? "warning" : "ok");
  if (currentTab !== "backup") return;
  const box = $("#cloud-box");
  if (!s.configured) { box.innerHTML = '<p class="hint">Nicht eingerichtet (js/config.js).</p>'; return; }
  if (!s.loggedIn) {
    box.innerHTML = `<p class="hint">Gleiches Konto wie in der Leichtathletik-App.</p>${s.error ? `<div class="issues"><div class="error">${esc(s.error)}</div></div>` : ""}
      <form id="login"><label>E-Mail <input type="email" name="email" autocomplete="username" required></label>
      <label>Passwort <input type="password" name="password" autocomplete="current-password" required></label>
      <button class="primary" type="submit">Anmelden</button><div id="login-msg" class="issues"></div></form>`;
    $("#login").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try { await WP.cloud.signIn(f.email.value.trim(), f.password.value); }
      catch (err) { $("#login-msg").innerHTML = `<div class="error">${esc(err.message)}</div>`; }
    };
    return;
  }
  box.innerHTML = `<div class="issues"><div class="${s.error ? "error" : s.pending ? "warning" : "ok"}">
      Angemeldet als ${esc(s.email)}. ${s.syncing ? "Abgleich läuft …" : s.error ? esc(s.error) : s.pending ? s.pending + " Änderung(en) noch nicht hochgeladen." : "Alles gesichert."}
      ${s.lastSyncAt ? "<br>Letzter Abgleich: " + fmtTs(Date.parse(s.lastSyncAt)) : ""}</div></div>
    <div class="buttons"><button type="button" id="sync-btn">Jetzt abgleichen</button><button type="button" id="logout-btn">Abmelden</button></div>`;
  $("#sync-btn").onclick = () => WP.cloud.sync({ force: true });
  $("#logout-btn").onclick = () => { if (confirm("Abmelden? Die Daten bleiben auf diesem Gerät.")) WP.cloud.signOut(); };
}
WP.cloud.onStatus(renderCloud);
renderCloud(WP.cloud.status());

$("#export-btn").addEventListener("click", () => WP.exportBackup());
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const st = WP.importObject(JSON.parse(await file.text()));
    $("#backup-msg").innerHTML = `<div class="ok">Importiert: ${st.added} neu, ${st.updated} aktualisiert.</div>`;
  } catch (err) { $("#backup-msg").innerHTML = `<div class="error">Import fehlgeschlagen: ${esc(err.message)}</div>`; }
  e.target.value = "";
});
$("#csv-links").addEventListener("click", (e) => {
  const kind = e.target.dataset.csv;
  if (!kind) return;
  const rows = WP.data()[WP.KINDS[kind]];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => { const s = v == null ? "" : typeof v === "number" ? String(v).replace(".", ",") : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = "﻿" + [cols.join(";"), ...rows.map((r) => cols.map((c) => cell(r[c])).join(";"))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `wp-${kind}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
});

// ------------------------------------------------------------------ Offline
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
showTab("entry");
