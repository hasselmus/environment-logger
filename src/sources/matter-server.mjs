function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class MatterServerSource {
  constructor(config, handlers) {
    this.config = config;
    this.handlers = handlers;
    this.ws = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.byNode = new Map();
    for (const node of config.nodes ?? []) {
      const paths = new Map();
      for (const channel of node.channels ?? []) paths.set(channel.path, channel);
      this.byNode.set(Number(node.nodeId), { ...node, paths });
    }
  }

  start() { this.connect(); }

  send(message_id, command, args) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = { message_id, command };
    if (args !== undefined) msg.args = args;
    this.ws.send(JSON.stringify(msg));
  }

  publish(nodeId, attrPath, raw, ts = Date.now()) {
    const node = this.byNode.get(Number(nodeId));
    const channel = node?.paths.get(attrPath);
    if (!node || !channel) return;
    const n = finite(raw);
    if (n === null) return;
    const value = n * Number(channel.scale ?? 1) + Number(channel.offset ?? 0);
    this.handlers.measurement({
      ts,
      source: this.config.id,
      sensor: channel.sensor || node.sensor,
      metric: channel.metric,
      value,
      unit: channel.unit || ''
    });
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    if (this.closed) return;
    const url = this.config.url || 'ws://127.0.0.1:5580/ws';
    console.log(`[${this.config.id}] connecting to ${url}`);
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => {
      console.log(`[${this.config.id}] connected`);
      this.send(`${this.config.id}:listen`, 'start_listening');
      setTimeout(() => {
        for (const [nodeId, node] of this.byNode) {
          this.send(`${this.config.id}:read:${nodeId}`, 'read_attribute', {
            node_id: nodeId,
            attribute_path: [...node.paths.keys()]
          });
        }
      }, 300);
    });
    this.ws.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const ts = Date.now();
      if (msg.message_id?.startsWith(`${this.config.id}:read:`) && msg.result) {
        const nodeId = Number(msg.message_id.split(':').at(-1));
        for (const [p, value] of Object.entries(msg.result)) this.publish(nodeId, p, value, ts);
      }
      if (msg.event === 'attribute_updated' && Array.isArray(msg.data)) {
        const [nodeId, p, value] = msg.data;
        this.publish(nodeId, p, value, ts);
      }
    });
    this.ws.addEventListener('close', () => {
      if (this.closed) return;
      console.warn(`[${this.config.id}] disconnected; retrying in 5s`);
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
    this.ws.addEventListener('error', e => console.warn(`[${this.config.id}] WebSocket error: ${e.message ?? e}`));
  }

  async close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch {}
  }
}
