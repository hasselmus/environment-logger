# environment-logger

Small multi-source environmental telemetry logger for Raspberry Pi/Linux. It stores measurements in SQLite, calculates moisture-derived values, exposes a JSON API, and serves a lightweight LAN dashboard.

The repository intentionally contains **no installation-specific device names, Matter endpoint numbers, Homebridge identifiers, secrets or household telemetry**. Each installation uses a private site configuration outside Git.

## Sources

Three source adapters are included:

- `matter-direct` — built-in local Matter controller for both native Matter devices and Matter bridges. One controller/fabric can manage multiple commissioned nodes.
- `matter-bridge` — backwards-compatible alias for `matter-direct`; existing site configurations continue to work.
- `matter-server` — optional Open Home Foundation Matter Server WebSocket client for installations that already use a separate Matter Server.
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

## Direct Matter commissioning

The preferred Matter path is now the built-in `matter-direct` source. It can use one Matter controller/fabric for several commissioned nodes — for example a Matter bridge plus a native air-quality sensor — so a separate Matter Server is not required.

For a direct Matter source called `matter`:

```bash
npm run matter-commission -- matter YOUR-MATTER-CODE
npm run matter-discover -- matter
```

`matter-commission` adds another device to the existing controller/fabric even when other nodes are already commissioned. It prints the newly assigned node ID and immediately discovers the common environmental attributes on that node.

To inspect just one already-commissioned node:

```bash
npm run matter-discover -- matter NODE_ID
```

Set `countryCode` on the private source configuration to the installation's two-letter ISO country code before commissioning. The pairing code is only used locally and must not be committed.

A multi-node source uses:

```json
{
  "id": "matter",
  "type": "matter-direct",
  "storageDir": "~/.local/share/environment-logger/matter-state",
  "countryCode": "XX",
  "pollSeconds": 300,
  "nodes": [
    {
      "nodeId": 1,
      "channels": [
        { "sensor": "Room", "metric": "temperature", "endpoint": 10, "cluster": 1026, "attribute": 0, "scale": 0.01, "unit": "°C" }
      ]
    },
    {
      "nodeId": 2,
      "channels": [
        { "sensor": "Air sensor", "metric": "co2", "endpoint": 1, "cluster": 1037, "attribute": 0, "unit": "ppm" }
      ]
    }
  ]
}
```

Existing single-node `matter-bridge` configurations are still accepted. Once a second node is added, convert that source to the `nodes` form (or at least set its original `nodeId`) so the logger can unambiguously associate channels with nodes.

Existing controller state can be reused during migrations by pointing `storageDir` at the existing Matter storage and setting `storageNamespace` and, if needed, `controllerId` to the values used by the previous application. Never run two controller processes against the same storage concurrently.

The built-in discovery currently recognises Air Quality, Temperature, Pressure, Relative Humidity, CO₂ and PM2.5 clusters. Matter cluster IDs in JSON are decimal: for example Temperature `0x0402 = 1026`, Relative Humidity `0x0405 = 1029`, CO₂ `0x040d = 1037`, PM2.5 `0x042a = 1066`, and Air Quality `0x005b = 91`.

## Optional Matter Server source

The separate Open Home Foundation Matter Server path remains supported for compatibility with existing installations. A `matter-server` source maps arbitrary Matter attribute paths to metrics. For example:

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

For new installations, `matter-direct` is normally simpler because it removes the extra Matter Server daemon. The `matter-server` adapter remains useful when an existing Matter Server fabric is already in service.

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
