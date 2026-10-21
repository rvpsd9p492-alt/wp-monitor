/* Auswertung und Plausibilitätsprüfung: verbindet die Daten (siehe store.js) mit WPCalc.
   Jede Kennzahl trägt ihre Eingangswerte mit, damit die Rechnung nachvollziehbar bleibt. */
(function (root) {
  "use strict";
  const C = root.WPCalc || require("./calc.js");
  const DEF = root.WPDefaults || require("./defaults.js");
  const HEAT_NOTE = "Wärme: Herstellerangabe der Bosch-Regelung, nicht geeicht, ganzzahlig abgeschnitten";
  // Hauszähler zeigt ganze kWh: Differenzen sind bis zu ±1 kWh ungenau.
  const HOUSE_RESOLUTION = 1.0;

  /* ---------- Hilfen ---------- */
  function readingsByMeter(data) {
    const by = {};
    data.readings.forEach((r) => {
      (by[r.meter] = by[r.meter] || []).push({ t: C.parseTs(r.ts), value: +r.value, reset: !!r.reset });
    });
    return by;
  }
  /** Intervalle je Zähler. Zähler der Regelung beginnen bei Inbetriebnahme bei 0 (ANNAHME, abschaltbar), damit schon
      die erste Ablesung eines neu erfassten Werts einen Zeitraum ergibt. */
  function series(data, cfg) {
    const by = readingsByMeter(data), out = {};
    const t0 = cfg && cfg.controller_counters_start_zero && cfg.commissioning_ts ? C.parseTs(cfg.commissioning_ts) : null;
    if (t0 != null) DEF.METERS.forEach((m) => {
      if (m.source !== "controller" || m.kind === "gauge" || !by[m.id]) return;
      if (!by[m.id].some((r) => r.t <= t0 + C.H / 60)) by[m.id].push({ t: t0, value: 0, reset: true, implicit: true });
    });
    Object.keys(by).forEach((m) => { out[m] = C.intervals(by[m]); });
    return out;
  }
  /** Letzter Momentanwert (z. B. Prozentanzeige) im Fenster (t0, t1]. */
  function latestGauge(rs, t0, t1) {
    const inside = (rs || []).filter((r) => r.t > t0 && r.t <= t1);
    return inside.length ? inside.reduce((a, b) => (b.t > a.t ? b : a)) : null;
  }
  /** Summe der getrennten Werte (Heizung + Warmwasser), sonst der Gesamtwert, sonst null. */
  function sumKnown(a, b, total) {
    if (a != null || b != null) return (a || 0) + (b || 0);
    return total != null ? total : null;
  }
  const get = (s, m, t0, t1) => (s[m] && s[m].length ? C.consumption(s[m], t0, t1) : null);
  const val = (sh) => (!sh || sh.hours === 0 ? null : sh.value);

  function heatIn(s, t0, t1) {
    const tot = get(s, "hp_heat_total", t0, t1);
    if (tot && tot.hours > 0) return { heat: tot.value, source: "hp_heat_total" };
    const h = get(s, "hp_heat_heating", t0, t1), w = get(s, "hp_heat_dhw", t0, t1);
    if (h && w && h.hours > 0 && w.hours > 0) return { heat: h.value + w.value, source: "hp_heat_heating+hp_heat_dhw" };
    return { heat: null, source: null };
  }
  function heatMeters(s) {
    if (s.hp_heat_total && s.hp_heat_total.length) return ["hp_heat_total"];
    if (s.hp_heat_heating && s.hp_heat_heating.length && s.hp_heat_dhw && s.hp_heat_dhw.length) return ["hp_heat_heating", "hp_heat_dhw"];
    return [];
  }
  function commonWindow(s, meters, t0, t1) {
    let lo = t0, hi = t1;
    for (const m of meters) {
      const cov = C.coverage(s[m]);
      if (!cov) return null;
      lo = Math.max(lo, cov[0]); hi = Math.min(hi, cov[1]);
    }
    return hi > lo ? [lo, hi] : null;
  }
  const tariffs = (data, energy) => data.tariffs.filter((t) => t.energy === energy && t.validFrom && t.ct != null);

  /* ---------- Baseline ---------- */
  function baselineModel(data, cfg) {
    const refYears = new Set(cfg.baseline_ref_years || []);
    const eta = cfg.boiler_efficiency_hs, station = cfg.degree_day_station;
    const ref = data.baseline.filter((b) => refYears.has(+b.year) && b.gasM3 && b.factor)
      .map((b) => ({ year: +b.year, gasHs: C.gasKwhHs(b.gasM3, b.factor), days: +b.days || 365 }));
    const meanHs = ref.length ? ref.reduce((a, r) => a + r.gasHs, 0) / ref.length : null;
    const gtzMonth = {};
    data.degreeDays.forEach((d) => { if (!station || d.station === station) gtzMonth[d.month] = d; });
    const gtzYear = {};
    refYears.forEach((y) => {
      const ms = [];
      for (let m = 1; m <= 12; m++) ms.push(gtzMonth[`${y}-${String(m).padStart(2, "0")}`]);
      if (ms.every(Boolean)) gtzYear[y] = ms.reduce((a, x) => a + x.gtz, 0);
    });
    const k = C.heatingPerGtz(ref, gtzYear, cfg.dhw_share_baseline_kwh_day);
    return {
      refYears: [...refYears].sort(), gasHsMean: meanHs, usefulHeatRef: meanHs ? meanHs * eta : null,
      kwhHsPerGtz: k, gtzYearsComplete: Object.keys(gtzYear).map(Number).sort(), gtzMonth,
      note: k ? null : "Gradtagzahlen oder Gasverbrauch für die Referenzjahre fehlen: keine Witterungsbereinigung möglich.",
    };
  }

  function investments(data, cfg) {
    const net = (scn) => data.investments.filter((i) => i.scenario === scn)
      .reduce((a, i) => a + (+i.gross || 0) - (+i.subsidy || 0), 0);
    const hp = net("heatpump"), gas = net("gas_alternative");
    const ov = cfg.hp_own_share_eur, has = ov !== null && ov !== undefined && ov !== "";
    const own = has ? +ov : hp;
    return { hpNetFromItems: hp, hpOwnShare: own, hpOwnShareSource: has ? "Konfiguration hp_own_share_eur" : "Investitionen",
      gasAlternative: gas, delta: own - gas };
  }

  function sensitivity(base, elNow, gasNow, reliefYear, a, invest) {
    if (!base.gasHsMean) return null;
    const rows = [];
    [0.85, 0.90, 0.95].forEach((eta) => {
      const heat = base.gasHsMean * eta; // gleiche Gasmenge, andere Nutzwärme-Annahme
      [2.5, 3.0, 3.5, 4.0].forEach((az) => {
        const c = C.annualComparison({ heat, az, ctEl: elNow.ct, ctGas: gasNow.ct, baseGas: gasNow.baseYear, eta,
          relief: reliefYear, gasOther: a.gasOther, hpOther: a.hpOther });
        rows.push({ eta, az, heat, savings: c.savings, paybackVsGas: C.paybackYears(invest.delta, c.savings) });
      });
    });
    return { rows, note: "Nutzwärme = Ø Gasverbrauch der Referenzjahre × η; Tarife zum letzten Ablesezeitpunkt." };
  }

  /* ---------- Dashboard ---------- */
  function build(data, cfg, now) {
    const a = { eta: cfg.boiler_efficiency_hs, gasOther: +cfg.gas_other_costs_eur_year || 0, hpOther: +cfg.hp_other_costs_eur_year || 0 };
    const s = series(data, cfg), byMeter = readingsByMeter(data);
    const elT = tariffs(data, "electricity"), gasT = tariffs(data, "gas");
    const reliefs = data.reliefs;
    const base = baselineModel(data, cfg);
    const warnings = [];
    const warn = (level, code, text, month) => warnings.push({ level, code, text, month: month || null });

    const hpCov = C.coverage(s.hp_el);
    if (!hpCov) return { empty: true, warnings: [{ level: "info", code: "no_data", text: "Noch keine zwei Ablesungen des WP-Zählers." }] };
    const start = cfg.commissioning_ts ? C.parseTs(cfg.commissioning_ts) : hpCov[0];
    const end = hpCov[1];
    now = now || Date.now();

    function checkAz(az, at, month) {
      if (az == null) return;
      const prefix = month ? month + ": " : "Seit Inbetriebnahme: ";
      if (az > cfg.az_plausible_max || az < cfg.az_plausible_min) {
        warn("warning", "az_implausible", `${prefix}AZ ${az.toFixed(2)} unplausibel. Ablesefehler?`, month);
        return;
      }
      const el = C.tariffAt(elT, at).tariff, gas = C.tariffAt(gasT, at).tariff;
      if (el && gas) {
        const be = C.breakEvenAz(el.ct, gas.ct, a.eta);
        if (az < be) warn("warning", "az_below_break_even", `${prefix}AZ ${az.toFixed(2)} unter Break-even ${be.toFixed(2)}.`, month);
      }
    }

    // ---------- Monate
    const months = [];
    let savingsTotal = 0, savingsEstimated = false;
    C.monthsBetween(start, end).forEach((mon) => {
      const [m0, m1] = C.monthBounds(mon);
      const t0 = Math.max(m0, start), t1 = Math.min(m1, end);
      if (t1 <= t0) return;
      const hp = get(s, "hp_el", t0, t1), house = get(s, "house_el", t0, t1);
      let { heat, source: heatSrc } = heatIn(s, t0, t1);
      const g = {};
      ["hp_heat_heating", "hp_heat_dhw", "hp_el_heating", "hp_el_dhw", "hp_el_backup", "hp_compressor_hours",
        "hp_compressor_starts", "hp_el_ctrl_total"].forEach((k) => { g[k] = val(get(s, k, t0, t1)); });
      const days = hp.days;
      const row = { month: mon, days, interpolated: !!((hp && hp.interpolated) || (house && house.interpolated)),
        partialMonth: t1 - t0 < m1 - m0, hpEl: hp.value, houseEl: val(house),
        household: house && house.hours > 0 ? house.value - hp.value : null,
        heat, heatSource: heatSrc, heatEstimated: false,
        heatHeating: g.hp_heat_heating, heatDhw: g.hp_heat_dhw, elHeating: g.hp_el_heating, elDhw: g.hp_el_dhw,
        ctrlEl: g.hp_el_ctrl_total };
      row.householdDay = C.ratio(row.household, days);

      const gtz = base.gtzMonth[mon];
      let expected = null;
      if (gtz && base.kwhHsPerGtz) expected = base.kwhHsPerGtz * gtz.gtz * (t1 - t0) / (m1 - m0) * a.eta;
      row.heatingExpected = expected;
      if (expected && g.hp_heat_heating != null && expected > 0) {
        row.heatingDeviation = g.hp_heat_heating / expected - 1;
        if (Math.abs(row.heatingDeviation) > cfg.heating_deviation_warn)
          warn("warning", "heating_deviation", `${mon}: Heizwärme weicht ${(row.heatingDeviation * 100).toFixed(0)} % vom Erwartungswert aus Baseline/GTZ ab.`, mon);
      }
      row.heatingNormalized = gtz && g.hp_heat_heating != null ? C.weatherNormalized(g.hp_heat_heating, gtz.gtz, gtz.gtzLongterm) : null;

      // Fallback: Wärme aus Baseline schätzen (5.3)
      if (heat == null && expected != null) {
        heat = expected + cfg.dhw_share_baseline_kwh_day * days * a.eta;
        Object.assign(row, { heat, heatSource: "baseline", heatEstimated: true });
      }

      const longEnough = days >= cfg.min_az_interval_days;
      row.az = longEnough && !row.heatEstimated ? C.ratio(heat, hp.value) : null;
      row.azNote = longEnough ? null : `Intervall < ${cfg.min_az_interval_days} Tage`;
      row.azHeating = longEnough ? C.ratio(g.hp_heat_heating, g.hp_el_heating) : null;
      row.azDhw = longEnough ? C.ratio(g.hp_heat_dhw, g.hp_el_dhw) : null;
      row.backupHeating = val(get(s, "hp_el_backup_heating", t0, t1));
      row.backupDhw = val(get(s, "hp_el_backup_dhw", t0, t1));
      row.backup = sumKnown(row.backupHeating, row.backupDhw, g.hp_el_backup);
      row.backupShare = C.ratio(row.backup, hp.value);
      const pctM = latestGauge(byMeter.hp_backup_pct, t0 - 1, t1);
      row.backupPct = pctM ? pctM.value : null;
      row.cycling = C.cycling(g.hp_compressor_starts, g.hp_compressor_hours);
      if (row.backupShare != null && row.backupShare > cfg.backup_warn_share)
        warn("warning", "backup", `${mon}: Heizstab-Anteil ${(row.backupShare * 100).toFixed(1)} %.`, mon);
      if (row.cycling && row.cycling.avgRuntimeMin < cfg.min_runtime_warn_min)
        warn("warning", "cycling", `${mon}: mittlere Laufzeit ${row.cycling.avgRuntimeMin.toFixed(0)} min pro Start.`, mon);
      checkAz(row.az, t1, mon);

      if (heat != null && elT.length && gasT.length) {
        row.economics = C.comparePeriod(t0, t1, heat, hp.value, elT, gasT, a, C.reliefEur(reliefs, t0, t1));
        savingsTotal += row.economics.savings;
        savingsEstimated = savingsEstimated || row.heatEstimated;
      } else row.economics = null;
      months.push(row);
    });

    // ---------- Kumuliert / JAZ
    const spanDays = C.hours(start, end) / 24;
    const hm = heatMeters(s);
    const win = hm.length ? commonWindow(s, ["hp_el", ...hm], start, end) : null;
    let azSince = null, jaz = null;
    if (win && C.hours(win[0], win[1]) / 24 >= cfg.min_az_interval_days)
      azSince = C.ratio(heatIn(s, win[0], win[1]).heat, C.consumption(s.hp_el, win[0], win[1]).value);
    if (spanDays >= 365 && hm.length) {
      const w = commonWindow(s, ["hp_el", ...hm], end - 365 * C.DAY, end);
      if (w && C.hours(w[0], w[1]) / 24 >= 364) jaz = C.ratio(heatIn(s, w[0], w[1]).heat, C.consumption(s.hp_el, w[0], w[1]).value);
    }
    const backupC = sumKnown(val(get(s, "hp_el_backup_heating", start, end)), val(get(s, "hp_el_backup_dhw", start, end)),
      val(get(s, "hp_el_backup", start, end)));
    // Bosch zeigt den Zuheizer nur als Prozentanteil im Energie-Monitoring. Annahme: Anteil an der erzeugten Wärme
    // seit Inbetriebnahme; ein Heizstab wandelt Strom 1:1 in Wärme, also Heizstab-Strom ≈ Anteil × Wärme.
    const pctNow = latestGauge(byMeter.hp_backup_pct, start - 1, Math.max(end, now));
    let backup = { kwh: backupC, source: backupC != null ? "kWh der Regelung" : null, hpEl: null };
    if (backupC == null && pctNow && win) {
      backup = { kwh: pctNow.value / 100 * heatIn(s, win[0], win[1]).heat, hpEl: C.consumption(s.hp_el, win[0], win[1]).value,
        source: `geschätzt: Zuheizer-Anteil ${pctNow.value} % × Wärme`, pct: pctNow.value };
    }
    const hpTotal = C.consumption(s.hp_el, start, end).value;
    const houseTotal = get(s, "house_el", start, end);
    const householdDay = houseTotal && houseTotal.hours ? C.ratio(houseTotal.value - hpTotal, houseTotal.days) : null;

    // ---------- Tarife aktuell
    const elNow = C.tariffAt(elT, end).tariff, gasNow = C.tariffAt(gasT, end).tariff;
    const beAz = elNow && gasNow ? C.breakEvenAz(elNow.ct, gasNow.ct, a.eta) : null;
    const reliefYear = C.reliefEur(reliefs, end, end + 365 * C.DAY);
    const reliefPotential = C.reliefEur(reliefs, end, end + 365 * C.DAY, false);

    // ---------- Ersparnis pro Jahr
    let annual = null;
    if (spanDays >= 365 && elT.length && gasT.length) {
      const t0 = end - 365 * C.DAY, h = heatIn(s, t0, end).heat;
      if (h != null) annual = Object.assign({ method: "gemessen, letzte 12 Monate" },
        C.comparePeriod(t0, end, h, C.consumption(s.hp_el, t0, end).value, elT, gasT, a, C.reliefEur(reliefs, t0, end)));
    }
    if (!annual && azSince && base.usefulHeatRef && elNow && gasNow) {
      const c = C.annualComparison({ heat: base.usefulHeatRef, az: azSince, ctEl: elNow.ct, ctGas: gasNow.ct,
        baseGas: gasNow.baseYear, eta: a.eta, relief: reliefYear, gasOther: a.gasOther, hpOther: a.hpOther });
      annual = Object.assign({ method: "Hochrechnung: Referenz-Nutzwärme × AZ seit Inbetriebnahme × aktuelle Tarife",
        heat: base.usefulHeatRef, az: azSince }, c);
    }

    const invest = investments(data, cfg);
    let amort = null;
    if (annual) amort = {
      fullYears: C.paybackYears(invest.hpOwnShare, annual.savings),
      vsGasYears: C.paybackYears(invest.delta, annual.savings),
      escalation: C.escalationTable(invest.delta, annual.costGas, annual.costHp, +cfg.price_escalation_gas || 0,
        +cfg.price_escalation_el || 0, +cfg.discount_rate || 0, 20),
    };
    const sens = elNow && gasNow ? sensitivity(base, elNow, gasNow, reliefYear, a, invest) : null;

    // ---------- Hinweise
    const lastHp = Math.max(...data.readings.filter((r) => r.meter === "hp_el").map((r) => C.parseTs(r.ts)));
    const gap = (now - lastHp) / C.DAY;
    if (gap > cfg.gap_days) warn("info", "gap", `Letzte Ablesung vor ${gap.toFixed(0)} Tagen.`);
    if (!hm.length) warn("info", "no_heat", "Keine Wärmemengen der Regelung erfasst: AZ nicht verfügbar.");
    if (base.note) warn("info", "no_gtz", base.note);
    if (!elT.length || !gasT.length) warn("info", "no_tariff", "Strom- oder Gastarif fehlt: keine Kostenrechnung.");
    if (reliefPotential && !reliefYear) warn("info", "relief_unconfirmed", "§ 14a-Entlastung eingetragen, aber nicht bestätigt: nicht eingerechnet.");
    else if (!reliefPotential) warn("info", "relief_open", "§ 14a: Betrag offen, Entlastung mit 0 € gerechnet.");
    const prevMonth = C.monthKey(C.monthBounds(C.monthKey(now))[0] - C.DAY);
    if (prevMonth >= C.monthKey(start) && !base.gtzMonth[prevMonth])
      warn("info", "gtz_missing", `Gradtagzahl für ${prevMonth} fehlt (Stammdaten → Gradtagzahlen).`);
    checkAz(azSince, end, null);
    const backupShare = C.ratio(backup.kwh, backup.hpEl != null ? backup.hpEl : hpTotal);
    if (backupShare != null && backupShare > cfg.backup_warn_share)
      warn("warning", "backup", `Heizstab-Anteil am WP-Strom ${(backupShare * 100).toFixed(1)} % (${backup.source}).`);

    return {
      empty: false,
      period: { start, end, days: spanDays },
      kpis: {
        az: { value: jaz != null ? jaz : azSince, label: jaz != null ? "JAZ (12 Monate gleitend)" : "AZ seit Inbetriebnahme",
          sinceStart: azSince, jaz, window: win, note: HEAT_NOTE },
        savingsSinceStart: { value: savingsTotal, estimated: savingsEstimated },
        savingsPerYear: annual,
        backupShare: { value: backupShare, backupKwh: backup.kwh, source: backup.source, pct: backup.pct != null ? backup.pct : null },
        householdDay: { value: householdDay },
        breakEvenAz: { value: beAz, inputs: { ctEl: elNow && elNow.ct, ctGas: gasNow && gasNow.ct, eta: a.eta } },
      },
      months, investment: invest, amortization: amort, sensitivity: sens,
      baseline: { refYears: base.refYears, gasHsMean: base.gasHsMean, usefulHeatRef: base.usefulHeatRef,
        kwhHsPerGtz: base.kwhHsPerGtz, gtzYearsComplete: base.gtzYearsComplete, note: base.note },
      relief: { confirmedYear: reliefYear, potentialYear: reliefPotential },
      warnings,
    };
  }

  /* ---------- Plausibilität beim Speichern (5.6) ---------- */
  function neighbours(rs, t) {
    let prev = null, next = null, same = null;
    rs.slice().sort((x, y) => x.t - y.t).forEach((r) => {
      const d = (t - r.t) / C.H;
      if (Math.abs(d) < 1 / 60) same = r;
      else if (d > 0) prev = r;
      else if (!next) next = r;
    });
    return { prev, next, same };
  }
  /** Prüft neue Ablesungen {meter: value} zum Zeitpunkt t. → {issues, deltas}; issues mit level "error" blockieren. */
  function validate(data, meters, cfg, t, values, resets) {
    const by = readingsByMeter(data), issues = [], deltas = {};
    const meta = Object.fromEntries(meters.map((m) => [m.id, m]));
    const resetSet = new Set(resets || []);
    Object.keys(values).forEach((mid) => {
      const m = meta[mid], value = values[mid];
      if (!m) { issues.push({ level: "error", code: "unknown_meter", meter: mid, message: `Unbekannter Zähler ${mid}` }); return; }
      if (!isFinite(value)) { issues.push({ level: "error", code: "nan", meter: mid, message: `${m.name}: keine Zahl.` }); return; }
      const { prev, next, same } = neighbours(by[mid] || [], t), reset = resetSet.has(mid);
      if (same) { issues.push({ level: "error", code: "duplicate", meter: mid, message: `${m.name}: Zu diesem Zeitpunkt gibt es schon eine Ablesung.` }); return; }
      if (m.kind === "gauge") { // Momentanwert: kein Zählerstand, darf auch sinken
        if (m.unit === "%" && (value < 0 || value > 100))
          issues.push({ level: "error", code: "range", meter: mid, message: `${m.name}: Prozentwert muss zwischen 0 und 100 liegen.` });
        return;
      }
      if (value < 0) issues.push({ level: "error", code: "negative", meter: mid, message: `${m.name}: negativer Zählerstand.` });
      if (prev && !reset) {
        if (value < prev.value - 1e-9)
          issues.push({ level: "error", code: "not_monotonic", meter: mid,
            message: `${m.name}: ${value} liegt unter dem Vorwert ${prev.value} (${C.isoBerlin(prev.t).slice(0, 16).replace("T", " ")}). Nur mit „Reset“ speicherbar.` });
        const days = (t - prev.t) / C.DAY;
        deltas[mid] = { prevValue: prev.value, prevT: prev.t, delta: value - prev.value, days };
        if (days > cfg.gap_days) issues.push({ level: "info", code: "gap", meter: mid, message: `${m.name}: ${days.toFixed(0)} Tage seit der letzten Ablesung.` });
      }
      if (next && !next.reset && next.value < value - 1e-9)
        issues.push({ level: "error", code: "breaks_next", meter: mid,
          message: `${m.name}: ${value} liegt über der späteren Ablesung ${next.value} (${C.isoBerlin(next.t).slice(0, 16).replace("T", " ")}).` });
    });

    // WP-Unterzähler ≤ Hauszähler; Haushaltsstrom 3–9 kWh/Tag
    if ("hp_el" in values && "house_el" in values && !resetSet.has("hp_el") && !resetSet.has("house_el") && deltas.hp_el && deltas.house_el) {
      const t0 = deltas.hp_el.prevT;
      const house = C.consumption(C.intervals((by.house_el || []).concat([{ t, value: values.house_el, reset: false }])), t0, t);
      if (house.hours >= C.hours(t0, t) - 1e-6) {
        const dHp = deltas.hp_el.delta;
        if (dHp > house.value + HOUSE_RESOLUTION) {
          issues.push({ level: "error", code: "submeter_exceeds_main", meter: "hp_el",
            message: `WP-Zähler Δ ${dHp.toFixed(2)} kWh > Hauszähler Δ ${house.value.toFixed(2)} kWh im selben Zeitraum. Ablesefehler oder vertauscht?` });
        } else {
          const days = C.hours(t0, t) / 24;
          if (days >= 1) {
            const perDay = (house.value - dHp) / days;
            deltas.household = { delta: house.value - dHp, perDay, days };
            if (perDay < cfg.household_min_kwh_day || perDay > cfg.household_max_kwh_day)
              issues.push({ level: "warning", code: "household_range",
                message: `Haushaltsstrom ${perDay.toFixed(1)} kWh/Tag liegt außerhalb ${cfg.household_min_kwh_day}–${cfg.household_max_kwh_day} kWh/Tag.` });
          }
        }
      }
    }
    return { issues, deltas };
  }

  const api = { build, validate, baselineModel, investments, HEAT_NOTE };
  root.WPReport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
