// Abnahmekriterien (docs/METHODIK.md, Abschnitt Testfälle). Ausführen: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/calc.js");

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ""} ${a} ≉ ${b} (±${tol})`);
const NEW = { energy: "electricity", validFrom: "2025-06-01", validTo: "2026-05-31", ct: 30.66, baseYear: 171.24, provider: "NEW", product: "Fair Strom 12" };
const EPRIMO = { energy: "electricity", validFrom: "2026-06-01", validTo: "2027-05-31", ct: 28.80, baseYear: 166.44, provider: "eprimo", product: "Pur 18" };
const GAS = { energy: "gas", validFrom: "2026-06-01", validTo: null, ct: 9.75, baseYear: 121.14, provider: "TEAG", product: "Verlängerung" };
const A = { eta: 0.9, gasOther: 0, hpOther: 0 };

test("Zeitzone: Berliner Ortszeit und ISO-Ausgabe", () => {
  assert.equal(C.parseTs("2026-10-16T10:00"), Date.parse("2026-10-16T10:00:00+02:00"));
  assert.equal(C.parseTs("2026-11-03T10:00"), Date.parse("2026-11-03T10:00:00+01:00"));
  assert.equal(C.isoBerlin(Date.parse("2026-10-16T08:00:00Z")), "2026-10-16T10:00:00+02:00");
  assert.equal(C.localInput(Date.parse("2026-12-31T23:30:00Z")), "2027-01-01T00:30");
  assert.deepEqual(C.monthsBetween(C.parseTs("2026-11-15T00:00"), C.parseTs("2027-02-01T00:00")), ["2026-11", "2026-12", "2027-01", "2027-02"]);
});

test("1 Gas-Umrechnung", () => near(C.gasKwhHs(822, 11.059), 9090.5, 0.05));

test("2 Break-even-AZ", () => near(C.breakEvenAz(28.80, 9.75, 0.90), 2.658, 0.0005));

test("3 Referenz-Jahresrechnung", () => {
  const r = C.annualComparison({ heat: 7670, az: 3.5, ctEl: 28.80, ctGas: 9.75, baseGas: 121.14, eta: 0.90 });
  near(r.hpEl, 2191, 0.5); near(r.costHp, 631.10, 0.05); near(r.gasHs, 8522, 0.5);
  near(r.costGas, 952.05, 0.05); near(r.savings, 321, 0.5);
  const w = C.annualComparison({ heat: 7670, az: 3.5, ctEl: 28.80, ctGas: 9.75, baseGas: 121.14, eta: 0.90, relief: 150 });
  near(w.savings, 471, 0.5);
});

test("3b dieselbe Rechnung tagesgenau über 365 Tage", () => {
  const t0 = C.parseTs("2026-06-01T00:00"), t1 = C.parseTs("2027-06-01T00:00");
  const r = C.comparePeriod(t0, t1, 7670, 7670 / 3.5, [EPRIMO], [GAS], A);
  near(r.days, 365, 1e-9); near(r.savings, 321, 0.5); near(r.detail.hpEnergy, 631.13, 0.05);
});

test("4 Tarifsplit 20.05.–10.06.2026", () => {
  const c = C.energyCost([NEW, EPRIMO], C.parseTs("2026-05-20T00:00"), C.parseTs("2026-06-10T00:00"), 210);
  assert.deepEqual(c.segments.map((s) => s.tariff), ["NEW Fair Strom 12", "eprimo Pur 18"]);
  near(c.segments[0].kwh, 120, 1e-9); near(c.segments[1].kwh, 90, 1e-9);
  near(c.energy, 120 * 0.3066 + 90 * 0.288, 1e-9);
  near(c.base, 171.24 * 12 / 365 + 166.44 * 9 / 365, 1e-9);
  assert.equal(c.extrapolated, false);
});

test("Tarif nach Laufzeitende wird extrapoliert und markiert", () => {
  const c = C.energyCost([EPRIMO], C.parseTs("2027-06-01T00:00"), C.parseTs("2027-07-01T00:00"), 100);
  assert.equal(c.extrapolated, true); near(c.energy, 28.80, 1e-9);
});

test("5 Monatsinterpolation über die Zeitumstellung", () => {
  const ivs = C.intervals([{ t: C.parseTs("2026-10-16T10:00"), value: 0, reset: true }, { t: C.parseTs("2026-11-03T10:00"), value: 180 }]);
  // 16.10. 10:00 → 01.11. 00:00 = 15 d 14 h + 1 h Zeitumstellung = 375 h; dann 58 h
  near(C.hours(ivs[0].start, ivs[0].end), 433, 1e-9);
  const [o0, o1] = C.monthBounds("2026-10"), [n0, n1] = C.monthBounds("2026-11");
  const oct = C.consumption(ivs, o0, o1), nov = C.consumption(ivs, n0, n1);
  near(oct.value, 180 * 375 / 433, 1e-9); near(nov.value, 180 * 58 / 433, 1e-9);
  assert.ok(oct.interpolated && nov.interpolated);
});

test("Reset beginnt eine neue Reihe", () => {
  const t = (s) => C.parseTs(s);
  const ivs = C.intervals([{ t: t("2026-10-01"), value: 100 }, { t: t("2026-10-10"), value: 150 },
    { t: t("2026-10-11"), value: 5, reset: true }, { t: t("2026-10-20"), value: 25 }]);
  assert.deepEqual(ivs.map((i) => i.delta), [50, 20]);
});

test("§ 14a zählt nur bestätigt", () => {
  const r = [{ validFrom: "2026-01-01", validTo: null, module: "modul1", amountYear: 150, confirmed: false }];
  const t0 = C.parseTs("2026-06-01T00:00"), t1 = C.parseTs("2027-06-01T00:00");
  assert.equal(C.reliefEur(r, t0, t1), 0);
  near(C.reliefEur(r, t0, t1, false), 150, 1e-9);
});

test("Amortisation mit Preisentwicklung", () => {
  assert.equal(C.escalationTable(1000, 900, 600).breakEvenYear, 4);
  assert.equal(C.escalationTable(1000, 900, 600, 0.5).breakEvenYear, 2);
});

test("Taktung", () => {
  const c = C.cycling(30, 10);
  near(c.avgRuntimeMin, 20, 1e-9); near(c.startsPerHour, 3, 1e-9);
  assert.equal(C.cycling(null, 10), null);
});
