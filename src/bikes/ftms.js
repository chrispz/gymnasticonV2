import {EventEmitter} from 'events';
import {scan, createAddressFilter, stopScanningSafely} from '../util/ble-scan.js';
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

// Consoles stay awake while connected. After an idle release we hold off reconnecting
// until the console sleeps, or until it outlasts its own sleep timeout (someone is riding).
// Module-level so it survives the app recreating the client on each connect attempt.
const rest = {since: null, lastSeen: 0, announced: false};

export function resetIdleRest() {
  rest.since = null;
  rest.lastSeen = 0;
  rest.announced = false;
}

/**
 * Generic client for bikes exposing the standard Fitness Machine Service.
 */
export class FtmsBikeClient extends EventEmitter {
  /**
   * @param {Noble} noble
   * @param {function} filter - peripheral filter used while scanning
   */
  /**
   * @param {object} [options]
   * @param {number} [options.idleTimeoutMs] - release the bike after this long without power/cadence (0 disables)
   * @param {number} [options.consoleSleepMs] - how long the console stays awake on its own once released
   */
  constructor(noble, filter = matchesFtmsName, {idleTimeoutMs = 0, consoleSleepMs = 0, consoleQuietMs = 30000} = {}) {
    super();
    this.noble = noble;
    this.filter = filter;
    this.idleTimeoutMs = idleTimeoutMs;
    this.consoleSleepMs = consoleSleepMs;
    this.consoleQuietMs = consoleQuietMs; // no advertisements for this long = console asleep
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
    // disconnect() rejects this so the app's connect watchdog can interrupt a scan that never matches.
    const aborted = new Promise((_, reject) => {
      this.abortConnect = () => reject(new Error('FTMS bike connect aborted'));
    });
    try {
      await Promise.race([this.establish(), aborted]);
    } finally {
      this.abortConnect = null;
    }
  }

  async establish() {
    if (rest.since) {
      await this.waitForConsoleSleep();
    }
    // No service UUID filter: many consoles only expose FTMS after connecting, not in their advertisement.
    // Duplicates on: with them off the controller reports each device once, which an earlier probe scan may consume.
    this.scanSeen = {devices: new Set(), events: 0};
    const peripheral = await scan(this.noble, null, this.filter, {
      allowDuplicates: true,
      active: true,
      // The HCI socket addon connects via a kernel L2CAP socket, which needs advertisements while connecting.
      stopScanOnMatch: false,
      onDiscovery: p => {
        this.scanSeen.events += 1;
        this.scanSeen.devices.add(p?.address);
      },
    });
    this.throwIfAborted(peripheral);
    if (!peripheral) {
      this.state = 'disconnected';
      throw new Error('Unable to find FTMS bike');
    }
    console.log(`[ftms] found ${peripheral.advertisement?.localName ?? 'unnamed'} (${peripheral.address}); connecting`);
    this.peripheral = peripheral;
    await peripheral.connectAsync();
    await stopScanningSafely(this.noble);
    this.throwIfAborted(peripheral);
    peripheral.on('disconnect', this.onDisconnect);

    const {characteristics} = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [FTMS_SERVICE_UUID], [INDOOR_BIKE_DATA_UUID]);
    this.throwIfAborted(peripheral);
    const [indoorBikeData] = characteristics;
    if (!indoorBikeData) {
      throw new Error('FTMS Indoor Bike Data characteristic not found');
    }
    this.indoorBikeData = indoorBikeData;
    this.indoorBikeData.on('data', this.onReceive);
    await this.indoorBikeData.subscribeAsync();
    this.throwIfAborted(peripheral);

    this.lastActive = Date.now();
    this.state = 'connected';
  }

  waitForConsoleSleep() {
    if (!rest.announced) {
      console.log('[ftms] bike was released while idle; waiting for its console to sleep before reconnecting');
      rest.announced = true;
    }
    return new Promise(resolve => {
      const onDiscover = p => {
        if (this.filter(p)) {
          rest.lastSeen = Date.now();
        }
      };
      const check = () => {
        const now = Date.now();
        const asleep = now - rest.lastSeen >= this.consoleQuietMs;
        const stillAwake = now - rest.since >= this.consoleSleepMs + this.consoleQuietMs;
        if (!asleep && !stillAwake && this.state === 'connecting') {
          return;
        }
        clearInterval(timer);
        this.noble.removeListener('discover', onDiscover);
        if (asleep || stillAwake) {
          console.log(asleep
            ? '[ftms] console is asleep; will reconnect when it wakes'
            : '[ftms] console stayed awake past its sleep timeout; someone is riding, reconnecting');
          resetIdleRest();
        }
        resolve();
      };
      this.noble.on('discover', onDiscover);
      const timer = setInterval(check, Math.min(1000, this.consoleQuietMs / 4));
      Promise.resolve(this.noble.startScanningAsync?.([], true)).catch(() => {});
    });
  }

  throwIfAborted(peripheral) {
    if (this.state !== 'connecting') {
      peripheral?.disconnect?.();
      throw new Error('FTMS bike connect aborted');
    }
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
    this.checkIdle();
  }

  checkIdle() {
    const now = Date.now();
    if (this.stats.power > 0 || this.stats.cadence > 0) {
      this.lastActive = now;
      return;
    }
    if (this.idleTimeoutMs > 0 && this.state === 'connected' && now - this.lastActive >= this.idleTimeoutMs) {
      console.log(`[ftms] no pedalling for ${Math.round(this.idleTimeoutMs / 60000)} min; releasing the bike so its console can sleep`);
      rest.since = now;
      rest.lastSeen = now;
      this.disconnect();
    }
  }

  async disconnect() {
    // A pending connect can outlive 'connecting' (e.g. the bike dropped mid-setup), so key on abortConnect.
    if (this.abortConnect) {
      if (this.scanSeen && !this.peripheral) {
        console.log(`[ftms] scan aborted without a match: ${this.scanSeen.events} advertisement(s) from ${this.scanSeen.devices.size} device(s)`);
      }
      await stopScanningSafely(this.noble);
      this.abortConnect();
    }
    if (this.state === 'disconnected' || !this.peripheral) {
      this.state = 'disconnected';
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
    // Dropped during setup: noble never settles the pending GATT discovery, so fail the connect.
    this.abortConnect?.();
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
 * Build the scan filter: MAC address when configured, else any FTMS advertiser or known console name.
 */
export function createFtmsFilter(address) {
  return address
    ? createAddressFilter(address)
    : peripheral => advertisesFtms(peripheral) || matchesFtmsName(peripheral);
}

function advertisesFtms(peripheral) {
  const uuids = peripheral?.advertisement?.serviceUuids || [];
  return uuids.some(uuid => String(uuid).toLowerCase() === FTMS_SERVICE_UUID);
}
