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
