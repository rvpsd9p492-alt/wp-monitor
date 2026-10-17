/* Öffentliche Vorgaben: Zähler, Annahmen, Gradtagzahlen. Persönliche Daten (Zählerstände, Tarife, Investitionen,
   Gas-Historie) gehören NICHT hierher, sondern in die eigene Startdaten-Datei (Import über „Sicherung“). */
(function (root) {
  "use strict";
  const METERS = [
      {
          "id": "house_el",
          "name": "Hauszähler Strom (1.8.0)",
          "unit": "kWh",
          "source": "physical",
          "decimals": 0
      },
      {
          "id": "hp_el",
          "name": "WP-Unterzähler Strom (T1)",
          "unit": "kWh",
          "source": "physical",
          "decimals": 2
      },
      {
          "id": "hp_heat_total",
          "name": "Erzeugte Energie Total (Bosch, Gesamt)",
          "unit": "kWh",
          "source": "controller",
          "decimals": 0
      },
      {
          "id": "hp_heat_heating",
          "name": "Wärmemenge Heizen (Bosch)",
          "unit": "kWh",
          "source": "controller",
          "decimals": 0
      },
      {
          "id": "hp_heat_dhw",
          "name": "Wärmemenge Warmwasser (Bosch)",
          "unit": "kWh",
          "source": "controller",
          "decimals": 0
      },
      {
          "id": "hp_el_ctrl_total",
          "name": "Verbrauch Total (Bosch, Gesamt)",
          "unit": "kWh",
          "source": "controller",
          "decimals": 0
      },
      {
          "id": "hp_el_heating",
          "name": "Verbrauch Heizung (Bosch)",
          "unit": "kWh",
          "source": "controller",
          "decimals": 0
      },
      {
          "id": "hp_el_dhw",
          "name": "Verbrauch Warmwasser (Bosch)",
          "unit": "kWh",
          "source": "controller",
          "decimals": 0
      },
      {
          "id": "hp_el_backup",
          "name": "Energie Heizstab / Zuheizer (Bosch)",
          "unit": "kWh",
          "source": "controller",
          "decimals": 0
      },
      {
          "id": "hp_compressor_hours",
          "name": "Verdichter-Betriebsstunden",
          "unit": "h",
          "source": "controller",
          "decimals": 0
      },
      {
          "id": "hp_compressor_starts",
          "name": "Verdichter-Starts",
          "unit": "count",
          "source": "controller",
          "decimals": 0
      },
      {
          "id": "gas_m3",
          "name": "Gaszähler (nur Historie)",
          "unit": "m³",
          "source": "physical",
          "decimals": 3,
          "historyOnly": true
      },
      {
          "id": "water_m3",
          "name": "Wasserzähler (nur Historie)",
          "unit": "m³",
          "source": "physical",
          "decimals": 3,
          "historyOnly": true
      }
  ];

  // [Schlüssel, Default, Status, Bedeutung]
  const CONFIG = [
    ["commissioning_ts", null, "FEST", "Inbetriebnahme (ISO-Zeitpunkt). Leer = erste Ablesung des WP-Zählers"],
    ["boiler_efficiency_hs", 0.90, "ANNAHME", "Jahresnutzungsgrad Altkessel bezogen auf Hs"],
    ["gas_factor_kwh_m3", 11.06, "FEST", "Zustandszahl × Brennwert laut Gasrechnung"],
    ["gas_other_costs_eur_year", 0, "OFFEN", "Schornsteinfeger + Kesselwartung, die wegfallen"],
    ["hp_other_costs_eur_year", 0, "OFFEN", "Wartung Wärmepumpe"],
    ["dhw_share_baseline_kwh_day", 10.0, "FEST", "Sommer-Grundlast Gas (Hs) in der Gas-Ära"],
    ["baseline_ref_years", [2022, 2023, 2024, 2025], "ANNAHME", "Referenzjahre für Gasverbrauch und kWh/GTZ"],
    ["hp_own_share_eur", null, "ANNAHME", "Eigenanteil WP. Leer = aus Investitionen berechnen"],
    ["price_escalation_gas", 0, "ANNAHME", "Preissteigerung Gas p.a. (Szenario, 0.03 = 3 %)"],
    ["price_escalation_el", 0, "ANNAHME", "Preissteigerung Strom p.a. (Szenario)"],
    ["discount_rate", 0, "ANNAHME", "Diskontsatz für Barwert"],
    ["min_az_interval_days", 7, "ANNAHME", "Mindestdauer für eine Arbeitszahl (Ganzzahl-Anzeige der Regelung)"],
    ["backup_warn_share", 0.05, "ANNAHME", "Warnschwelle Heizstab-Anteil"],
    ["min_runtime_warn_min", 20, "ANNAHME", "Warnschwelle mittlere Laufzeit pro Start (min)"],
    ["heating_deviation_warn", 0.25, "ANNAHME", "Warnschwelle Heizwärme gemessen vs. erwartet"],
    ["household_min_kwh_day", 3, "ANNAHME", "Haushaltsstrom Untergrenze"],
    ["household_max_kwh_day", 9, "ANNAHME", "Haushaltsstrom Obergrenze"],
    ["az_plausible_min", 1.5, "ANNAHME", "AZ darunter: Ablesefehler?"],
    ["az_plausible_max", 6.0, "ANNAHME", "AZ darüber: Ablesefehler?"],
    ["gap_days", 45, "ANNAHME", "Hinweis bei Ablesepause länger als (Tage)"],
    ["degree_day_station", "Mannheim", "ANNAHME", "Station für Gradtagzahlen"],
  ];

  // Gradtagzahlen G20/15, Station Mannheim, wetterkontor.de (Monats- und Jahreswerte), abgerufen 17.10.2026.
  // [Monat, GTZ, Monatsmittel 2016–2025 als Ersatz für das langjährige Mittel (ANNAHME)]
  const GTZ_MANNHEIM = [
    ["2016-01", 497.2, 516.8], ["2016-02", 425.2, 420.0], ["2016-03", 432.8, 381.3], ["2016-04", 304.7, 252.7],
    ["2016-05", 109.0, 109.7], ["2016-06", 5.1, 6.5], ["2016-07", 0.0, 0.5], ["2016-08", 11.4, 2.7],
    ["2016-09", 23.3, 65.4], ["2016-10", 311.4, 228.5], ["2016-11", 433.3, 401.9], ["2016-12", 549.0, 485.6],
    ["2017-01", 656.9, 516.8], ["2017-02", 408.9, 420.0], ["2017-03", 327.2, 381.3], ["2017-04", 300.5, 252.7],
    ["2017-05", 101.9, 109.7], ["2017-06", 5.9, 6.5], ["2017-07", 0.0, 0.5], ["2017-08", 0.0, 2.7],
    ["2017-09", 131.3, 65.4], ["2017-10", 248.6, 228.5], ["2017-11", 415.0, 401.9], ["2017-12", 494.7, 485.6],
    ["2018-01", 415.5, 516.8], ["2018-02", 547.1, 420.0], ["2018-03", 458.2, 381.3], ["2018-04", 126.2, 252.7],
    ["2018-05", 50.9, 109.7], ["2018-06", 11.8, 6.5], ["2018-07", 0.0, 0.5], ["2018-08", 10.3, 2.7],
    ["2018-09", 63.4, 65.4], ["2018-10", 213.3, 228.5], ["2018-11", 384.2, 401.9], ["2018-12", 459.2, 485.6],
    ["2019-01", 554.7, 516.8], ["2019-02", 416.0, 420.0], ["2019-03", 353.9, 381.3], ["2019-04", 237.3, 252.7],
    ["2019-05", 197.3, 109.7], ["2019-06", 5.9, 6.5], ["2019-07", 5.2, 0.5], ["2019-08", 0.0, 2.7],
    ["2019-09", 54.9, 65.4], ["2019-10", 204.0, 228.5], ["2019-11", 420.3, 401.9], ["2019-12", 471.0, 485.6],
    ["2020-01", 483.9, 516.8], ["2020-02", 373.5, 420.0], ["2020-03", 377.7, 381.3], ["2020-04", 152.7, 252.7],
    ["2020-05", 129.4, 109.7], ["2020-06", 13.3, 6.5], ["2020-07", 0.0, 0.5], ["2020-08", 0.0, 2.7],
    ["2020-09", 49.1, 65.4], ["2020-10", 243.7, 228.5], ["2020-11", 400.1, 401.9], ["2020-12", 476.3, 485.6],
    ["2021-01", 538.2, 516.8], ["2021-02", 442.2, 420.0], ["2021-03", 409.0, 381.3], ["2021-04", 345.2, 252.7],
    ["2021-05", 217.7, 109.7], ["2021-06", 0.0, 6.5], ["2021-07", 0.0, 0.5], ["2021-08", 5.1, 2.7],
    ["2021-09", 42.3, 65.4], ["2021-10", 294.6, 228.5], ["2021-11", 440.2, 401.9], ["2021-12", 469.3, 485.6],
    ["2022-01", 506.2, 516.8], ["2022-02", 379.3, 420.0], ["2022-03", 388.9, 381.3], ["2022-04", 294.8, 252.7],
    ["2022-05", 42.6, 109.7], ["2022-06", 0.0, 6.5], ["2022-07", 0.0, 0.5], ["2022-08", 0.0, 2.7],
    ["2022-09", 120.3, 65.4], ["2022-10", 133.4, 228.5], ["2022-11", 345.5, 401.9], ["2022-12", 502.0, 485.6],
    ["2023-01", 460.4, 516.8], ["2023-02", 420.4, 420.0], ["2023-03", 366.3, 381.3], ["2023-04", 308.1, 252.7],
    ["2023-05", 87.7, 109.7], ["2023-06", 0.0, 6.5], ["2023-07", 0.0, 0.5], ["2023-08", 0.0, 2.7],
    ["2023-09", 19.0, 65.4], ["2023-10", 160.1, 228.5], ["2023-11", 371.3, 401.9], ["2023-12", 433.4, 485.6],
    ["2024-01", 543.7, 516.8], ["2024-02", 328.4, 420.0], ["2024-03", 328.2, 381.3], ["2024-04", 237.3, 252.7],
    ["2024-05", 54.7, 109.7], ["2024-06", 11.8, 6.5], ["2024-07", 0.0, 0.5], ["2024-08", 0.0, 2.7],
    ["2024-09", 77.3, 65.4], ["2024-10", 218.2, 228.5], ["2024-11", 396.2, 401.9], ["2024-12", 508.3, 485.6],
    ["2025-01", 511.1, 516.8], ["2025-02", 458.7, 420.0], ["2025-03", 370.5, 381.3], ["2025-04", 220.4, 252.7],
    ["2025-05", 106.0, 109.7], ["2025-06", 10.8, 6.5], ["2025-07", 0.0, 0.5], ["2025-08", 0.0, 2.7],
    ["2025-09", 73.2, 65.4], ["2025-10", 257.4, 228.5], ["2025-11", 413.4, 401.9], ["2025-12", 493.3, 485.6],
    ["2026-01", 574.9, 516.8], ["2026-02", 390.8, 420.0], ["2026-03", 369.2, 381.3], ["2026-04", 221.8, 252.7],
    ["2026-05", 103.1, 109.7], ["2026-06", 11.6, 6.5], ["2026-07", 0.0, 0.5], ["2026-08", 0.0, 2.7],
    ["2026-09", 30.2, 65.4],
  ];

  const api = { METERS, CONFIG, GTZ_MANNHEIM, GTZ_SOURCE: "wetterkontor.de" };
  root.WPDefaults = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
