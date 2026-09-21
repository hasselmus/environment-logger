import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.resolve(HERE, '../public/index.html'), 'utf8');

function bucketFor(hours) {
  if (hours <= 48) return 5 * 60_000;
  if (hours <= 24 * 14) return 15 * 60_000;
  if (hours <= 24 * 90) return 60 * 60_000;
  if (hours <= 24 * 730) return 6 * 60 * 60_000;
  return 24 * 60 * 60_000;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function latestGrouped(store) {
  const grouped = new Map();
  for (const row of store.latestMeasurements()) {
    if (!grouped.has(row.sensor)) grouped.set(row.sensor, { sensor: row.sensor, sampled_ts_ms: 0 });
    const item = grouped.get(row.sensor);
    item[row.metric] = Number(row.value);
    item.sampled_ts_ms = Math.max(item.sampled_ts_ms, Number(row.ts_ms));
  }
  return [...grouped.values()];
}

function latestStates(store) {
  const map = new Map();
  for (const row of store.latestStates()) map.set(`${row.entity}/${row.field}`, row.value);
  return map;
}

function legacyData(store, config, hours) {
  const latest = latestGrouped(store).map(sensor => ({
    sensor: sensor.sensor,
    sampled_ts_ms: sensor.sampled_ts_ms,
    temperature_c: sensor.temperature ?? null,
    rh_pct: sensor.relative_humidity ?? null,
    ah_g_m3: sensor.absolute_humidity ?? null
  }));

  const stateMap = latestStates(store);
  const compat = config.compatibility ?? {};
  const getState = ref => ref ? stateMap.get(`${ref.entity}/${ref.field}`) : undefined;
  const bool = value => {
    if (value === undefined) return null;
    return ['true', '1', 'yes', 'on', 'open'].includes(String(value).toLowerCase()) ? 1 : 0;
  };
  const door = bool(getState(compat.doorState));
  const dehum = bool(getState(compat.dehumidifierState));
  for (const row of latest) {
    row.balcony_door_open = door;
    row.tefnut_dehumidifying = dehum;
  }

  const wallSensor = compat.wallSensor;
  let wall = [];
  if (wallSensor) {
    const rows = store.series(hours, bucketFor(hours)).filter(row => row.sensor === wallSensor);
    const byTs = new Map();
    for (const row of rows) {
      if (!byTs.has(row.ts_ms)) byTs.set(row.ts_ms, { ts: Number(row.ts_ms) });
      const point = byTs.get(row.ts_ms);
      if (row.metric === 'dew_margin') point.dew_margin_c = Number(row.value);
      if (row.metric === 'probe_temperature') point.probe_temperature_c = Number(row.value);
      if (row.metric === 'dew_point') point.dew_point_c = Number(row.value);
    }
    wall = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  }
  return { now: Date.now(), hours, latest, wall };
}

export function startWeb(store, config) {
  const host = config.server?.host || '0.0.0.0';
  const port = Number(config.server?.port || 8787);
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' });
      if (url.pathname === '/') return send(res, 200, HTML, 'text/html; charset=utf-8');
      if (url.pathname === '/status') {
        return send(res, 200, { ok: true, site: config.site, database: store.path, now: Date.now() });
      }
      if (url.pathname === '/api/v1/latest') {
        return send(res, 200, {
          site: config.site,
          now: Date.now(),
          sensors: latestGrouped(store),
          states: store.latestStates()
        });
      }
      if (url.pathname === '/api/v1/series') {
        const hours = Math.max(1, Math.min(24 * 3650, Number(url.searchParams.get('hours')) || 168));
        const bucketMs = bucketFor(hours);
        return send(res, 200, {
          site: config.site,
          now: Date.now(),
          hours,
          bucket_ms: bucketMs,
          rows: store.series(hours, bucketMs)
        });
      }
      if (url.pathname === '/api/data') {
        const hours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get('hours')) || 1));
        return send(res, 200, legacyData(store, config, hours));
      }
      return send(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return send(res, 500, { ok: false, error: error.message });
    }
  });
  server.listen(port, host, () => console.log(`Dashboard/API: http://${host}:${port}/`));
  return server;
}
