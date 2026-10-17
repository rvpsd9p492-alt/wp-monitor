# WP-Monitor

Offline-Web-App für das Effizienz- und Wirtschaftlichkeitstracking einer Wärmepumpe: monatlich Zählerstände erfassen,
daraus Arbeitszahl (AZ/JAZ), Vergleich mit dem Szenario „Gasheizung weiterbetrieben“, Amortisation und
Plausibilitätswarnungen. Rechenweg: [docs/METHODIK.md](docs/METHODIK.md).

**App öffnen:** https://rvpsd9p492-alt.github.io/wp-monitor/

## Auf iPhone/iPad installieren

1. Link oben in **Safari** öffnen.
2. **Teilen → Zum Home-Bildschirm**.
3. Einmal mit Internet starten – danach läuft die App auch ohne Netz.
4. **Sicherung → Datei importieren**: eigene Startdaten-Datei (JSON) laden. Sie ist bewusst nicht im Repository.

## Bedienung

- **Erfassen**: Zählerstände eintragen (leere Felder sind erlaubt). Δ seit der letzten Ablesung und Haushaltsstrom
  erscheinen beim Tippen; Fehler (z. B. Wert unter dem Vorwert) verhindern das Speichern. „Reset“ nur bei Zählertausch.
- **Auswertung**: Kennzahlen mit aufklappbarer Rechnung, Monatstabelle, Amortisation, Sensitivität, Warnungen.
- **Stammdaten**: Annahmen, Tarife, § 14a, Investitionen, Gradtagzahlen (monatlich nachtragen: `2026-10;245,3`),
  Baseline der Gas-Ära, Ereignisse.
- **Sicherung**: Cloud-Abgleich, Export/Import als JSON-Datei, CSV-Export je Tabelle.

## Daten

Alle Daten liegen auf dem Gerät (localStorage, Schlüssel `wp.*`). Im Repository stehen nur öffentliche Vorgaben
(`js/defaults.js`: Zähler, Annahmen, Gradtagzahlen Mannheim). Persönliche Daten kommen per Import oder Cloud.

Safari kann Daten von Websites löschen, die länger nicht geöffnet wurden. Für die Home-Bildschirm-App gilt das nach
Apple-Angaben nicht; trotzdem Cloud-Sicherung nutzen oder regelmäßig exportieren.

## Cloud-Sicherung (Supabase)

Gleiches Supabase-Projekt und gleiches Konto wie die Leichtathletik-App, eigene Tabelle `wp_records`
(Migration `supabase/migrations/20261017200000_wp_records.sql`, Row Level Security: jeder sieht nur seine Zeilen).
URL und Publishable Key in `js/config.js`. Abgleich je Datensatz, neuere Änderung gewinnt (auch serverseitig per
Trigger), Löschungen werden übertragen, Offline-Änderungen beim nächsten Online-Start nachgeholt.

## Entwicklung

- Rechenlogik ohne Oberfläche: `js/calc.js`, `js/report.js`; Tests: `node --test tests/*.test.js`
- Lokal starten: im übergeordneten Ordner `python3 -m http.server` und `http://localhost:8000/wp-monitor/` öffnen.
- **Bei jeder Änderung `CACHE` in `sw.js` hochzählen**, sonst laden installierte Geräte neue Dateien nicht vollständig.

Chart.js 4.4.1 (MIT) liegt in `vendor/`.
