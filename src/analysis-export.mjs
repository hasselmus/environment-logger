#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.mjs';

const days = Math.max(1, Number(process.argv[2] || 30));
const config = loadConfig();
const since = Date.now() - days * 86400_000;
const out = path.join(path.dirname(config.database.path), `analysis-${days}d.sqlite`);
if (existsSync(out)) rmSync(out);

const src = new DatabaseSync(config.database.path, { readOnly: true });
const dst = new DatabaseSync(out);
dst.exec(`
  CREATE TABLE measurements(
    ts_ms INTEGER, received_ts_ms INTEGER, source TEXT, sensor TEXT, metric TEXT, value REAL, unit TEXT
  );
  CREATE TABLE state_events(
    id INTEGER, ts_ms INTEGER, source TEXT, entity TEXT, field TEXT, value TEXT
  );
`);

const putMeasurement = dst.prepare('INSERT INTO measurements VALUES (?,?,?,?,?,?,?)');
const putState = dst.prepare('INSERT INTO state_events VALUES (?,?,?,?,?,?)');
dst.exec('BEGIN');
for (const row of src.prepare('SELECT * FROM measurements WHERE ts_ms>=? ORDER BY ts_ms').iterate(since)) {
  putMeasurement.run(row.ts_ms, row.received_ts_ms, row.source, row.sensor, row.metric, row.value, row.unit);
}
for (const row of src.prepare('SELECT * FROM state_events WHERE ts_ms>=? ORDER BY ts_ms').iterate(since)) {
  putState.run(row.id, row.ts_ms, row.source, row.entity, row.field, row.value);
}
dst.exec('COMMIT');
src.close();
dst.close();
console.log(out);
