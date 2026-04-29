import { useEffect, useState, useRef } from 'react'

const MAX_ENTRIES = 5000

function ts() {
  return new Date().toLocaleTimeString('en', { hour12: false })
}

function shortTxid(txid) {
  if (!txid || txid.length < 16) return txid
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`
}

export default function SseStream({ arcUrl, callbackToken }) {
  const [connState, setConnState] = useState('connecting')
  const [, setTick] = useState(0)
  const eventsRef = useRef(new Map())

  useEffect(() => {
    if (!arcUrl || !callbackToken) return
    let es
    try {
      es = new EventSource(`${arcUrl}/events?callbackToken=${encodeURIComponent(callbackToken)}`)
    } catch {
      setConnState('error')
      return
    }

    es.onopen = () => setConnState('open')
    es.onerror = () => setConnState('error')

    const handleStatus = (e) => {
      try {
        const data = JSON.parse(e.data)
        const txid = data.txid
        const status = data.txStatus ?? data.status
        if (!txid || !status) return
        const map = eventsRef.current
        const existing = map.get(txid)
        if (existing && existing.status === status) return
        if (!existing && map.size >= MAX_ENTRIES) {
          const oldestKey = map.keys().next().value
          map.delete(oldestKey)
        }
        map.set(txid, { txid, status, time: ts() })
        setTick(t => t + 1)
      } catch {}
    }

    es.addEventListener('status', handleStatus)
    es.onmessage = handleStatus

    return () => {
      es.close()
    }
  }, [arcUrl, callbackToken])

  function clear() {
    eventsRef.current = new Map()
    setTick(t => t + 1)
  }

  const entries = [...eventsRef.current.values()]

  return (
    <div className="sse-pane">
      <div className="log-header">
        <span>SSE Stream · {connState} · {entries.length} txs</span>
        <button className="clear-btn" onClick={clear}>clear</button>
      </div>
      <div className="log-entries">
        {entries.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'center', marginTop: 40 }}>
            Awaiting events…
          </div>
        )}
        {entries.map(entry => (
          <div key={entry.txid} className="log-entry">
            <span className="log-time">{entry.time}</span>
            <span className="log-content">
              <span className="log-txid">{shortTxid(entry.txid)} </span>
              <span className={`log-status log-status-${entry.status}`}>{entry.status}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
