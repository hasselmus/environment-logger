import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ATTR_MEASURED = 0x0000;
const COMMON_DISCOVERY = [
  { cluster: 0x005b, name: 'air_quality' },
  { cluster: 0x0402, name: 'temperature' },
  { cluster: 0x0403, name: 'pressure' },
  { cluster: 0x0405, name: 'relative_humidity' },
  { cluster: 0x040d, name: 'co2' },
  { cluster: 0x042a, name: 'pm2_5' }
];
const DESCRIPTOR_CLUSTER = 0x001d;
const DEVICE_TYPE_LIST_ATTRIBUTE = 0x0000;
const PARTS_LIST_ATTRIBUTE = 0x0003;
const BRIDGED_BASIC_CLUSTER = 0x0039;
const NODE_LABEL_ATTRIBUTE = 0x0005;

const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const idNum = value => Number.isFinite(Number(value)) ? Number(value) : value;
const nodeKey = value => String(value);

async function loadMatter(storageDir) {
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  if (!process.argv.some(arg => arg.startsWith('--storage-path='))) {
    process.argv.push(`--storage-path=${storageDir}`);
  }
  const [{ Environment, StorageService }, { GeneralCommissioning }, { ManualPairingCodeCodec, NodeId }, legacy] = await Promise.all([
    import('@matter/main'),
    import('@matter/main/clusters'),
    import('@matter/main/types'),
    import('@project-chip/matter.js')
  ]);
  return {
    Environment,
    StorageService,
    GeneralCommissioning,
    ManualPairingCodeCodec,
    NodeId,
    CommissioningController: legacy.CommissioningController
  };
}

async function startController(config) {
  const storageDir = config.storageDir || path.resolve('data/matter-state', config.id);
  const matter = await loadMatter(storageDir);
  const environment = matter.Environment.default;
  const storageService = environment.get(matter.StorageService);
  const storageNamespace = config.storageNamespace || `environment-logger-${config.id}`;
  const manager = await storageService.open(storageNamespace);
  const ctx = manager.createContext('controller');
  const defaultId = config.controllerId || `environment-logger-${config.id}`;
  const uniqueId = await ctx.get('uniqueId', defaultId);
  await ctx.set('uniqueId', uniqueId);
  await manager.close();

  const controller = new matter.CommissioningController({
    environment: { environment, id: uniqueId },
    autoConnect: false,
    adminFabricLabel: config.fabricLabel || 'Environment logger'
  });
  await controller.start();
  return { matter, controller };
}

async function connectNode(matter, controller, rawNodeId) {
  const node = await controller.getNode(matter.NodeId(rawNodeId));
  if (!node.isConnected) await Promise.resolve(node.connect());
  if (!node.initialized) await node.events.initialized;
  return node;
}

function configuredNodes(config, commissionedNodes) {
  if (Array.isArray(config.nodes) && config.nodes.length) return config.nodes;
  if (Array.isArray(config.channels) && config.channels.length) {
    const nodeId = config.nodeId ?? (commissionedNodes.length === 1 ? commissionedNodes[0] : null);
    if (nodeId === null || nodeId === undefined) {
      throw new Error(
        `[${config.id}] nodeId is required when the controller has ${commissionedNodes.length} commissioned nodes. ` +
        'Convert the source to nodes:[{nodeId,channels:[...]}] or set nodeId.'
      );
    }
    return [{ nodeId, channels: config.channels }];
  }
  return [];
}

function channelKey(endpoint, cluster, attribute = ATTR_MEASURED) {
  return `${Number(endpoint)}/${Number(cluster)}/${Number(attribute)}`;
}

function channelMap(nodeConfig) {
  const map = new Map();
  for (const channel of nodeConfig.channels ?? []) {
    map.set(channelKey(channel.endpoint, channel.cluster, channel.attribute ?? ATTR_MEASURED), channel);
  }
  return map;
}

export class MatterDirectSource {
  constructor(config, handlers) {
    this.config = config;
    this.handlers = handlers;
    this.controller = null;
    this.matter = null;
    this.nodes = new Map();
    this.timer = null;
  }

  publish(nodeId, channels, pathInfo, raw, ts = Date.now()) {
    const key = channelKey(
      idNum(pathInfo.endpointId),
      idNum(pathInfo.clusterId),
      idNum(pathInfo.attributeId ?? ATTR_MEASURED)
    );
    const channel = channels.get(key);
    if (!channel) return;
    const n = num(raw);
    if (n === null) return;
    const value = n * Number(channel.scale ?? 1) + Number(channel.offset ?? 0);
    this.handlers.measurement({
      ts,
      source: this.config.id,
      sensor: channel.sensor,
      metric: channel.metric,
      value,
      unit: channel.unit || '',
      nodeId
    });
  }

  async start() {
    const opened = await startController(this.config);
    this.controller = opened.controller;
    this.matter = opened.matter;

    const commissioned = this.controller.getCommissionedNodes();
    if (!commissioned.length) {
      await this.controller.close?.();
      throw new Error(`[${this.config.id}] no commissioned Matter nodes.`);
    }

    const nodes = configuredNodes(this.config, commissioned);
    if (!nodes.length) {
      await this.controller.close?.();
      throw new Error(`[${this.config.id}] no Matter channels configured.`);
    }

    for (const nodeConfig of nodes) {
      const nodeId = nodeConfig.nodeId;
      const node = await connectNode(this.matter, this.controller, nodeId);
      const channels = channelMap(nodeConfig);
      node.events.attributeChanged.on(({ path: p, value }) => this.publish(nodeId, channels, p, value));
      this.nodes.set(nodeKey(nodeId), { nodeId, node, channels });
    }

    await this.refresh();
    const seconds = Math.max(30, Number(this.config.pollSeconds ?? 300));
    this.timer = setInterval(() => {
      this.refresh().catch(error => console.warn(`[${this.config.id}] refresh failed: ${error.message}`));
    }, seconds * 1000);

    const channels = [...this.nodes.values()].reduce((sum, item) => sum + item.channels.size, 0);
    console.log(`[${this.config.id}] direct Matter source started (${this.nodes.size} node(s), ${channels} channels)`);
  }

