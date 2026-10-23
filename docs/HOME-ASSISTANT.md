# Home Assistant → WP-Monitor

Home Assistant schickt einmal täglich die Zählerstände der Bosch-Regelung an die Cloud-Sicherung (Supabase-Funktion
`wp_ingest`). Die App übernimmt sie beim nächsten Abgleich wie eine eigene Ablesung (markiert mit „HA“).

Von Hand bleiben nur die **geeichten Zähler** (WP-Unterzähler, Hauszähler), die die Regelung nicht kennt –
außer der Hauszähler kommt ebenfalls aus Home Assistant (z. B. über den powerfox poweropti).

## 1. Schlüssel erzeugen

App → **Sicherung → Home Assistant → Schlüssel erzeugen → Als secrets.yaml kopieren** und in Home Assistant in
`secrets.yaml` einfügen:

```yaml
wp_monitor_token: "…"
wp_monitor_apikey: "…"
```

Der Schlüssel darf nur Ablesungen anlegen, nichts lesen oder löschen. „Neuen Schlüssel erzeugen“ macht den alten
ungültig.

## 2. `configuration.yaml`

Die `sensor.…`-Namen sind **Platzhalter**: In Home Assistant unter *Entwicklerwerkzeuge → Zustände* die passenden
Entitäten der Bosch-Integration suchen (Stichworte: energy/Energie, output produced, compressor, eheater,
starts, working time) und eintragen. Zeilen für Werte, die es nicht gibt, einfach löschen.

```yaml
rest_command:
  wp_monitor:
    url: "https://hdtukcemlnhaoirdxitc.supabase.co/rest/v1/rpc/wp_ingest"
    method: POST
    headers:
      apikey: !secret wp_monitor_apikey
    content_type: "application/json"
    payload: >-
      {{ {"p_token": token, "p_values": {
        "hp_heat_total":        states('sensor.SYSTEM_TOTAL_ENERGY_OUTPUT_PRODUCED'),
        "hp_heat_heating":      states('sensor.SYSTEM_HEATING_ENERGY_OUTPUT_PRODUCED'),
        "hp_heat_dhw":          states('sensor.SYSTEM_HOT_WATER_ENERGY_OUTPUT_PRODUCED'),
        "hp_el_ctrl_total":     states('sensor.SYSTEM_TOTAL_ENERGY_ELECTRICITY'),
        "hp_el_heating":        states('sensor.SYSTEM_HEATING_ENERGY_ELECTRICITY'),
        "hp_el_dhw":            states('sensor.SYSTEM_HOT_WATER_ENERGY_ELECTRICITY'),
        "hp_el_backup_heating": states('sensor.SYSTEM_HEATING_ENERGY_EHEATER'),
        "hp_el_backup_dhw":     states('sensor.SYSTEM_HOT_WATER_ENERGY_EHEATER'),
        "hp_compressor_starts_heating": states('sensor.COMPRESSOR_STARTS_CH'),
        "hp_compressor_starts_dhw":     states('sensor.COMPRESSOR_STARTS_DHW'),
        "hp_compressor_hours_heating":  states('sensor.WORKING_TIME_CH'),
        "hp_compressor_hours_dhw":      states('sensor.WORKING_TIME_DHW')
      }} | tojson }}

automation:
  - alias: "WP-Monitor: Zählerstände senden"
    triggers:
      - trigger: time
        at: "23:55:00"
    actions:
      - action: rest_command.wp_monitor
        data:
          token: !secret wp_monitor_token
        response_variable: antwort
      - if: "{{ antwort.status != 200 or (antwort.content.skipped | default([]) | count) > 0 or antwort.content.error is defined }}"
        then:
          - action: persistent_notification.create
            data:
              title: "WP-Monitor"
              message: "Übertragung: {{ antwort.status }} {{ antwort.content }}"
```

Wer die Automation lieber über die Oberfläche anlegt: nur den `rest_command`-Block in `configuration.yaml`, die
Automation dann mit Auslöser „Zeit 23:55“ und Aktion `rest_command.wp_monitor` mit
`token: <Schlüssel>` anlegen.

**Einheiten:** kWh für Energie, Stunden für Betriebszeiten. Liefert ein Sensor Sekunden oder Minuten, umrechnen, z. B.
`(states('sensor.WORKING_TIME_CH') | float(0) / 3600) | round(2)`.

**Zuordnung zur Bosch-Anzeige** [Vermutung]: „Verbrauch Heizung/Warmwasser“ entspricht `electricity` (Kompressor +
Zuheizer). Fehlt `electricity`, die Summe aus `compressor` und `eheater` eintragen, z. B.
`(states('sensor.…_COMPRESSOR') | float(0) + states('sensor.…_EHEATER') | float(0)) | round(3)`.

## 3. Testen

*Entwicklerwerkzeuge → Aktionen → `rest_command.wp_monitor`* mit `token: <Schlüssel>` ausführen. Die Antwort zeigt
`saved` (übernommen) und `skipped` (mit Grund). Danach in der App unter *Sicherung → Jetzt abgleichen*.

## Regeln der Übernahme

- Nur bekannte Zähler; `unavailable`/`unknown` und negative Werte werden übersprungen.
- Ein Wert unter dem letzten Stand wird **nicht** übernommen (Zählerrücksprung). Springt ein Zähler der Regelung
  z. B. zum Jahreswechsel auf 0, die erste Ablesung danach in der App von Hand mit „Reset“ erfassen.
- Höchstens eine Ablesung je Zähler innerhalb von 6 Stunden. Einmal täglich reicht für die Auswertung und hält die
  Datenmenge auf dem iPhone klein (die App speichert lokal; der Speicher ist begrenzt und wird mit der
  Leichtathletik-App auf derselben Adresse geteilt).
- Die Werte der Regelung tragen Nachkommastellen. Werte, die Home Assistant überträgt, nicht zusätzlich von Hand
  ablesen: Der abgeschnittene Anzeigewert läge unter dem Vorwert und würde abgelehnt.
