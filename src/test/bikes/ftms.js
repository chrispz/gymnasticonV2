import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {parseIndoorBikeData, matchesFtmsName, createFtmsFilter, FtmsBikeClient, resetIdleRest} from '../../bikes/ftms.js';
import {createBikeClient} from '../../bikes/index.js';

// Captured from an Abilica SP900 (iConsole+0031): flags 0x1FFE, all optional fields present.
const SP900_FRAME = Buffer.from('fe1f940700006800000075010004003500000002000000000000008f040000', 'hex');

test('parseIndoorBikeData() decodes an all-fields iConsole+ frame', t => {
  const {speed, cadence, resistance, power} = parseIndoorBikeData(SP900_FRAME);
  t.ok(Math.abs(speed - 19.4 / 3.6) < 1e-9, 'speed 19.40 km/h in m/s');
  t.equal(cadence, 52, 'cadence (rpm)');
  t.equal(resistance, 4, 'resistance level');
  t.equal(power, 53, 'power (watts)');
  t.end();
});

test('parseIndoorBikeData() decodes the Schwinn IC4 layout', t => {
  const {power, cadence} = parseIndoorBikeData(Buffer.from('4402da020201220100', 'hex'));
  t.equal(power, 290, 'power (watts)');
  t.equal(cadence, 129, 'cadence (rpm)');
  t.end();
});

test('parseIndoorBikeData() keeps complete fields from a frame truncated to a 20-byte MTU payload', t => {
  const result = parseIndoorBikeData(SP900_FRAME.subarray(0, 20));
  t.equal(result.power, 53, 'power survives truncation');
  t.equal(result.cadence, 52, 'cadence survives truncation');
  t.equal(result.heartRate, undefined, 'fields past the cut are omitted');
  t.end();
});

test('parseIndoorBikeData() omits speed when the More Data flag is set', t => {
  const result = parseIndoorBikeData(Buffer.from('41009600', 'hex')); // More Data + power
  t.equal(result.speed, undefined, 'no speed');
  t.equal(result.power, 150, 'power (watts)');
  t.end();
});

test('parseIndoorBikeData() rejects frames without flags', t => {
  t.throws(() => parseIndoorBikeData(Buffer.from('fe', 'hex')), /unable to parse message/);
  t.end();
});

test('FtmsBikeClient merges fields split across notifications', t => {
  const client = new FtmsBikeClient(null);
  const emitted = [];
  client.on('stats', s => emitted.push(s));
  client.onReceive(Buffer.from('44000000a000', 'hex')); // speed 0, cadence 80
  client.onReceive(Buffer.from('41009600', 'hex')); // power 150 only
  t.deepEqual(emitted[1], {power: 150, cadence: 80, speed: 0}, 'cadence carried over from previous frame');
  t.end();
});

test('matchesFtmsName() recognizes iConsole+ consoles', t => {
  t.ok(matchesFtmsName({advertisement: {localName: 'iConsole+0031'}}), 'matches iConsole+0031');
  t.notOk(matchesFtmsName({advertisement: {localName: 'IC Bike'}}), 'leaves IC4 alone');
  t.notOk(matchesFtmsName({advertisement: {}}), 'rejects nameless advertisements');
  t.end();
});

test('createFtmsFilter() accepts any FTMS advertiser unless pinned to a MAC', t => {
  const generic = {address: 'aa:bb:cc:dd:ee:ff', advertisement: {localName: 'Some Bike', serviceUuids: ['1826']}};
  t.ok(createFtmsFilter()(generic), 'any FTMS advertiser without an address');
  t.notOk(createFtmsFilter()({advertisement: {localName: 'Watch', serviceUuids: ['180d']}}), 'rejects non-FTMS devices');
  t.ok(createFtmsFilter('AA:BB:CC:DD:EE:FF')(generic), 'matches the configured MAC');
  t.notOk(createFtmsFilter('11:22:33:44:55:66')(generic), 'rejects other MACs');
  t.end();
});

test('FtmsBikeClient.disconnect() aborts a scan that never matches', async t => {
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {};
  noble.stopScanning = () => {};
  const originalLog = console.log;
  console.log = () => {};
  try {
    const client = new FtmsBikeClient(noble, createFtmsFilter('E0:DF:01:C6:26:80'));
    const pending = client.connect();
    await new Promise(resolve => setTimeout(resolve, 5));
    await client.disconnect();
    await pending.then(() => t.fail('connect should reject'), e => t.match(e.message, /aborted/, 'connect rejects'));
    t.equal(client.state, 'disconnected', 'client is disconnected');
  } finally {
    console.log = originalLog;
  }
  t.end();
});

