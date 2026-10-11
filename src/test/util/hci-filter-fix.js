import test from '../support/tape.js';
import {patchHciFilterSize, patchCentralConnInterval} from '../../util/hci-filter-fix.js';

function fakeHci() {
  const written = [];
  const filters = [];
  return {
    written,
    filters,
    _isDevUp: true,
    _socket: {write: (d) => written.push(d), setFilter: (f) => filters.push(f)},
  };
}

test('patchHciFilterSize() pads the 14-byte HCI filter to 16 bytes and re-arms init', t => {
  const hci = fakeHci();
  patchHciFilterSize(hci);
  hci._socket.setFilter(Buffer.alloc(14, 1));
  t.equal(hci.filters[0].length, 16, 'filter padded');
  t.equal(hci._isDevUp, null, 'dev-up poll will redo filter + init');
  t.end();
});

test('patchCentralConnInterval() rewrites LE Create Connection to a 30-50 ms interval', t => {
  const hci = fakeHci();
  patchCentralConnInterval(hci);
  // Captured from noble: 7.5-15 ms interval, 2 s supervision timeout.
  const createConn = Buffer.from('010d20196000300000018026c601dfe00006000c000000c80004000600', 'hex');
  hci._socket.write(createConn);
  const sent = hci.written[0];
  t.equal(sent.readUInt16LE(17), 0x18, 'min interval 30 ms');
  t.equal(sent.readUInt16LE(19), 0x28, 'max interval 50 ms');
  t.equal(sent.subarray(0, 17).toString('hex'), createConn.subarray(0, 17).toString('hex'), 'address and scan params untouched');
  t.equal(sent.subarray(21).toString('hex'), createConn.subarray(21).toString('hex'), 'latency and timeouts untouched');
  t.equal(createConn.readUInt16LE(17), 0x06, 'caller buffer not mutated');
  hci._socket.write(Buffer.from('010c20020001', 'hex'));
  t.equal(hci.written[1].toString('hex'), '010c20020001', 'other commands pass through');
  t.end();
});
