export async function fetchUTXOs(address, network = 'main') {
  const url = `https://api.whatsonchain.com/v1/bsv/${network}/address/${address}/unspent/all`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`WoC ${res.status}: ${await res.text()}`)
  const data = await res.json()
  if (data?.error) throw new Error(`WoC error: ${data.error}`)
  const utxos = Array.isArray(data) ? data : Array.isArray(data?.result) ? data.result : null
  if (!utxos) throw new Error(`Unexpected WoC response: ${JSON.stringify(data).slice(0, 200)}`)
  return utxos.filter(u => !u.isSpentInMempoolTx) // [{ tx_hash, tx_pos, height, value }]
}