test('FtmsBikeClient scans without a service UUID filter', async t => {
  const noble = new EventEmitter();
  let scannedUuids = 'unset';
  noble.startScanningAsync = async (uuids) => { scannedUuids = uuids; };
  noble.stopScanning = () => {};
  const originalLog = console.log;
  console.log = () => {};
  try {
    const client = new FtmsBikeClient(noble);
    const pending = client.connect().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));
    t.equal(scannedUuids, null, 'consoles that omit FTMS from their advertisement stay visible');
    await client.disconnect();
    await pending;
  } finally {
    console.log = originalLog;
  }
  t.end();
});

test('autodetect picks the ftms profile for iConsole+ ahead of ic8', async t => {
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = async () => {};
  const originalLog = console.log;
  console.log = () => {};
  try {
    const pending = createBikeClient({bike: 'autodetect', defaultBike: 'keiser', bikeConnectTimeout: 1}, noble);
    setTimeout(() => {
      noble.emit('discover', {address: 'e0:df:01:c6:26:80', advertisement: {localName: 'iConsole+0031', serviceUuids: ['1826']}});
    }, 0);
    const client = await pending;
    t.ok(client instanceof FtmsBikeClient, 'selects FtmsBikeClient');
  } finally {
    console.log = originalLog;
  }
  t.end();
});

function idleTestClient(noble, options) {
  const client = new FtmsBikeClient(noble, p => p.address === 'bike', options);
  client.state = 'connected';
  client.lastActive = Date.now();
  client.disconnect = async () => { client.state = 'disconnected'; client.released = true; };
  return client;
}

const IDLE_FRAME = Buffer.from('fe1f00000000000000000000000100000000000000000000000000000000', 'hex');
const ACTIVE_FRAME = Buffer.from('fe1f940700006800000075010004003500000002000000000000008f040000', 'hex');

test('FtmsBikeClient releases the bike after the idle timeout, but not while pedalling', async t => {
  resetIdleRest();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const client = idleTestClient(new EventEmitter(), {idleTimeoutMs: 20});
    await new Promise(r => setTimeout(r, 30));
    client.onReceive(ACTIVE_FRAME);
    t.notOk(client.released, 'pedalling resets the idle timer');
    await new Promise(r => setTimeout(r, 30));
    client.onReceive(IDLE_FRAME);
    t.ok(client.released, 'released after idle timeout');
  } finally {
    console.log = originalLog;
    resetIdleRest();
  }
  t.end();
});

async function restScenario(t, {keepAdvertising}) {
  resetIdleRest();
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {};
  const originalLog = console.log;
  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const opts = {idleTimeoutMs: 1, consoleSleepMs: 100, consoleQuietMs: 40};
    const idle = idleTestClient(noble, opts);
    await new Promise(r => setTimeout(r, 5));
    idle.onReceive(IDLE_FRAME);
    const next = new FtmsBikeClient(noble, p => p.address === 'bike', opts);
    next.state = 'connecting';
    const advert = setInterval(() => keepAdvertising() && noble.emit('discover', {address: 'bike', advertisement: {}}), 10);
    const started = Date.now();
    await next.waitForConsoleSleep();
    clearInterval(advert);
    return {elapsed: Date.now() - started, logs: logs.join('\n')};
  } finally {
    console.log = originalLog;
    resetIdleRest();
  }
}

test('after an idle release, reconnecting waits until the console stops advertising', async t => {
  let advertise = true;
  setTimeout(() => { advertise = false; }, 60);
  const {elapsed, logs} = await restScenario(t, {keepAdvertising: () => advertise});
  t.ok(elapsed >= 60, 'kept waiting while the console was awake');
  t.ok(logs.includes('console is asleep'), 'resumes once the console sleeps');
  t.end();
});

test('after an idle release, a console that stays awake past its sleep timeout means someone is riding', async t => {
  const {elapsed, logs} = await restScenario(t, {keepAdvertising: () => true});
  t.ok(elapsed >= 100, 'waited for the console sleep timeout');
  t.ok(logs.includes('someone is riding'), 'reconnects without waiting for sleep');
  t.end();
});
