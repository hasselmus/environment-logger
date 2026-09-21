# environment-logger

Small multi-source environmental telemetry logger for Raspberry Pi/Linux. It stores measurements in SQLite, calculates moisture-derived values, exposes a JSON API, and serves a lightweight LAN dashboard.

The repository intentionally contains **no installation-specific device names, Matter endpoint numbers, Homebridge identifiers, secrets or household telemetry**. Each installation uses a private site configuration outside Git.

## Sources

Three source adapters are included:

- `matter-bridge` — direct local Matter controller, useful for bridged sensors such as Zigbee temperature/RH devices exposed through a Matter bridge.
- `matter-server` — Open Home Foundation Matter Server WebSocket client, useful for native Matter devices such as air-quality sensors.
- `homebridge` — read-only Homebridge HAP monitoring for values already exposed by Homebridge plugins.

Power/energy accounting is deliberately out of scope; this project is for environmental measurements and related states.

## Data model

Measurements use generic metric names rather than device-specific schemas. Current conventions include `temperature`, `relative_humidity`, `absolute_humidity`, `dew_point`, `pressure`, `co2`, `pm2_5`, `air_quality`, `probe_temperature`, and `dew_margin`. Any numeric metric can still be stored and graphed.

Whenever a sensor supplies temperature + RH, absolute humidity and dew point are derived automatically. If the same sensor also supplies `probe_temperature`, `dew_margin = probe_temperature - dew_point` is derived.

## Installation

Requirements: Node.js 22.13+ and Linux. Clone and install dependencies:

```bash
git clone https://github.com/hasselmus/environment-logger.git
cd environment-logger
npm install --omit=dev
```

Create a private site configuration:

```bash
mkdir -p ~/.config/environment-logger
cp config/site.example.json ~/.config/environment-logger/site.json
nano ~/.config/environment-logger/site.json
npm run config-check
```

The default config path is `~/.config/environment-logger/site.json`. Override it with `ENV_LOGGER_CONFIG=/path/to/site.json`.

Start interactively:

```bash
npm start
```

The dashboard/API defaults to `http://<host>:8787/`.

## Matter bridge commissioning

For a `matter-bridge` source called `bridge1`:

```bash
npm run matter-commission -- bridge1 YOUR-MATTER-CODE
npm run matter-discover -- bridge1
```

The pairing code is used locally and must not be committed. `matter-discover` prints common environmental endpoints; copy the desired endpoint/cluster mappings into the private site configuration.

Matter cluster IDs in JSON are decimal. Examples: Temperature Measurement `0x0402 = 1026`, Pressure Measurement `0x0403 = 1027`, Relative Humidity Measurement `0x0405 = 1029`.

## Matter Server / ALPSTUGA-style source

A `matter-server` source maps arbitrary Matter attribute paths to metrics. For example:

```json
{
  "nodeId": 2,
  "sensor": "Air sensor",
  "channels": [
    { "path": "1/1026/0", "metric": "temperature", "scale": 0.01, "unit": "°C" },
    { "path": "1/1029/0", "metric": "relative_humidity", "scale": 0.01, "unit": "%" },
    { "path": "1/1037/0", "metric": "co2", "unit": "ppm" },
    { "path": "1/1066/0", "metric": "pm2_5", "unit": "µg/m³" }
  ]
}
```

This preserves the useful environmental part of the earlier `matter-metrics` design without bringing power-meter/energy-counter semantics into this project.

## Homebridge source

Homebridge channels are configured as service/characteristic mappings. Measurement channels write numeric telemetry. State channels write change events, for example a contact sensor or appliance operating state. The logger reads Homebridge once at startup and then subscribes to HAP updates; it does not add an extra cloud polling loop to the underlying plugin.

## API and MiniDash compatibility

Native endpoints:

```text
GET /api/v1/latest
GET /api/v1/series?hours=168
GET /status
```

A compatibility endpoint is also provided:

```text
GET /api/data?hours=1
```

It retains the core shape expected by the existing MiniDash client (`latest` climate rows plus optional wall/status fields). Optional `compatibility` mappings in the private site config select the wall sensor and status entities.

## Export and analysis

Full CSV export:

```bash
npm run export
```

Create a compact SQLite extract containing the latest 30 days for external/ChatGPT analysis:

```bash
npm run analysis-export -- 30
```

The extract is written beside the live database as `analysis-30d.sqlite`.

## systemd

After the site config works interactively:

```bash
npm run service-install
```

The installer generates `/etc/systemd/system/environment-logger.service` from the current checkout path, current user and private site-config path, rather than committing machine-specific paths.

Useful commands:

```bash
npm run service-status
npm run service-logs
sudo systemctl restart environment-logger
```

## Privacy and runtime state

Do not commit `site.json`, `.env`, Matter controller state, SQLite databases, or exported household telemetry. They are ignored by `.gitignore` when stored inside the checkout, but the recommended configuration location is outside the repository under `~/.config/environment-logger/`.
