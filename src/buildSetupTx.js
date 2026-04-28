import { Transaction, P2PKH } from '@bsv/sdk'

const FEE_RATE_SAT_PER_KB = 100

const P2PKH_INPUT_SIZE = 148  // 32 + 4 + 1 + 107 + 4
const P2PKH_OUTPUT_SIZE = 34  // 8 + 1 + 25
const TX_OVERHEAD = 10        // 4 + 1 + 1 + 4

function estimateFee(inputCount, outputCount, hasChange) {
  const size = TX_OVERHEAD
    + inputCount * P2PKH_INPUT_SIZE
    + outputCount * P2PKH_OUTPUT_SIZE
    + (hasChange ? P2PKH_OUTPUT_SIZE : 0)
  return Math.ceil(size * FEE_RATE_SAT_PER_KB / 1000) + 10
}

// Transaction.hash() returns little-endian bytes; txid hex is big-endian
function txidToHashBytes(txidHex) {
  const bytes = []
  for (let i = 0; i < txidHex.length; i += 2) {
    bytes.push(parseInt(txidHex.slice(i, i + 2), 16))
  }
  return bytes.reverse()
}

export async function buildSetupTx({ utxos, privateKey, address, outputCount, satoshisPerOutput }) {
  const p2pkh = new P2PKH()
  const addressLock = p2pkh.lock(address)

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
    // Stub source tx so toHexEF() can embed source output data
    const hashBytes = txidToHashBytes(utxo.tx_hash)
    const stubOutputs = new Array(utxo.tx_pos + 1)
    stubOutputs[utxo.tx_pos] = { lockingScript: addressLock, satoshis: utxo.value }

    tx.addInput({
      sourceTXID: utxo.tx_hash,
      sourceOutputIndex: utxo.tx_pos,
      sourceTransaction: { outputs: stubOutputs, hash: () => hashBytes },
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
    tx.addOutput({ lockingScript: addressLock, satoshis: satoshisPerOutput })
  }

  if (change > 546) {
    tx.addOutput({ lockingScript: addressLock, satoshis: change })
  }

  await tx.sign()
  return tx
}
