#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.mjs';

const config = loadConfig();
const db = new DatabaseSync(config.database.path, { readOnly: true });
const out = config.export?.directory || path.dirname(config.database.path);
mkdirSync(out, { recursive: true });

function csv(name, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const quote = value => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  writeFileSync(
    path.join(out, name),
    [keys.join(','), ...rows.map(row => keys.map(key => quote(row[key])).join(','))].join('\n') + '\n'
  );
}

csv('measurements.csv', db.prepare('SELECT * FROM measurements ORDER BY ts_ms').all());
csv('state_events.csv', db.prepare('SELECT * FROM state_events ORDER BY ts_ms').all());
console.log(`Exported CSV files to ${out}`);
