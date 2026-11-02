// Test only (agent.test.mjs): a signer for the MCP server that has no key and refuses to sign, so the launch can be tested offline.
export default { address: "0x00000000000000000000000000000000000d6d6d", sendTransaction: async () => { throw new Error("the test signer does not sign"); } };
