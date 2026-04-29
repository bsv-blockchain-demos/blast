import { useState } from 'react'

export function shortTxid(txid) {
  if (!txid || txid.length < 16) return txid
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`
}

export function TxidCopy({ txid }) {
  const [copied, setCopied] = useState(false)
  if (!txid) return null

  async function handleCopy(e) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(txid)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  return (
    <span className="txid-copy">
      <span className="log-txid">{shortTxid(txid)}</span>
      <button className="copy-btn" onClick={handleCopy} title={`Copy ${txid}`}>
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  )
}
