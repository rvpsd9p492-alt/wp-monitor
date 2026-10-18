// Auswertung und Plausibilitätsprüfung mit synthetischen Testdaten (keine echten Verbrauchsdaten).
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/calc.js");
const D = require("../js/defaults.js");
const R = require("../js/report.js");

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);
const cfg = Object.fromEntries(D.CONFIG.map(([k, v]) => [k, v]));
cfg.commissioning_ts = "2026-10-16T10:00:00+02:00";
cfg.hp_own_share_eur = 20000;

function sample() {
  const rd = (meter, ts, value, reset) => ({ id: meter + ts, meter, ts, value, reset: !!reset });
  return {
    readings: [
      rd("house_el", "2026-10-16T10:00", 1000, true), rd("hp_el", "2026-10-16T10:00", 0, true), rd("hp_heat_total", "2026-10-16T10:00", 0, true),
      rd("house_el", "2026-10-17T14:20", 1016), rd("hp_el", "2026-10-17T14:20", 12.38), rd("hp_heat_total", "2026-10-17T14:20", 36),
    ],
    tariffs: [
      { energy: "electricity", validFrom: "2026-06-01", validTo: "2027-05-31", ct: 28.80, baseYear: 166.44 },
      { energy: "gas", validFrom: "2026-06-01", validTo: null, ct: 9.75, baseYear: 121.14 },
    ],
    reliefs: [],
    degreeDays: D.GTZ_MANNHEIM.map(([month, gtz, lt]) => ({ month, station: "Mannheim", gtz, gtzLongterm: lt })),
    baseline: [2022, 2023, 2024, 2025].map((year) => ({ year, gasM3: 800, factor: 11, days: year === 2024 ? 366 : 365 })),
    investments: [{ scenario: "gas_alternative", item: "Gaskessel", gross: 15000, subsidy: 0 }],
    events: [],
  };
}
const METERS = D.METERS;
const ts = (s) => C.parseTs(s);

test("6 niedrigerer Zählerstand nur mit Reset", () => {
  const d = sample();
  let r = R.validate(d, METERS, cfg, ts("2026-10-20T10:00"), { hp_el: 10 }, []);
  assert.ok(r.issues.some((i) => i.code === "not_monotonic" && i.level === "error"));
  r = R.validate(d, METERS, cfg, ts("2026-10-20T10:00"), { hp_el: 10 }, ["hp_el"]);
  assert.ok(!r.issues.some((i) => i.level === "error"));
});

test("Unterzähler darf Hauszähler nicht übersteigen", () => {
  const r = R.validate(sample(), METERS, cfg, ts("2026-10-20T10:00"), { house_el: 1023, hp_el: 40 }, []);
  assert.ok(r.issues.some((i) => i.code === "submeter_exceeds_main"));
});

test("7 Haushaltsstrom = ΔHaus − ΔWP", () => {
  const r = R.validate(sample(), METERS, cfg, ts("2026-10-20T14:20"), { house_el: 1076, hp_el: 52.38 }, []);
  near(r.deltas.household.delta, 20, 1e-9);
  near(r.deltas.household.perDay, 20 / 3, 1e-9);
  assert.ok(!r.issues.some((i) => i.level !== "info"));
  const w = R.validate(sample(), METERS, cfg, ts("2026-10-20T14:20"), { house_el: 1093, hp_el: 52.38 }, []);
  assert.ok(w.issues.some((i) => i.code === "household_range"));
});

test("Doppelte Ablesung zum selben Zeitpunkt wird abgelehnt", () => {
  const r = R.validate(sample(), METERS, cfg, ts("2026-10-17T14:20"), { hp_el: 13 }, []);
  assert.ok(r.issues.some((i) => i.code === "duplicate"));
});

test("Dashboard nach 28 h: Monatswerte ja, AZ noch nicht", () => {
  const d = R.build(sample(), cfg, ts("2026-10-17T15:00"));
  assert.equal(d.kpis.az.value, null);
  const oct = d.months[0];
  assert.equal(oct.month, "2026-10");
  near(oct.hpEl, 12.38, 1e-9); near(oct.household, 16 - 12.38, 1e-9); near(oct.heat, 36, 1e-9);
  near(d.kpis.breakEvenAz.value, 2.658, 0.001);
  near(d.investment.delta, 5000, 1e-9);
});

