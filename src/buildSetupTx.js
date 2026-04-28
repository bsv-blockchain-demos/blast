import { Transaction, Script, P2PKH } from '@bsv/sdk'

const FEE_RATE_SAT_PER_KB = 100

// P2PKH input unlock size: 1 (script len varint) + 107 (P2PKH script) = 108
// Full input: 32 (txid) + 4 (vout) + 108 + 4 (seq) = 148 bytes
const P2PKH_INPUT_SIZE = 148
// OP_NOP output (1 byte script): 8 (value) + 1 (script len) + 1 (script) = 10 bytes
const NOP_OUTPUT_SIZE = 10
// P2PKH output: 8 + 1 + 25 = 34 bytes
const P2PKH_OUTPUT_SIZE = 34
// Tx overhead: 4 (ver) + 1 (in count) + 1 (out count) + 4 (locktime) = 10 bytes
const TX_OVERHEAD = 10

function estimateFee(inputCount, outputCount, hasChange) {
  const size = TX_OVERHEAD
    + inputCount * P2PKH_INPUT_SIZE
    + outputCount * NOP_OUTPUT_SIZE
    + (hasChange ? P2PKH_OUTPUT_SIZE : 0)
  return Math.ceil(size * FEE_RATE_SAT_PER_KB / 1000) + 10 // +10 buffer
}

export async function buildSetupTx({ utxos, privateKey, address, outputCount, satoshisPerOutput }) {
  const p2pkh = new P2PKH()
  const addressLock = p2pkh.lock(address)
  const setupLock = Script.fromHex('61') // OP_NOP

  const totalIn = utxos.reduce((s, u) => s + u.value, 0)
  const totalSetupOut = outputCount * satoshisPerOutput
  const fee = estimateFee(utxos.length, outputCount, true)
  const change = totalIn - totalSetupOut - fee

  if (totalIn < totalSetupOut + fee) {
    throw new Error(
      `Insufficient funds: need ${totalSetupOut + fee} sats, have ${totalIn} sats. ` +
      `Reduce output count or satoshis per output.`
    )
  }

  const tx = new Transaction()

  for (const utxo of utxos) {
    tx.addInput({
      sourceTXID: utxo.tx_hash,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: p2pkh.unlock(
        privateKey,
        'all',
        false,
        utxo.value,
        addressLock
      )
    })
  }

  for (let i = 0; i < outputCount; i++) {
    tx.addOutput({ lockingScript: setupLock, satoshis: satoshisPerOutput })
  }

  if (change > 546) {
    tx.addOutput({ lockingScript: addressLock, satoshis: change })
  }

  await tx.sign()
  return tx
}
