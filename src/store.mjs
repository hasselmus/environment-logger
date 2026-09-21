import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function decodeMountField(value) {
  return value.replaceAll('\\040', ' ').replaceAll('\\011', '\t').replaceAll('\\012', '\n').replaceAll('\\134', '\\');
}

export function isMountedAt(mountpoint) {
  if (!mountpoint) return true;
  try {
    const wanted = path.resolve(mountpoint);
    return readFileSync('/proc/self/mounts', 'utf8').split(/\r?\n/).some(line => {
      if (!line) return false;
      const fields = line.split(' ');
      return fields.length >= 2 && path.resolve(decodeMountField(fields[1])) === wanted;
    });
  } catch { return false; }
}

export class Store {
  constructor(config) {
    if (config.requiredMount && !isMountedAt(config.requiredMount)) {
      throw new Error(`Required mount is not active at ${config.requiredMount}; refusing to open database.`);
    }
    mkdirSync(path.dirname(config.path), { recursive: true });
    this.path = config.path;
    this.db = new DatabaseSync(config.path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS measurements (
        ts_ms INTEGER NOT NULL,
        received_ts_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        sensor TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT,
        PRIMARY KEY (ts_ms, source, sensor, metric)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_measurements_sensor_metric_ts ON measurements(sensor, metric, ts_ms);
      CREATE TABLE IF NOT EXISTS state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        entity TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_state_events_entity_field_ts ON state_events(entity, field, ts_ms);
    `);
    this.putMeasurementStmt = this.db.prepare(`INSERT OR REPLACE INTO measurements
      (ts_ms,received_ts_ms,source,sensor,metric,value,unit) VALUES (?,?,?,?,?,?,?)`);
    this.putStateStmt = this.db.prepare('INSERT INTO state_events(ts_ms,source,entity,field,value) VALUES (?,?,?,?,?)');
    this.lastState = new Map();
  }

  putMeasurement({ ts = Date.now(), receivedTs = Date.now(), source, sensor, metric, value, unit = '' }) {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    this.putMeasurementStmt.run(Math.trunc(ts), Math.trunc(receivedTs), source, sensor, metric, n, unit);
    return true;
  }

  putState({ ts = Date.now(), source, entity, field, value }) {
    const key = `${source}\u0000${entity}\u0000${field}`;
    const encoded = value === null || value === undefined ? null : String(value);
    if (this.lastState.get(key) === encoded) return false;
    this.lastState.set(key, encoded);
    this.putStateStmt.run(Math.trunc(ts), source, entity, field, encoded);
    return true;
  }

  latestMeasurements() {
    return this.db.prepare(`
      SELECT m.* FROM measurements m
      JOIN (
        SELECT sensor, metric, MAX(ts_ms) AS max_ts
        FROM measurements GROUP BY sensor, metric
      ) x ON x.sensor=m.sensor AND x.metric=m.metric AND x.max_ts=m.ts_ms
      ORDER BY m.sensor, m.metric
    `).all();
  }

  latestStates() {
    return this.db.prepare(`
      SELECT s.* FROM state_events s
      JOIN (
        SELECT entity, field, MAX(ts_ms) AS max_ts
        FROM state_events GROUP BY entity, field
      ) x ON x.entity=s.entity AND x.field=s.field AND x.max_ts=s.ts_ms
      ORDER BY s.entity, s.field
    `).all();
  }

  series(hours, bucketMs) {
    const since = Date.now() - hours * 3600_000;
    return this.db.prepare(`
      SELECT CAST(ts_ms / ? AS INTEGER) * ? AS ts_ms, sensor, metric, unit, AVG(value) AS value
      FROM measurements WHERE ts_ms >= ?
      GROUP BY CAST(ts_ms / ? AS INTEGER), sensor, metric, unit
      ORDER BY ts_ms, sensor, metric
    `).all(bucketMs, bucketMs, since, bucketMs);
  }

  close() { this.db.close(); }
}