test("Dashboard nach einem Monat", () => {
  const data = sample();
  data.readings.push({ meter: "house_el", ts: "2026-11-16T10:00", value: 1480 },
    { meter: "hp_el", ts: "2026-11-16T10:00", value: 320 }, { meter: "hp_heat_total", ts: "2026-11-16T10:00", value: 1150 });
  const d = R.build(data, cfg, ts("2026-11-16T12:00"));
  assert.equal(d.kpis.az.label, "AZ seit Inbetriebnahme");
  near(d.kpis.az.value, 1150 / 320, 1e-9);
  assert.match(d.kpis.savingsPerYear.method, /^Hochrechnung/);
  assert.ok(d.amortization.vsGasYears > 0);
  assert.equal(d.sensitivity.rows.length, 12);
  assert.deepEqual(d.months.map((m) => m.month), ["2026-10", "2026-11"]);
  near(d.months.reduce((a, m) => a + m.hpEl, 0), 320, 1e-9);
  // erwartete Heizwärme für Oktober aus Baseline × GTZ fehlt, weil Oktober 2026 keine GTZ hat
  assert.equal(d.months[0].heatingExpected, null);
  assert.ok(d.warnings.some((w) => w.code === "gtz_missing" && /2026-10/.test(w.text)));
});

test("Heizbedarf je Gradtag aus den Referenzjahren", () => {
  const b = R.baselineModel(sample(), cfg);
  assert.deepEqual(b.gtzYearsComplete, [2022, 2023, 2024, 2025]);
  // (4 × 8800 − 10 × 1461) / (2713,0 + 2626,7 + 2704,1 + 2914,8)
  near(b.kwhHsPerGtz, (35200 - 14610) / 10958.6, 1e-6);
  assert.equal(b.note, null);
});

test("Gradtagzahlen: G20/15-Probe in Wintermonaten", () => {
  // Liegen alle Tage unter 15 °C, gilt GTZ ≈ Tage × (20 − Monatsmittel); Stichprobe Feb 2024 (Mittel 8,7 °C)
  const feb24 = D.GTZ_MANNHEIM.find((x) => x[0] === "2024-02")[1];
  near(feb24, 29 * (20 - 8.7), 1);
  assert.ok(!D.GTZ_MANNHEIM.some((x) => x[0] === "2026-10"), "laufender Monat darf nicht enthalten sein");
});

test("Zuheizer-Anteil in %: Momentanwert, Schätzung des Heizstab-Stroms", () => {
  const data = sample();
  data.readings.push({ meter: "house_el", ts: "2026-11-16T10:00", value: 1480 },
    { meter: "hp_el", ts: "2026-11-16T10:00", value: 320 }, { meter: "hp_heat_total", ts: "2026-11-16T10:00", value: 1150 },
    { meter: "hp_backup_pct", ts: "2026-11-16T10:00", value: 2 });
  const d = R.build(data, cfg, ts("2026-11-16T12:00"));
  near(d.kpis.backupShare.backupKwh, 0.02 * 1150, 1e-9);
  near(d.kpis.backupShare.value, 0.02 * 1150 / 320, 1e-9); // 7,2 % des WP-Stroms → über der Warnschwelle 5 %
  assert.ok(d.warnings.some((w) => w.code === "backup"));
  assert.equal(d.months[1].backupPct, 2);
  // Momentanwert darf sinken, aber nicht über 100 %
  assert.ok(!R.validate(data, METERS, cfg, ts("2026-12-01T10:00"), { hp_backup_pct: 1 }, []).issues.some((i) => i.level === "error"));
  assert.ok(R.validate(data, METERS, cfg, ts("2026-12-01T10:00"), { hp_backup_pct: 120 }, []).issues.some((i) => i.code === "range"));
});
