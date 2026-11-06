// Stub of Node's "buffer" for the browser build: merkletreejs, reached only through ZeroDev's multi-chain serialization, which this
// page does not use. Any call into it fails loudly instead of running without Buffer.
const missing = () => { throw new Error("Buffer is not available on the owner's page"); };
export const Buffer = new Proxy(function () {}, { get: missing, apply: missing, construct: missing });
export default { Buffer };