  async refreshNode(item) {
    const attributes = [...item.channels.values()].map(channel => ({
      endpointId: Number(channel.endpoint),
      clusterId: Number(channel.cluster),
      attributeId: Number(channel.attribute ?? ATTR_MEASURED)
    }));
    if (!attributes.length) return;
    const reports = await item.node.getInteractionClient().getMultipleAttributes({ attributes });
    const ts = Date.now();
    for (const report of reports) this.publish(item.nodeId, item.channels, report.path, report.value, ts);
  }

  async refresh() {
    await Promise.all([...this.nodes.values()].map(item => this.refreshNode(item)));
  }

  async close() {
    clearInterval(this.timer);
    try { await this.controller?.close?.(); } catch {}
  }
}

async function discoveryForNode(matter, controller, rawNodeId, sourceId) {
  const node = await connectNode(matter, controller, rawNodeId);
  const attrs = [
    ...COMMON_DISCOVERY.map(item => ({ clusterId: item.cluster, attributeId: ATTR_MEASURED })),
    { clusterId: DESCRIPTOR_CLUSTER, attributeId: DEVICE_TYPE_LIST_ATTRIBUTE },
    { clusterId: DESCRIPTOR_CLUSTER, attributeId: PARTS_LIST_ATTRIBUTE },
    { clusterId: BRIDGED_BASIC_CLUSTER, attributeId: NODE_LABEL_ATTRIBUTE }
  ];
  const reports = await node.getInteractionClient().getMultipleAttributes({ attributes: attrs });
  const labels = new Map();
  const parts = new Map();
  const rows = [];

  for (const report of reports) {
    const endpoint = idNum(report.path?.endpointId);
    const cluster = idNum(report.path?.clusterId);
    const attribute = idNum(report.path?.attributeId);
    if (cluster === BRIDGED_BASIC_CLUSTER && attribute === NODE_LABEL_ATTRIBUTE && report.value) {
      labels.set(Number(endpoint), String(report.value));
    } else if (cluster === DESCRIPTOR_CLUSTER && attribute === PARTS_LIST_ATTRIBUTE && Array.isArray(report.value)) {
      parts.set(Number(endpoint), report.value.map(Number));
    }
    const known = COMMON_DISCOVERY.find(item => item.cluster === cluster && attribute === ATTR_MEASURED);
    if (known) rows.push({ endpoint: Number(endpoint), kind: known.name, raw: report.value });
  }

  console.log(`\n[${sourceId}] Matter node ${rawNodeId} environmental attributes:`);
  for (const row of rows.sort((a, b) => a.endpoint - b.endpoint || a.kind.localeCompare(b.kind))) {
    const parents = [...parts.entries()].filter(([, children]) => children.includes(row.endpoint)).map(([parent]) => parent);
    const parent = parents.length
      ? parents.map(p => `${p}${labels.get(p) ? ` (${labels.get(p)})` : ''}`).join(', ')
      : '-';
    console.log(
      `  endpoint ${String(row.endpoint).padStart(3)}  ${row.kind.padEnd(18)} raw=${String(row.raw).padEnd(10)} parent=${parent}`
    );
  }
  if (!rows.length) console.log('  (No common environmental measurement attributes found.)');
}

export async function commissionMatterDirect(config, code) {
  if (!code) throw new Error('Matter pairing code is required.');
  if (!config.countryCode || !/^[A-Z]{2}$/.test(config.countryCode)) {
    throw new Error(`[${config.id}] countryCode must be a two-letter ISO country code before commissioning.`);
  }

  const opened = await startController(config);
  try {
    const decoded = opened.matter.ManualPairingCodeCodec.decode(String(code).replace(/\D/g, ''));
    const nodeId = await opened.controller.commissionNode({
      commissioning: {
        regulatoryLocation: opened.matter.GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
        regulatoryCountryCode: config.countryCode
      },
      discovery: {
        identifierData: { shortDiscriminator: decoded.shortDiscriminator },
        discoveryCapabilities: { ble: false }
      },
      passcode: decoded.passcode
    });
    console.log(`[${config.id}] commissioning complete; node ${nodeId}`);
    await discoveryForNode(opened.matter, opened.controller, nodeId, config.id);
    console.log(`\nAdd nodeId ${nodeId} and its desired channels to the source's nodes array.`);
    return nodeId;
  } finally {
    await opened.controller.close?.();
  }
}

export async function discoverMatterDirect(config, requestedNodeId = null) {
  const opened = await startController(config);
  try {
    const commissioned = opened.controller.getCommissionedNodes();
    if (!commissioned.length) throw new Error(`[${config.id}] no commissioned Matter nodes.`);
    const wanted = requestedNodeId === null || requestedNodeId === undefined
      ? commissioned
      : commissioned.filter(id => String(id) === String(requestedNodeId));
    if (!wanted.length) {
      throw new Error(`[${config.id}] commissioned node ${requestedNodeId} not found. Available: ${commissioned.join(', ')}`);
    }
    console.log(`[${config.id}] commissioned node(s): ${commissioned.join(', ')}`);
    for (const nodeId of wanted) {
      await discoveryForNode(opened.matter, opened.controller, nodeId, config.id);
    }
  } finally {
    await opened.controller.close?.();
  }
}
