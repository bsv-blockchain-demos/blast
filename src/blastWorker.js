import { Transaction, Script, P2PKH, PrivateKey } from '@bsv/sdk'

// OP_FALSE OP_RETURN 7e57 → 0x00 0x6a 0x02 0x7e 0x57
const RETURN_SCRIPT = Script.fromHex('006a027e57')

let workerP2PKH = null
let workerPrivateKey = null
let workerAddress = null

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

async function buildBlastTx(setupTxid, vout, satoshisPerOutput) {
  if (!setupHashBytes) setupHashBytes = txidToHashBytes(setupTxid)

  const lockingScript = workerP2PKH.lock(workerAddress)
  const stubOutputs = new Array(vout + 1)
  stubOutputs[vout] = { lockingScript, satoshis: satoshisPerOutput }

  const tx = new Transaction()
  tx.addInput({
    sourceTXID: setupTxid,
    sourceOutputIndex: vout,
    sourceTransaction: { outputs: stubOutputs, hash: () => setupHashBytes },
    unlockingScriptTemplate: workerP2PKH.unlock(workerPrivateKey, 'all', false, satoshisPerOutput, lockingScript),
    sequence: 0xFFFFFFFF
  })
  tx.addOutput({ lockingScript: RETURN_SCRIPT, satoshis: 0 })
  await tx.sign()
  return tx
}

async function broadcastBatch(hostUrl, txs) {
  const rawTxs = txs.map(tx => tx.toEF())
  const res = await fetch(`${hostUrl}/txs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(rawTxs.flat()),
    signal: AbortSignal.timeout(3_000)
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

  const { hostUrl, setupTxid, setupOutputCount, satoshisPerOutput, startVout, batchSize, intervalMs, wif, address } = data
  aborted = false
  setupHashBytes = null
  workerP2PKH = new P2PKH()
  workerPrivateKey = PrivateKey.fromWif(wif)
  workerAddress = address
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
      txs.push(await buildBlastTx(setupTxid, v, satoshisPerOutput))
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
