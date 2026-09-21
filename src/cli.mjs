#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { commissionMatterBridge, discoverMatterBridge } from './sources/matter-bridge.mjs';

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
if (source.type !== 'matter-bridge') throw new Error(`Source '${sourceId}' is ${source.type}, not matter-bridge.`);

if (command === 'matter-commission') {
  await commissionMatterBridge(source, arg);
} else if (command === 'matter-discover') {
  await discoverMatterBridge(source);
} else {
  throw new Error('Commands: config-check | matter-commission <source-id> <pairing-code> | matter-discover <source-id>');
}
