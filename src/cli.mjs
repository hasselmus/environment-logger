#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { commissionMatterDirect, discoverMatterDirect } from './sources/matter-direct.mjs';

const [command, sourceId, arg] = process.argv.slice(2).filter(value => !value.startsWith('--storage-path='));
const config = loadConfig();

if (command === 'config-check') {
  console.log(`Configuration OK: ${config.__path}`);
  console.log(`Site: ${config.site}`);
  console.log(`Sources: ${config.sources.map(source => `${source.id} (${source.type})${source.enabled === false ? ' disabled' : ''}`).join(', ') || '(none)'}`);
  process.exit(0);
}

const source = config.sources.find(item => item.id === sourceId);
if (!source) throw new Error(`Source '${sourceId}' not found. Usage: ${command} <source-id> ...`);
if (!['matter-direct', 'matter-bridge'].includes(source.type)) {
  throw new Error(`Source '${sourceId}' is ${source.type}, not a direct Matter source.`);
}

if (command === 'matter-commission') {
  await commissionMatterDirect(source, arg);
} else if (command === 'matter-discover') {
  await discoverMatterDirect(source, arg ?? null);
} else {
  throw new Error(
    'Commands: config-check | matter-commission <source-id> <pairing-code> | matter-discover <source-id> [node-id]'
  );
}
