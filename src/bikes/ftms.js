import {EventEmitter} from 'events';
import {scan, createAddressFilter} from '../util/ble-scan.js';
import {macAddress} from '../util/mac-address.js';
import {loadDependency, toDefaultExport} from '../util/optional-deps.js';

const debugModule = loadDependency('debug', '../../stubs/debug.cjs', import.meta);
const debuglog = toDefaultExport(debugModule)('gym:bikes:ftms');

const FTMS_SERVICE_UUID = '1826';
const INDOOR_BIKE_DATA_UUID = '2ad2';

// Consoles known to speak spec-compliant FTMS (variable-layout Indoor Bike Data).
const FTMS_NAME_PATTERNS = [/^iconsole\+/i];

export function matchesFtmsName(peripheral) {
  const name = peripheral?.advertisement?.localName || '';
  return FTMS_NAME_PATTERNS.some(pattern => pattern.test(name));
}

// Indoor Bike Data optional fields in flag-bit order: [name, size, reader].
// Bit 0 ("More Data") is inverted: instantaneous speed is present when it is 0.
const IBD_FIELDS = [
  ['speed', 2, (b, o) => b.readUInt16LE(o) / 100 * 1000 / 3600], // 0.01 km/h -> m/s
  ['averageSpeed', 2, null],
  ['cadence', 2, (b, o) => b.readUInt16LE(o) / 2], // 0.5 rpm
  ['averageCadence', 2, null],
  ['totalDistance', 3, null],
  ['resistance', 2, (b, o) => b.readInt16LE(o)],
  ['power', 2, (b, o) => b.readInt16LE(o)],
  ['averagePower', 2, null],
  ['expendedEnergy', 5, null],
  ['heartRate', 1, (b, o) => b.readUInt8(o)],
  ['metabolicEquivalent', 1, null],
  ['elapsedTime', 2, null],
  ['remainingTime', 2, null],
];

/**
 * Parse an FTMS Indoor Bike Data value by walking its flags field.
 * Returns only the fields present; a value truncated by a small ATT MTU
 * yields whatever complete fields fit.
 * @param {Buffer} data
 * @returns {{speed?: number, cadence?: number, resistance?: number, power?: number, heartRate?: number}}
 */
export function parseIndoorBikeData(data) {
  if (!data || data.length < 2) {
    throw new Error('unable to parse message');
  }
  const flags = data.readUInt16LE(0);
  const result = {};
  let offset = 2;
  for (let bit = 0; bit < IBD_FIELDS.length; bit++) {
    const present = bit === 0 ? !(flags & 1) : Boolean(flags & (1 << bit));
    if (!present) {
      continue;
    }
    const [name, size, read] = IBD_FIELDS[bit];
    if (offset + size > data.length) {
      break;
    }
    if (read) {
      result[name] = read(data, offset);
    }
    offset += size;
  }
  return result;
}

/**
 * Generic client for bikes exposing the standard Fitness Machine Service.
 */
export class FtmsBikeClient extends EventEmitter {
  /**
   * @param {Noble} noble
   * @param {function} filter - peripheral filter used while scanning
   */
  constructor(noble, filter = matchesFtmsName) {
    super();
    this.noble = noble;
    this.filter = filter;
    this.state = 'disconnected';
    this.stats = {power: 0, cadence: 0};
    this.onReceive = this.onReceive.bind(this);
    this.onDisconnect = this.onDisconnect.bind(this);
  }

  static get label() {
    return 'ftms';
  }

  async connect() {
    if (this.state === 'connected') {
      throw new Error('Already connected');
    }
    this.state = 'connecting';
    this.peripheral = await scan(this.noble, [FTMS_SERVICE_UUID], this.filter, {allowDuplicates: false, active: true});
    if (!this.peripheral) {
      this.state = 'disconnected';
      throw new Error('Unable to find FTMS bike');
    }
    await this.peripheral.connectAsync({timeout: 10000});
    this.peripheral.on('disconnect', this.onDisconnect);

    const {characteristics} = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [FTMS_SERVICE_UUID], [INDOOR_BIKE_DATA_UUID]);
    const [indoorBikeData] = characteristics;
    if (!indoorBikeData) {
      throw new Error('FTMS Indoor Bike Data characteristic not found');
    }
    this.indoorBikeData = indoorBikeData;
    this.indoorBikeData.on('data', this.onReceive);
    await this.indoorBikeData.subscribeAsync();

    this.state = 'connected';
  }

  get address() {
    return this.peripheral ? macAddress(this.peripheral.address) : undefined;
  }

  onReceive(data) {
    this.emit('data', data);
    let parsed;
    try {
      parsed = parseIndoorBikeData(data);
    } catch (e) {
      debuglog('ignoring indoor bike data', e.message);
      return;
    }
    // Merge so bikes that split fields across notifications keep last-known values.
    for (const key of ['power', 'cadence', 'speed']) {
      if (parsed[key] !== undefined) {
        this.stats[key] = parsed[key];
      }
    }
    this.emit('stats', {...this.stats, cadence: Math.round(this.stats.cadence)});
  }

  async disconnect() {
    if (this.state === 'disconnected' || !this.peripheral) {
      return;
    }
    this.state = 'disconnecting';
    try {
      await this.peripheral.disconnectAsync();
    } catch (err) {
      debuglog('error disconnecting from FTMS bike', err);
    } finally {
      if (this.state !== 'disconnected') {
        this.onDisconnect();
      }
    }
  }

  onDisconnect() {
    if (this.state === 'disconnected') {
      return;
    }
    this.state = 'disconnected';
    let address;
    if (this.peripheral) {
      this.peripheral.off('disconnect', this.onDisconnect);
      address = this.peripheral.address;
      this.peripheral = null;
    }
    if (this.indoorBikeData) {
      this.indoorBikeData.off('data', this.onReceive);
      this.indoorBikeData = null;
    }
    this.stats = {power: 0, cadence: 0};
    this.emit('disconnect', {address});
  }
}

/**
 * Build the scan filter: MAC address when configured, else any FTMS advertiser.
 */
export function createFtmsFilter(address) {
  return address ? createAddressFilter(address) : advertisesFtms;
}

function advertisesFtms(peripheral) {
  const uuids = peripheral?.advertisement?.serviceUuids || [];
  return uuids.some(uuid => String(uuid).toLowerCase() === FTMS_SERVICE_UUID);
}
