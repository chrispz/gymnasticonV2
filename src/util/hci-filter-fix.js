// Kernels with strict HCI_FILTER length checks (Linux 6.x) reject the 14-byte
// filter noble/bleno send with EINVAL; the socket then receives no events.
// struct hci_ufilter is padded to 16 bytes, which older kernels also accept.
const HCI_UFILTER_SIZE = 16;

export function patchHciFilterSize(hci) {
  const socket = hci?._socket;
  if (!socket || typeof socket.setFilter !== 'function' || socket.__gymnasticonFilterPatched) {
    return;
  }
  const originalSetFilter = socket.setFilter.bind(socket);
  socket.setFilter = (filter) => originalSetFilter(
    Buffer.isBuffer(filter) && filter.length < HCI_UFILTER_SIZE
      ? Buffer.concat([filter, Buffer.alloc(HCI_UFILTER_SIZE - filter.length)])
      : filter
  );
  socket.__gymnasticonFilterPatched = true;
  // If init already ran with the rejected filter, make the 1s dev-up poll redo the filter + init sequence.
  if (hci._isDevUp) {
    hci._isDevUp = null;
  }
}

// noble asks for a 7.5-15 ms interval on links it opens. On a single radio that also serves a
// Garmin (150 ms supervision timeout) the controller misses the Garmin's slots and drops it.
// The bike only notifies at ~2 Hz, so request 30-50 ms instead.
const LE_CREATE_CONN = [0x01, 0x0d, 0x20, 0x19];
const CONN_INTERVAL_MIN = 0x0018; // 30 ms (1.25 ms units)
const CONN_INTERVAL_MAX = 0x0028; // 50 ms

export function patchCentralConnInterval(hci) {
  const socket = hci?._socket;
  if (!socket || typeof socket.write !== 'function' || socket.__gymnasticonConnIntervalPatched) {
    return;
  }
  const originalWrite = socket.write.bind(socket);
  socket.write = (data) => {
    if (Buffer.isBuffer(data) && data.length === 29 && LE_CREATE_CONN.every((b, i) => data[i] === b)) {
      data = Buffer.from(data);
      data.writeUInt16LE(CONN_INTERVAL_MIN, 17);
      data.writeUInt16LE(CONN_INTERVAL_MAX, 19);
    }
    return originalWrite(data);
  };
  socket.__gymnasticonConnIntervalPatched = true;
}
