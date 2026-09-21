import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ATTR_MEASURED = 0x0000;
const COMMON_DISCOVERY = [
  { cluster: 0x0402, name: 'temperature' },
  { cluster: 0x0403, name: 'pressure' },
  { cluster: 0x0405, name: 'relative_humidity' }
];
const DESCRIPTOR_CLUSTER = 0x001d;
const DEVICE_TYPE_LIST_ATTRIBUTE = 0x0000;
const PARTS_LIST_ATTRIBUTE = 0x0003;
const BRIDGED_BASIC_CLUSTER = 0x0039;
const NODE_LABEL_ATTRIBUTE = 0x0005;

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const idNum = value => Number.isFinite(Number(value)) ? Number(value) : value;

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

async function openController(config, pairingCode = null) {
  const storageDir = config.storageDir || path.resolve('data/matter-state', config.id);
  const matter = await loadMatter(storageDir);
  const environment = matter.Environment.default;
  const storageService = environment.get(matter.StorageService);
  const manager = await storageService.open(`environment-logger-${config.id}`);
  const ctx = manager.createContext('controller');
  const uniqueId = await ctx.get('uniqueId', `environment-logger-${config.id}`);
  await ctx.set('uniqueId', uniqueId);
  await manager.close();

  const controller = new matter.CommissioningController({
    environment: { environment, id: uniqueId },
    autoConnect: false,
    adminFabricLabel: config.fabricLabel || 'Environment logger'
  });
  await controller.start();

  if (!controller.isCommissioned()) {
    if (!pairingCode) {
      await controller.close?.();
      throw new Error(`[${config.id}] Matter controller is not commissioned.`);
    }
    const decoded = matter.ManualPairingCodeCodec.decode(String(pairingCode).replace(/\D/g, ''));
    const nodeId = await controller.commissionNode({
      commissioning: {
        regulatoryLocation: matter.GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
        regulatoryCountryCode: config.countryCode || 'SE'
      },
      discovery: {
        identifierData: { shortDiscriminator: decoded.shortDiscriminator },
        discoveryCapabilities: { ble: false }
      },
      passcode: decoded.passcode
    });
    console.log(`[${config.id}] commissioning complete; node ${nodeId}`);
  }

  const nodes = controller.getCommissionedNodes();
  if (!nodes.length) {
    await controller.close?.();
    throw new Error(`[${config.id}] no commissioned Matter nodes.`);
  }
  const wanted = config.nodeId ?? nodes[0];
  const node = await controller.getNode(matter.NodeId(wanted));
  if (!node.isConnected) await Promise.resolve(node.connect());
  if (!node.initialized) await node.events.initialized;
  return { controller, node };
}

function channelKey(endpoint, cluster, attribute = ATTR_MEASURED) {
  return `${Number(endpoint)}/${Number(cluster)}/${Number(attribute)}`;
}

export class MatterBridgeSource {
  constructor(config, handlers) {
    this.config = config;
    this.handlers = handlers;
    this.controller = null;
    this.node = null;
    this.channels = new Map();
    for (const channel of config.channels ?? []) {
      this.channels.set(channelKey(channel.endpoint, channel.cluster, channel.attribute ?? ATTR_MEASURED), channel);
    }
    this.timer = null;
  }

  publish(pathInfo, raw, ts = Date.now()) {
    const key = channelKey(
      idNum(pathInfo.endpointId),
      idNum(pathInfo.clusterId),
      idNum(pathInfo.attributeId ?? ATTR_MEASURED)
    );
    const channel = this.channels.get(key);
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
      unit: channel.unit || ''
    });
  }

  async start() {
    const opened = await openController(this.config);
    this.controller = opened.controller;
    this.node = opened.node;
    this.node.events.attributeChanged.on(({ path: p, value }) => this.publish(p, value));
    await this.refresh();
    const seconds = Math.max(30, Number(this.config.pollSeconds ?? 300));
    this.timer = setInterval(() => {
      this.refresh().catch(error => console.warn(`[${this.config.id}] refresh failed: ${error.message}`));
    }, seconds * 1000);
    console.log(`[${this.config.id}] Matter bridge source started (${this.channels.size} channels)`);
  }

  async refresh() {
    const attributes = [...this.channels.values()].map(channel => ({
      endpointId: Number(channel.endpoint),
      clusterId: Number(channel.cluster),
      attributeId: Number(channel.attribute ?? ATTR_MEASURED)
    }));
    const reports = await this.node.getInteractionClient().getMultipleAttributes({ attributes });
    const ts = Date.now();
    for (const report of reports) this.publish(report.path, report.value, ts);
  }

  async close() {
    clearInterval(this.timer);
    try { await this.controller?.close?.(); } catch {}
  }
}

async function discovery(config) {
  const opened = await openController(config);
  try {
    const attrs = [
      ...COMMON_DISCOVERY.map(x => ({ clusterId: x.cluster, attributeId: ATTR_MEASURED })),
      { clusterId: DESCRIPTOR_CLUSTER, attributeId: DEVICE_TYPE_LIST_ATTRIBUTE },
      { clusterId: DESCRIPTOR_CLUSTER, attributeId: PARTS_LIST_ATTRIBUTE },
      { clusterId: BRIDGED_BASIC_CLUSTER, attributeId: NODE_LABEL_ATTRIBUTE }
    ];
    const reports = await opened.node.getInteractionClient().getMultipleAttributes({ attributes: attrs });
    const rows = [];
    for (const report of reports) {
      const endpoint = idNum(report.path?.endpointId);
      const cluster = idNum(report.path?.clusterId);
      const attribute = idNum(report.path?.attributeId);
      const known = COMMON_DISCOVERY.find(x => x.cluster === cluster && attribute === ATTR_MEASURED);
      if (known) rows.push({ endpoint, kind: known.name, raw: report.value });
    }
    console.log(`\n[${config.id}] common environmental measurement endpoints:`);
    for (const row of rows.sort((a, b) => Number(a.endpoint) - Number(b.endpoint))) {
      console.log(`  endpoint ${String(row.endpoint).padStart(3)}  ${row.kind.padEnd(18)} raw=${row.raw}`);
    }
  } finally {
    await opened.controller.close?.();
  }
}

export async function commissionMatterBridge(config, code) {
  if (!code) throw new Error('Matter pairing code is required.');
  const opened = await openController(config, code);
  await opened.controller.close?.();
  await discovery(config);
}

export async function discoverMatterBridge(config) {
  await discovery(config);
}
