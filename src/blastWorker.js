import { Transaction, Script, UnlockingScript } from '@bsv/sdk'

// OP_1 unlock for OP_NOP locking scripts: stack [1] = TRUE after OP_NOP
const OP1_BYTES = [{ op: 0x51 }]

// OP_FALSE OP_RETURN 7e57 → 0x00 0x6a 0x02 0x7e 0x57
const RETURN_SCRIPT = Script.fromHex('006a027e57')

// OP_NOP setup output locking script
const SETUP_LOCK = Script.fromHex('61')

// Transaction.hash() returns little-endian bytes; txid hex is big-endian
function txidToHashBytes(txidHex) {
  const bytes = []
  for (let i = 0; i < txidHex.length; i += 2) {
    bytes.push(parseInt(txidHex.slice(i, i + 2), 16))
  }
  return bytes.reverse()
}

let aborted = false
let timer = null
let setupHashBytes = null // cached once per worker lifetime

function buildBlastTx(setupTxid, vout, satoshisPerOutput) {
  if (!setupHashBytes) setupHashBytes = txidToHashBytes(setupTxid)

  // Stub source tx: only vout index populated, enough for EF serialization
  const stubOutputs = new Array(vout + 1)
  stubOutputs[vout] = { lockingScript: SETUP_LOCK, satoshis: satoshisPerOutput }

  const tx = new Transaction()
  tx.addInput({
    sourceTXID: setupTxid,
    sourceOutputIndex: vout,
    sourceTransaction: { outputs: stubOutputs, hash: () => setupHashBytes },
    unlockingScript: new UnlockingScript(OP1_BYTES),
    sequence: 0xFFFFFFFF
  })
  tx.addOutput({ lockingScript: RETURN_SCRIPT, satoshis: 0 })
  return tx
}

async function broadcastBatch(hostUrl, txs) {
  const rawTxs = txs.map(tx => ({ rawTx: tx.toHexEF() }))
  const res = await fetch(`${hostUrl}/txs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rawTxs),
    signal: AbortSignal.timeout(30_000)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString())
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  return res.json()
}

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') {
    aborted = true
    if (timer) clearTimeout(timer)
    self.postMessage({ type: 'done', reason: 'aborted' })
    return
  }

  if (data.type !== 'start') return

  const { hostUrl, setupTxid, setupOutputCount, satoshisPerOutput, startVout, batchSize, intervalMs } = data
  aborted = false
  setupHashBytes = null
  let nextVout = startVout

  async function runBatch() {
    if (aborted) return
    if (nextVout >= setupOutputCount) {
      self.postMessage({ type: 'done', reason: 'exhausted', nextVout })
      return
    }

    const batchEnd = Math.min(nextVout + batchSize, setupOutputCount)
    const txs = []
    for (let v = nextVout; v < batchEnd; v++) {
      txs.push(buildBlastTx(setupTxid, v, satoshisPerOutput))
    }
    const batchStartVout = nextVout
    nextVout = batchEnd

    try {
      const results = await broadcastBatch(hostUrl, txs)
      if (!aborted) {
        self.postMessage({
          type: 'batch',
          results: Array.isArray(results) ? results : [],
          batchStartVout,
          nextVout,
          txCount: txs.length
        })
      }
    } catch (err) {
      if (!aborted) {
        self.postMessage({
          type: 'batch_error',
          error: err.message,
          batchStartVout,
          nextVout,
          txCount: txs.length
        })
      }
    }

    if (!aborted && nextVout < setupOutputCount) {
      timer = setTimeout(runBatch, intervalMs)
    } else if (!aborted) {
      self.postMessage({ type: 'done', reason: 'exhausted', nextVout })
    }
  }

  runBatch()
}
