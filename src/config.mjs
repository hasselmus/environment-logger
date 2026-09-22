import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { homedir } from 'node:os';

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return value;
}

export function configPath() {
  return expandHome(process.env.ENV_LOGGER_CONFIG || '~/.config/environment-logger/site.json');
}

export function loadConfig(filename = configPath()) {
  if (!existsSync(filename)) {
    throw new Error(`Configuration not found: ${filename}. Copy config/site.example.json to a private site.json and edit it.`);
  }
  let config;
  try { config = JSON.parse(readFileSync(filename, 'utf8')); }
  catch (error) { throw new Error(`Cannot parse ${filename}: ${error.message}`); }
  validateConfig(config);
  config.__path = filename;
  config.database.path = expandHome(config.database.path);
  if (config.database.requiredMount) config.database.requiredMount = expandHome(config.database.requiredMount);
  for (const source of config.sources ?? []) {
    if (source.storageDir) source.storageDir = expandHome(source.storageDir);
    if (source.configPath) source.configPath = expandHome(source.configPath);
  }
  return config;
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Configuration must be a JSON object.');
  if (!config.site || typeof config.site !== 'string') throw new Error('site must be a non-empty string.');
  if (!config.database?.path || typeof config.database.path !== 'string') throw new Error('database.path must be set.');
  if (!Array.isArray(config.sources)) throw new Error('sources must be an array.');
  const ids = new Set();
  for (const source of config.sources) {
    if (!source?.id || !source.type) throw new Error('Every source needs id and type.');
    if (ids.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    ids.add(source.id);
    if (!['matter-direct', 'matter-bridge', 'matter-server', 'homebridge'].includes(source.type)) {
      throw new Error(`Unsupported source type ${source.type} for ${source.id}.`);
    }
  }
  return true;
}
