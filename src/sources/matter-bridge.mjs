// Backwards-compatible name for configurations created before the generic
// direct Matter source supported multiple native/bridged nodes.
export {
  MatterDirectSource as MatterBridgeSource,
  commissionMatterDirect as commissionMatterBridge,
  discoverMatterDirect as discoverMatterBridge
} from './matter-direct.mjs';
