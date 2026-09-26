#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { absoluteHumidity, dewPoint, metricUnits } from './metrics.mjs';
import { startWeb } from './web.mjs';
import { HomebridgeSource } from './sources/homebridge.mjs';
import { MatterDirectSource } from './sources/matter-direct.mjs';
import { MatterServerSource } from './sources/matter-server.mjs';

const config = loadConfig();
const store = new Store(config.database);
const latest = new Map();
const sources = [];

function sensorState(sensor) {
  if (!latest.has(sensor)) latest.set(sensor, new Map());
  return latest.get(sensor);
}

function recordDerived(sensor, source = 'derived') {
  const state = sensorState(sensor);
  const tState = state.get('temperature');
  const rhState = state.get('relative_humidity');
  const probeState = state.get('probe_temperature');
  const t = tState?.value;
  const rh = rhState?.value;
  if (Number.isFinite(t) && Number.isFinite(rh)) {
    const climateTs = Math.max(Number(tState.ts) || 0, Number(rhState.ts) || 0);
    const ah = absoluteHumidity(t, rh);
    const dp = dewPoint(t, rh);
    if (Number.isFinite(ah)) {
      store.putMeasurement({
        ts: climateTs,
        source,
        sensor,
        metric: 'absolute_humidity',
        value: ah,
        unit: metricUnits.absolute_humidity
      });
    }
    if (Number.isFinite(dp)) {
      store.putMeasurement({
        ts: climateTs,
        source,
        sensor,
        metric: 'dew_point',
        value: dp,
        unit: metricUnits.dew_point
      });
      const probe = probeState?.value;
      if (Number.isFinite(probe)) {
        store.putMeasurement({
          ts: Math.max(climateTs, Number(probeState.ts) || 0),
          source,
          sensor,
          metric: 'dew_margin',
          value: probe - dp,
          unit: metricUnits.dew_margin
        });
      }
    }
  }
}

function measurement(m) {
  const ts = Number(m.ts ?? Date.now());
  store.putMeasurement({
    ...m,
    ts,
    receivedTs: Date.now(),
    unit: m.unit || metricUnits[m.metric] || ''
  });
  sensorState(m.sensor).set(m.metric, { value: Number(m.value), ts });
  if (['temperature', 'relative_humidity', 'probe_temperature'].includes(m.metric)) {
    recordDerived(m.sensor);
  }
}

function state(s) {
  const written = store.putState(s);
  if (written && !s.initial) console.log(`[state] ${s.entity}.${s.field} = ${s.value}`);
}

const handlers = { measurement, state };

// Rehydrate the in-memory sensor state from the database before sources start.
// This matters for derived values that combine channels which may update at
// different times (notably wall probe temperature + room T/RH).
for (const row of store.latestMeasurements()) {
  sensorState(row.sensor).set(row.metric, { value: Number(row.value), ts: Number(row.ts_ms) });
}
for (const sensor of latest.keys()) recordDerived(sensor);


for (const sourceConfig of config.sources.filter(source => source.enabled !== false)) {
  if (sourceConfig.type === 'matter-bridge' || sourceConfig.type === 'matter-direct') {
    sources.push(new MatterDirectSource(sourceConfig, handlers));
  } else if (sourceConfig.type === 'matter-server') {
    sources.push(new MatterServerSource(sourceConfig, handlers));
  } else if (sourceConfig.type === 'homebridge') {
    sources.push(new HomebridgeSource(sourceConfig, handlers));
  }
}

for (const source of sources) await source.start();
const web = startWeb(store, config);
console.log(`Environment logger '${config.site}' started; database ${store.path}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  await Promise.allSettled(sources.map(source => source.close?.()));
  await new Promise(resolve => web.close(resolve));
  store.close();
}

process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
