import { readFileSync } from 'node:fs';

const normaliseMac = s => String(s ?? '').toUpperCase();
const nameEq = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'accent' }) === 0;

function transform(value, rule = 'number') {
  if (rule === 'raw') return value;
  if (rule === 'contact_open') return Number(value) === 1;
  if (rule === 'boolean_one') return Number(value) === 1;
  if (rule.startsWith('equals:')) return Number(value) === Number(rule.slice(7));
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class HomebridgeSource {
  constructor(config, handlers) {
    this.config = config;
    this.handlers = handlers;
    this.client = null;
    this.monitor = null;
  }

  readPin() {
    const envName = this.config.pinEnv;
    if (envName && process.env[envName]) return process.env[envName];
    if (this.config.pin) return this.config.pin;
    if (this.config.configPath) {
      const cfg = JSON.parse(readFileSync(this.config.configPath, 'utf8'));
      if (cfg?.bridge?.pin) return cfg.bridge.pin;
    }
    throw new Error(`[${this.config.id}] Homebridge PIN unavailable; use configPath, pin, or pinEnv.`);
  }

  matches(service, channel) {
    if (service.type !== channel.serviceType) return false;
    if (channel.accessoryName && !nameEq(service.accessoryInformation?.Name, channel.accessoryName)) return false;
    if (channel.serviceName && !nameEq(service.serviceName, channel.serviceName)) return false;
    return true;
  }

  consume(service, channel, initial = false) {
    const raw = service.values?.[channel.characteristic];
    if (raw === undefined) return;
    const value = transform(raw, channel.transform || (channel.kind === 'state' ? 'raw' : 'number'));
    if (value === null || value === undefined) return;
    const ts = Date.now();
    if (channel.kind === 'state') {
      this.handlers.state({
        ts,
        source: this.config.id,
        entity: channel.entity || channel.sensor || service.serviceName,
        field: channel.field || channel.metric || channel.characteristic,
        value,
        initial
      });
    } else {
      this.handlers.measurement({
        ts,
        source: this.config.id,
        sensor: channel.sensor || service.serviceName,
        metric: channel.metric,
        value,
        unit: channel.unit || ''
      });
    }
  }

  async start() {
    const { HapClient } = await import('@homebridge/hap-client');
    const username = normaliseMac(this.config.username);
    const pin = this.readPin();
    this.client = new HapClient({
      pin,
      config: { debug: false, autoStartDiscovery: false, discoveryTimeout: 12000 },
      logger: console
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${this.config.id}] Homebridge ${username} not discovered within 12 seconds.`)), 12500);
      const handler = instance => {
        if (!username || normaliseMac(instance.username) === username) {
          clearTimeout(timer);
          this.client.off('instance-discovered', handler);
          resolve();
        }
      };
      this.client.on('instance-discovered', handler);
      this.client.startDiscovery(12000);
    });
    this.client.stopDiscovery();
    const all = await this.client.getAllServices();
    const services = username ? all.filter(s => normaliseMac(s.instance?.username) === username) : all;
    const bindings = [];
    for (const channel of this.config.channels ?? []) {
      const matches = services.filter(s => this.matches(s, channel));
      if (matches.length !== 1) {
        throw new Error(`[${this.config.id}] expected one ${channel.serviceType}/${channel.serviceName ?? '*'} match for ${channel.sensor ?? channel.entity}, found ${matches.length}`);
      }
      bindings.push({ channel, service: matches[0] });
      this.consume(matches[0], channel, true);
    }
    const uniqueServices = [...new Set(bindings.map(b => b.service))];
    this.monitor = await this.client.monitorCharacteristics(uniqueServices);
    this.monitor.on('service-update', updated => {
      for (const service of updated) {
        for (const binding of bindings) {
          if (this.matches(service, binding.channel)) this.consume(service, binding.channel, false);
        }
      }
    });
    this.monitor.on('monitor-error', (_instance, error) => console.warn(`[${this.config.id}] monitor error: ${error?.message ?? error}`));
    console.log(`[${this.config.id}] monitoring ${bindings.length} Homebridge channels`);
  }

  async close() {
    try { this.client?.destroy(); } catch {}
  }
}
