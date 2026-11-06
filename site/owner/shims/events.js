// Stub of Node's "events" for the browser build: only so that ZeroDev's KernelEIP1193Provider class (not used by this page) loads.
export class EventEmitter {
  on() { return this; }
  once() { return this; }
  off() { return this; }
  removeListener() { return this; }
  emit() { return false; }
}
export default EventEmitter;
