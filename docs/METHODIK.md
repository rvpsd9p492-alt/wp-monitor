# Methodik

Wie der WP-Monitor rechnet. Umsetzung in `js/calc.js` (Formeln) und `js/report.js` (Auswertung, Prüfungen).

## Zähler

- **Hauszähler** (geeicht, ganze kWh) enthält den Wärmepumpenstrom mit.
- **WP-Unterzähler** (geeicht) misst die Wärmepumpe inkl. Heizstab.
- **Haushaltsstrom = Hauszähler − WP-Zähler.**
- Werte der Bosch-Regelung (Wärmemengen, Verbrauch je Betriebsart, Heizstab, Starts, Betriebsstunden) sind
  Herstellerangaben, nicht geeicht und werden ganzzahlig **abgeschnitten**. Deshalb immer die Gesamtwerte erfassen
  und Arbeitszahlen erst ab etwa einer Woche Abstand rechnen (`min_az_interval_days`).
- Fehlende Werte werden nicht geschätzt, sondern als „nicht verfügbar“ ausgewiesen.

## Verbrauch je Intervall und Monat

- Verbrauch = Differenz zweier aufeinanderfolgender Ablesungen derselben Reihe. **Reset** (Zählertausch) beginnt eine
  neue Reihe ohne Differenz zum Vorwert.
- Verteilung auf Kalendermonate **linear über die Stunden** zwischen zwei Ablesungen; anteilig enthaltene Intervalle
  werden markiert (~). Monatsgrenzen in Europe/Berlin, Dauern über UTC (Zeitumstellung zählt richtig).

## Effizienz

- **AZ** = Wärme / Strom_WP (Strom vom geeichten Unterzähler, Wärme aus der Regelung:
  „Erzeugte Energie Total“, sonst Heizen + Warmwasser).
- AZ Heizen / Warmwasser nur, wenn die Regelung den Strom je Betriebsart liefert.
- **Heizstab-Anteil** = Zuheizer-Energie / Strom_WP; Warnung über `backup_warn_share`. Die Bosch-Regelung zeigt die
  Zuheizer-Energie in kWh getrennt nach Heizung und Warmwasser (kein Gesamtwert); die App addiert beide. Ersatzweise,
  wenn keine kWh erfasst sind: Zuheizer-Anteil in % aus dem Energie-Monitoring × erzeugte Wärme (als „geschätzt“
  gekennzeichnet; ein Heizstab wandelt Strom 1:1 in Wärme).
- Zähler der Regelung stehen bei Inbetriebnahme auf 0 (`controller_counters_start_zero`): Ein neu erfasster Wert ohne
  eigenen Startwert zählt ab `commissioning_ts`.
- **JAZ** gleitend über 12 Monate, erst ab 12 Monaten Daten; vorher „AZ seit Inbetriebnahme“.
- **Taktung**: Starts/Betriebsstunde und mittlere Laufzeit je Start, getrennt nach Heizung und Warmwasser (Gesamt =
  Summe). Die Warnung unter `min_runtime_warn_min` bezieht sich auf den Heizbetrieb, weil lange Warmwasser-Läufe den
  Gesamtwert schönen; ohne getrennte Werte auf den Gesamtwert.

## Kontrafaktisches Gas-Szenario

```
Gas_Hs     = Wärme / boiler_efficiency_hs
Kosten_Gas = Gas_Hs × AP_Gas + GP_Gas × Tage/365 + gas_other_costs × Tage/365
Kosten_WP  = Strom_WP × AP_Strom − Entlastung_14a × Tage/365 + hp_other_costs × Tage/365
Ersparnis  = Kosten_Gas − Kosten_WP
```

- Der **Strom-Grundpreis wird der WP nicht zugerechnet** (fällt in beiden Szenarien an).
- Tarife **tagesgenau**; ein Zeitraum über einen Tarifwechsel wird zeitanteilig gesplittet. Ohne gültigen Tarif wird
  der nächstliegende verwendet und markiert.
- § 14a-Entlastung zählt nur, wenn sie als bestätigt eingetragen ist.
- Ohne Wärmemengen der Regelung: Wärme aus der Baseline geschätzt (Heizen über Gradtagzahlen + Warmwasser-Grundlast),
  deutlich als „geschätzt“ markiert; dafür wird keine AZ ausgewiesen.

## Baseline und Witterung

```
Heizanteil_Gas_Hs(Jahr) = Gas_Hs(Jahr) − dhw_share_baseline_kwh_day × Tage
kWh_Hs_pro_GTZ          = Σ Heizanteil_Gas_Hs / Σ GTZ           (Referenzjahre mit vollständigen GTZ)
Heizwärme_erwartet      = kWh_Hs_pro_GTZ × GTZ_Monat × boiler_efficiency_hs
Heizwärme_normiert      = Heizwärme × GTZ_langjährig / GTZ_Monat
```

Warnung bei Abweichung gemessen/erwartet über `heating_deviation_warn`. Gradtagzahlen G20/15 (Station Mannheim,
wetterkontor.de) liegen in `js/defaults.js`; das „langjährige Mittel“ ist ersatzweise das Monatsmittel 2016–2025.

## Wirtschaftlichkeit

- **Break-even-AZ** = AP_Strom / (AP_Gas / η).
- **Ersparnis pro Jahr**: ab 12 Monaten gemessen, vorher Hochrechnung Referenz-Nutzwärme × AZ seit Inbetriebnahme ×
  aktuelle Tarife.
- **Amortisation**: Vollinvestition (Eigenanteil / Ersparnis), gegen die vermiedene Gas-Investition
  ((Eigenanteil − Gas-Alternative) / Ersparnis) und als 20-Jahres-Tabelle mit Preisentwicklung und Diskontsatz.
- **Sensitivität** für η ∈ {0,85; 0,90; 0,95} × AZ ∈ {2,5; 3,0; 3,5; 4,0} bei gleicher Gasmenge.

## Plausibilitätsprüfungen beim Speichern

| Prüfung | Regel | Schwere |
|---|---|---|
| Zähler monoton | Wert ≥ Vorwert (außer Reset) und ≤ späterer Wert | Fehler, nicht gespeichert |
| Unterzähler ≤ Hauszähler | ΔWP ≤ ΔHaus + 1 kWh im selben Zeitraum | Fehler |
| Haushaltsstrom | `household_min_kwh_day` … `household_max_kwh_day` | Warnung |
| Arbeitszahl | unter Break-even; außerhalb `az_plausible_min` … `az_plausible_max` | Warnung |
| Lücke | mehr als `gap_days` ohne Ablesung | Hinweis |

## Testfälle (`tests/`)

1. 822 m³ × 11,059 kWh/m³ = 9.090,5 kWh
2. Break-even-AZ bei 28,80 ct Strom, 9,75 ct Gas, η 0,90 = 2,658
3. Wärme 7.670 kWh, AZ 3,5: Kosten WP 631,10 €, Kosten Gas 952,05 €, Ersparnis ≈ 321 € (mit 150 € § 14a ≈ 471 €)
4. Zeitraum 20.05.–10.06.2026 wird anteilig mit beiden Stromtarifen bewertet
5. Ablesungen 16.10.2026 (0 kWh) und 03.11.2026 (180 kWh) korrekt auf Oktober und November verteilt (inkl. Zeitumstellung)
6. WP-Zählerstand unter dem Vorwert wird abgelehnt, außer mit Reset
7. Haushaltsstrom = ΔHaus − ΔWP
