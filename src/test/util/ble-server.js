import test from '../support/tape.js';
import {buildAdvertisingData} from '../../util/ble-server.js';

test('buildAdvertisingData() sends a complete local name in advertisement and scan response', t => {
  const {advertisement, scanResponse} = buildAdvertisingData('ftmssync', ['1818', '1816']);
  t.equal(advertisement.toString('hex'), '0201060503181816180909' + Buffer.from('ftmssync').toString('hex'), 'flags, 16-bit UUIDs, complete name');
  t.equal(scanResponse.toString('hex'), '0909' + Buffer.from('ftmssync').toString('hex'), 'complete name (0x09) in scan response');
  t.end();
});

test('buildAdvertisingData() keeps long names out of the advertisement and rejects 128-bit UUIDs', t => {
  const name = 'A'.repeat(25);
  const {advertisement, scanResponse} = buildAdvertisingData(name, ['1818', '1816']);
  t.equal(advertisement.length, 9, 'name does not fit next to the UUIDs');
  t.equal(scanResponse.length, 27, 'name still in scan response');
  t.equal(buildAdvertisingData('x', ['0000180d-0000-1000-8000-00805f9b34fb']), null, 'falls back for 128-bit UUIDs');
  t.end();
});
