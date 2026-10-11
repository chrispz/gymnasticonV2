import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {parseIndoorBikeData, matchesFtmsName, createFtmsFilter, FtmsBikeClient} from '../../bikes/ftms.js';
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
