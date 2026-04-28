export async function fetchUTXOs(address, network = 'main') {
  const url = `https://api.whatsonchain.com/v1/bsv/${network}/address/${address}/unspent/all`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`WoC ${res.status}: ${await res.text()}`)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error('Unexpected WoC response')
  return data // [{ tx_hash, tx_pos, height, value }]
}
