/**
 * A public client whose waitForTransactionReceipt throws when the
 * transaction was mined but reverted. A reverted transaction still has a
 * receipt, so without this every caller that only waits for one would
 * report success for a call that did nothing.
 */
export function failOnRevert(client) {
  const wait = client.waitForTransactionReceipt;
  return client.extend(() => ({
    async waitForTransactionReceipt(args) {
      const receipt = await wait(args);
      if (receipt.status === "reverted") {
        const err = new Error(`The transaction was mined but reverted (tx ${receipt.transactionHash}, gas used ${receipt.gasUsed}).`);
        err.shortMessage = err.message;
        err.receipt = receipt;
        throw err;
      }
      return receipt;
    },
  }));
}
