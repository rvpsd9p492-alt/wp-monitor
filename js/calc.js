/* Rechenlogik (UI- und speicherunabhängig), siehe docs/METHODIK.md.
   Zeitpunkte sind intern Millisekunden seit 1970 (UTC). Kalendergrenzen (Tage, Monate)
   werden in Europe/Berlin bestimmt; Dauern sind damit über die Zeitumstellung korrekt. */
(function (root) {
  "use strict";
  const H = 3600 * 1000, DAY = 24 * H, EPS = 1e-9;

  /* ---------- Zeit (Europe/Berlin) ---------- */
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  function parts(t) {
    const p = {};
    fmt.formatToParts(new Date(t)).forEach((x) => { if (x.type !== "literal") p[x.type] = +x.value; });
    return p;
  }
  function offset(t) { // Abstand Berlin–UTC in ms zum Zeitpunkt t
    const p = parts(t);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  }
  /** Berliner Ortszeit → ms. Monat 1–12; Überlauf (Tag 32, Monat 13) ist erlaubt. */
  function berlin(y, mo, d, h, mi) {
    const guess = Date.UTC(y, mo - 1, d || 1, h || 0, mi || 0);
    let t = guess - offset(guess);
    const o2 = offset(t);
    if (guess - o2 !== t) t = guess - o2;
    return t;
  }
  /** ISO 8601 parsen; ohne Offset gilt Berliner Ortszeit. */
  function parseTs(v) {
    if (typeof v === "number") return v;
    const s = String(v).trim();
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!m) return NaN;
    return berlin(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
  }
  const pad = (n) => String(n).padStart(2, "0");
  /** ms → ISO mit Berliner Offset, z. B. 2026-10-16T10:00:00+02:00 */
  function isoBerlin(t) {
    const p = parts(t), o = Math.round(offset(t) / 60000), sign = o >= 0 ? "+" : "-", a = Math.abs(o);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(a / 60 | 0)}:${pad(a % 60)}`;
  }
  /** ms → Wert für <input type="datetime-local"> in Berliner Zeit */
  function localInput(t) { return isoBerlin(t).slice(0, 16); }
  function parseDate(v) { // "YYYY-MM-DD" → {y,m,d} oder null
    if (!v) return null;
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  const dayStart = (d) => berlin(d.y, d.m, d.d);
  const dayAfter = (d) => berlin(d.y, d.m, d.d + 1);
  function monthBounds(key) {
    const [y, m] = key.split("-").map(Number);
    return [berlin(y, m, 1), berlin(y, m + 1, 1)];
  }
  function monthKey(t) { const p = parts(t); return `${p.year}-${pad(p.month)}`; }
  function monthsBetween(t0, t1) {
    const a = parts(t0), b = parts(t1), out = [];
    let y = a.year, m = a.month;
    while (y < b.year || (y === b.year && m <= b.month)) {
      out.push(`${y}-${pad(m)}`);
      if (m === 12) { y++; m = 1; } else m++;
    }
    return out;
  }
  const hours = (a, b) => (b - a) / H;

  /* ---------- Zählerstände ---------- */
  /** readings: [{t, value, reset}] → Intervalle [{start, end, delta}]. Ein Reset beginnt eine neue Reihe. */
  function intervals(readings) {
    const rs = readings.slice().sort((a, b) => a.t - b.t), out = [];
    for (let i = 1; i < rs.length; i++) {
      const p = rs[i - 1], c = rs[i];
      if (c.reset || c.t <= p.t) continue;
      out.push({ start: p.t, end: c.t, delta: c.value - p.value });
    }
    return out;
  }
  /** Verbrauch im Fenster [t0, t1), linear über die Stunden verteilt (5.1). */
  function consumption(ivs, t0, t1) {
    const s = { value: 0, hours: 0, interpolated: false };
    (ivs || []).forEach((iv) => {
      const lo = Math.max(t0, iv.start), hi = Math.min(t1, iv.end), ov = hours(lo, hi);
      if (ov <= 0) return;
      const frac = ov / hours(iv.start, iv.end);
      s.value += iv.delta * frac;
      s.hours += ov;
      if (frac < 1 - EPS) s.interpolated = true;
    });
    s.days = s.hours / 24;
    return s;
  }
  function coverage(ivs) {
    if (!ivs || !ivs.length) return null;
    return [Math.min(...ivs.map((i) => i.start)), Math.max(...ivs.map((i) => i.end))];
  }

  /* ---------- Tarife ---------- */
  // tariff: {energy, validFrom, validTo, ct, baseYear, provider, product}
  const tStart = (t) => dayStart(parseDate(t.validFrom));
  const tEnd = (t) => (t.validTo ? dayAfter(parseDate(t.validTo)) : Infinity);
  const tLabel = (t) => `${t.provider || ""} ${t.product || ""}`.trim();
  /** Gültiger Tarif zum Zeitpunkt; extrapolated = kein Tarif gültig, nächstliegender verwendet. */
  function tariffAt(tariffs, t) {
    const cov = tariffs.filter((x) => tStart(x) <= t && t < tEnd(x));
    if (cov.length) return { tariff: cov.reduce((a, b) => (b.validFrom > a.validFrom ? b : a)), extrapolated: false };
    const before = tariffs.filter((x) => tEnd(x) <= t);
    if (before.length) return { tariff: before.reduce((a, b) => (b.validTo > a.validTo ? b : a)), extrapolated: true };
    if (tariffs.length) return { tariff: tariffs.reduce((a, b) => (b.validFrom < a.validFrom ? b : a)), extrapolated: true };
    return { tariff: null, extrapolated: true };
  }
  /** Bewertet kwh, gleichmäßig über [t0, t1) verteilt, tagesgenau; Split an Tarifwechseln (5.3). */
  function energyCost(tariffs, t0, t1, kwh) {
    const total = hours(t0, t1), r = { segments: [], energy: 0, base: 0, extrapolated: false };
    if (total <= 0 || !tariffs.length) return r;
    const cuts = new Set([t0, t1]);
    tariffs.forEach((x) => [tStart(x), tEnd(x)].forEach((b) => { if (b > t0 && b < t1) cuts.add(b); }));
    const pts = [...cuts].sort((a, b) => a - b);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], h = hours(a, b);
      const { tariff, extrapolated } = tariffAt(tariffs, a + (b - a) / 2);
      const part = kwh * h / total;
      const seg = { start: a, end: b, tariff: tLabel(tariff), ct: tariff.ct, baseYear: tariff.baseYear, extrapolated,
        kwh: part, energy: part * tariff.ct / 100, base: tariff.baseYear * h / 24 / 365 };
      r.segments.push(seg); r.energy += seg.energy; r.base += seg.base; r.extrapolated = r.extrapolated || extrapolated;
    }
    return r;
  }

  /* ---------- § 14a ---------- */
  /** Zeitanteilige Entlastung; nur bestätigte, außer confirmedOnly=false. */
  function reliefEur(reliefs, t0, t1, confirmedOnly) {
    const only = confirmedOnly !== false;
    let sum = 0;
    reliefs.forEach((r) => {
      if (r.module === "none" || !r.amountYear || (only && !r.confirmed)) return;
      const lo = Math.max(t0, dayStart(parseDate(r.validFrom)));
      const hi = Math.min(t1, r.validTo ? dayAfter(parseDate(r.validTo)) : Infinity);
      const h = hours(lo, hi);
      if (h > 0) sum += r.amountYear * h / 24 / 365;
    });
    return sum;
  }

  /* ---------- Wirtschaftlichkeit ---------- */
  const gasKwhHs = (m3, factor) => m3 * factor;
  const breakEvenAz = (ctEl, ctGas, eta) => ctEl / (ctGas / eta);
  /** Kontrafaktisches Gas-Szenario für ein Fenster (5.3). Strom-Grundpreis zählt bewusst nicht zur WP. */
  function comparePeriod(t0, t1, heat, hpEl, elT, gasT, a, relief) {
    const days = hours(t0, t1) / 24, rel = relief || 0;
    const gasHs = heat / a.eta;
    const gas = energyCost(gasT, t0, t1, gasHs), el = energyCost(elT, t0, t1, hpEl);
    const gasOther = (a.gasOther || 0) * days / 365, hpOther = (a.hpOther || 0) * days / 365;
    const costGas = gas.energy + gas.base + gasOther, costHp = el.energy - rel + hpOther;
    return { days, heat, hpEl, gasHs, costGas, costHp, savings: costGas - costHp,
      detail: { gasEnergy: gas.energy, gasBase: gas.base, gasOther, hpEnergy: el.energy, relief14a: rel, hpOther,
        gasSegments: gas.segments, elSegments: el.segments, tariffExtrapolated: gas.extrapolated || el.extrapolated } };
  }
  /** Jahresrechnung mit konstanten Preisen (Referenzfall 9.3, Sensitivität). */
  function annualComparison(o) {
    const hpEl = o.heat / o.az, gasHs = o.heat / o.eta;
    const costHp = hpEl * o.ctEl / 100 - (o.relief || 0) + (o.hpOther || 0);
    const costGas = gasHs * o.ctGas / 100 + o.baseGas + (o.gasOther || 0);
    return { hpEl, gasHs, costHp, costGas, savings: costGas - costHp };
  }
  const paybackYears = (invest, savings) => (savings > 0 ? invest / savings : null);
  /** Kumulierter Saldo über n Jahre mit Preisentwicklung (5.5, Sicht 3). */
  function escalationTable(invest, gasY1, hpY1, escGas, escEl, discount, years) {
    const rows = [];
    let cum = -invest, be = null;
    for (let n = 1; n <= (years || 20); n++) {
      const g = gasY1 * Math.pow(1 + (escGas || 0), n - 1), h = hpY1 * Math.pow(1 + (escEl || 0), n - 1);
      const s = (g - h) / Math.pow(1 + (discount || 0), n);
      cum += s;
      if (be === null && cum >= 0) be = n;
      rows.push({ year: n, costGas: g, costHp: h, savings: s, cumulative: cum });
    }
    return { rows, breakEvenYear: be };
  }

  /* ---------- Effizienz ---------- */
  const ratio = (n, d) => (n == null || d == null || Math.abs(d) < EPS ? null : n / d);
  function cycling(dStarts, dHours) {
    if (!dStarts || !dHours) return null;
    return { startsPerHour: dStarts / dHours, avgRuntimeMin: dHours / dStarts * 60 };
  }

  /* ---------- Baseline / Witterung ---------- */
  /** Σ(Gas_Hs − WW-Grundlast × Tage) / Σ GTZ über Jahre mit vollständigen GTZ (5.4). */
  function heatingPerGtz(years, gtzByYear, dhwDay) {
    let num = 0, den = 0;
    years.forEach((y) => {
      const g = gtzByYear[y.year];
      if (!g) return;
      num += y.gasHs - dhwDay * y.days;
      den += g;
    });
    return den > 0 ? num / den : null;
  }
  const weatherNormalized = (heat, gtz, lt) => (!gtz || !lt ? null : heat * lt / gtz);

  const api = { H, DAY, berlin, parseTs, isoBerlin, localInput, parseDate, dayStart, monthBounds, monthKey,
    monthsBetween, hours, intervals, consumption, coverage, tariffAt, energyCost, tLabel, reliefEur, gasKwhHs,
    breakEvenAz, comparePeriod, annualComparison, paybackYears, escalationTable, ratio, cycling, heatingPerGtz,
    weatherNormalized };
  root.WPCalc = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
