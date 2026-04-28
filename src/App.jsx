import { useState, useRef, useEffect, useCallback } from 'react'
import { PrivateKey, P2PKH, ARC } from '@bsv/sdk'
import { fetchUTXOs } from './woc.js'
import { buildSetupTx } from './buildSetupTx.js'

const PERSIST_KEY = 'blast_state'

function ts() {
  return new Date().toLocaleTimeString('en', { hour12: false })
}

function shortTxid(txid) {
  if (!txid || txid.length < 16) return txid
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`
}

function loadPersist() {
  try { return JSON.parse(localStorage.getItem(PERSIST_KEY)) ?? {} } catch { return {} }
}

function savePersist(obj) {
  try { localStorage.setItem(PERSIST_KEY, JSON.stringify(obj)) } catch {}
}

export default function App() {
  const [hostUrl, setHostUrl] = useState(() => loadPersist().hostUrl ?? 'https://arcade-v2-us-1.bsvblockchain.tech')
  const [wifKey, setWifKey] = useState('')
  const [network, setNetwork] = useState(() => loadPersist().network ?? 'main')
  const [outputCount, setOutputCount] = useState(100)
  const [satoshisPerOutput, setSatoshisPerOutput] = useState(() => loadPersist().satoshisPerOutput ?? 1000)

  const [phase, setPhase] = useState('idle') // idle | setup | ready | blasting
  const [setupStatus, setSetupStatus] = useState('')
  const [setupError, setSetupError] = useState('')

  const [utxos, setUtxos] = useState(null)
  const [setupTxid, setSetupTxid] = useState(() => loadPersist().setupTxid ?? '')
  const [setupOutputCount, setSetupOutputCount] = useState(() => loadPersist().setupOutputCount ?? 0)
  const [setupSatoshisPerOutput, setSetupSatoshisPerOutput] = useState(() => loadPersist().satoshisPerOutput ?? 1000)
  const [nextVout, setNextVout] = useState(() => loadPersist().nextVout ?? 0)

  const [blastRate, setBlastRate] = useState(10)
  const [batchSize, setBatchSize] = useState(10)

  const [log, setLog] = useState([])
  const [stats, setStats] = useState({ sent: 0, errors: 0, batches: 0, tps: 0 })

  const workerRef = useRef(null)
  const sseRef = useRef(null)
  const tpsCounterRef = useRef({ count: 0, lastTime: Date.now() })
  const statsRef = useRef(stats)
  statsRef.current = stats

  const hasResume = Boolean(loadPersist().setupTxid) && loadPersist().setupTxid !== ''

  function addLog(entry) {
    setLog(prev => [{ id: Date.now() + Math.random(), time: ts(), ...entry }, ...prev].slice(0, 500))
  }

  function clearLog() { setLog([]) }

  function resetSetup() {
    savePersist({ hostUrl, network, satoshisPerOutput })
    setSetupTxid('')
    setSetupOutputCount(0)
    setNextVout(0)
    setPhase('idle')
    setSetupStatus('')
    setSetupError('')
    setUtxos(null)
  }

  async function handleFetchUTXOs() {
    setSetupError('')
    try {
      let key
      try { key = PrivateKey.fromWif(wifKey.trim()) } catch {
        throw new Error('Invalid WIF private key')
      }
      const addr = key.toAddress(network === 'main' ? [0x00] : [0x6f])
      setSetupStatus(`Fetching UTXOs for ${addr}…`)
      const data = await fetchUTXOs(addr, network)
      if (data.length === 0) throw new Error('No UTXOs found for this address')
      setUtxos(data)
      const total = data.reduce((s, u) => s + u.value, 0)
      setSetupStatus(`${data.length} UTXOs · ${total.toLocaleString()} sats`)
      addLog({ type: 'info', msg: `Fetched ${data.length} UTXOs (${total.toLocaleString()} sats) for ${addr}` })
    } catch (err) {
      setSetupError(err.message)
      setSetupStatus('')
    }
  }

  async function handleBroadcastSetup() {
    setSetupError('')
    try {
      let privateKey
      try { privateKey = PrivateKey.fromWif(wifKey.trim()) } catch {
        throw new Error('Invalid WIF private key')
      }
      const address = privateKey.toAddress(network === 'main' ? [0x00] : [0x6f])

      setPhase('setup')
      setSetupStatus('Building setup transaction…')

      const tx = await buildSetupTx({
        utxos,
        privateKey,
        address,
        outputCount: parseInt(outputCount),
        satoshisPerOutput: parseInt(satoshisPerOutput)
      })

      const callbackToken = crypto.randomUUID()
      const arcUrl = hostUrl.replace(/\/$/, '')

      setSetupStatus('Broadcasting…')

      const arc = new ARC(arcUrl, { callbackToken })
      const result = await arc.broadcast(tx)

      if (result.status === 'error') {
        throw new Error(result.description ?? 'Broadcast failed')
      }

      const txid = result.txid
      const count = parseInt(outputCount)
      const satsEach = parseInt(satoshisPerOutput)

      setSetupTxid(txid)
      setSetupOutputCount(count)
      setSetupSatoshisPerOutput(satsEach)
      setNextVout(0)
      savePersist({ hostUrl, network, setupTxid: txid, setupOutputCount: count, satoshisPerOutput: satsEach, nextVout: 0 })

      addLog({ type: 'setup', txid, status: result.data ?? 'BROADCAST', msg: `Setup tx · ${count} outputs` })
      setSetupStatus(`Broadcast OK — waiting for SEEN_ON_NETWORK…`)

      openSSE(arcUrl, callbackToken, txid)
    } catch (err) {
      setSetupError(err.message)
      setPhase('idle')
      setSetupStatus('')
    }
  }

  function openSSE(arcUrl, callbackToken, expectedTxid) {
    if (sseRef.current) {
      sseRef.current.close()
      sseRef.current = null
    }

    const url = `${arcUrl}/events?callbackToken=${encodeURIComponent(callbackToken)}`
    let es

    try {
      es = new EventSource(url)
    } catch {
      setSetupStatus('SSE not supported — tx submitted. Check manually, then enable blast.')
      setPhase('ready')
      return
    }

    sseRef.current = es

    es.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data)
        const status = data.txStatus ?? data.status ?? 'UPDATE'
        addLog({ type: 'setup', txid: data.txid ?? expectedTxid, status })
        setSetupStatus(`Status: ${status}`)

        if (status === 'SEEN_ON_NETWORK' || status === 'MINED') {
          setPhase('ready')
          setSetupStatus(`Ready — ${setupOutputCount || parseInt(outputCount)} outputs available`)
          es.close()
          sseRef.current = null
          addLog({ type: 'success', msg: `Setup complete — blast phase unlocked` })
        }
      } catch {}
    })

    es.addEventListener('error', () => {
      setSetupStatus('SSE connection dropped — tx submitted. Enable blast manually if confirmed.')
      setPhase('ready')
      es.close()
      sseRef.current = null
    })

    setTimeout(() => {
      if (sseRef.current === es) {
        setPhase('ready')
        setSetupStatus('SSE timeout — enabling blast (tx may still propagate)')
        es.close()
        sseRef.current = null
      }
    }, 60_000)
  }

  function handleEnableBlastManually() {
    setPhase('ready')
    setSetupStatus('Manually enabled')
  }

  function handleStartBlast() {
    if (!setupTxid || phase === 'blasting') return

    const currentNextVout = nextVout
    const currentCount = setupOutputCount
    if (currentNextVout >= currentCount) {
      addLog({ type: 'info', msg: 'All outputs already spent. Reset setup to start again.' })
      return
    }

    const rate = parseFloat(blastRate) || 10
    const batch = parseInt(batchSize) || 10
    const intervalMs = Math.max(50, Math.round((batch / rate) * 1000))

    setPhase('blasting')
    tpsCounterRef.current = { count: 0, lastTime: Date.now() }
    addLog({ type: 'info', msg: `Blast start — ${rate} TPS · batch ${batch} · interval ${intervalMs}ms · from vout ${currentNextVout}` })

    const BlastWorker = new Worker(new URL('./blastWorker.js', import.meta.url), { type: 'module' })
    workerRef.current = BlastWorker

    BlastWorker.onmessage = ({ data }) => {
      if (data.type === 'batch') {
        const { results, nextVout: nv, txCount } = data
        setNextVout(nv)
        savePersist({ ...loadPersist(), nextVout: nv })

        const now = Date.now()
        tpsCounterRef.current.count += txCount
        const elapsed = (now - tpsCounterRef.current.lastTime) / 1000
        if (elapsed >= 1) {
          const tps = Math.round(tpsCounterRef.current.count / elapsed)
          tpsCounterRef.current = { count: 0, lastTime: now }
          setStats(s => ({ ...s, tps }))
        }

        setStats(s => ({ ...s, sent: s.sent + txCount, batches: s.batches + 1 }))

        if (Array.isArray(results) && results.length > 0) {
          const sample = results[0]
          addLog({
            type: 'blast',
            txid: sample.txid,
            status: sample.txStatus ?? sample.status ?? 'SENT',
            msg: `batch ${txCount} txs (vout ${data.batchStartVout}–${nv - 1})`
          })
        } else {
          addLog({ type: 'blast', msg: `batch ${txCount} txs (vout ${data.batchStartVout}–${nv - 1}) — no result data` })
        }
      }

      if (data.type === 'batch_error') {
        const { error, txCount, nextVout: nv } = data
        setNextVout(nv)
        savePersist({ ...loadPersist(), nextVout: nv })
        setStats(s => ({ ...s, errors: s.errors + txCount }))
        addLog({ type: 'error', msg: `Batch error (${txCount} txs): ${error}` })
      }

      if (data.type === 'done') {
        setPhase('ready')
        addLog({ type: 'info', msg: `Blast done — reason: ${data.reason}` })
        BlastWorker.terminate()
        workerRef.current = null
      }
    }

    BlastWorker.onerror = (e) => {
      addLog({ type: 'error', msg: `Worker error: ${e.message}` })
      setPhase('ready')
    }

    BlastWorker.postMessage({
      type: 'start',
      hostUrl: hostUrl.replace(/\/$/, ''),
      setupTxid,
      setupOutputCount: currentCount,
      startVout: currentNextVout,
      batchSize: batch,
      intervalMs
    })
  }

  function handleAbort() {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'stop' })
      setTimeout(() => {
        if (workerRef.current) {
          workerRef.current.terminate()
          workerRef.current = null
        }
        setPhase('ready')
        addLog({ type: 'info', msg: 'Blast aborted' })
      }, 500)
    }
  }

  function handleResumeFromSaved() {
    const saved = loadPersist()
    if (!saved.setupTxid) return
    setSetupTxid(saved.setupTxid)
    setSetupOutputCount(saved.setupOutputCount ?? 0)
    setSetupSatoshisPerOutput(saved.satoshisPerOutput ?? 1000)
    setNextVout(saved.nextVout ?? 0)
    if (saved.hostUrl) setHostUrl(saved.hostUrl)
    setPhase('ready')
    addLog({ type: 'info', msg: `Resumed: txid ${shortTxid(saved.setupTxid)}, next vout ${saved.nextVout ?? 0}` })
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (workerRef.current) workerRef.current.terminate()
      if (sseRef.current) sseRef.current.close()
    }
  }, [])

  const canFetchUtxos = Boolean(wifKey.trim()) && Boolean(hostUrl.trim())
  const canBroadcastSetup = utxos !== null && utxos.length > 0 && phase === 'idle'
  const canStartBlast = (phase === 'ready') && Boolean(setupTxid) && nextVout < setupOutputCount
  const remaining = setupOutputCount - nextVout

  return (
    <div className="app">
      <div className="header">
        <h1>BLAST</h1>
        <span className="subtitle">ARCADE LOAD TESTER</span>
        <div style={{ flex: 1 }} />
        <span className={`badge badge-${phase === 'blasting' ? 'blasting' : phase === 'ready' ? 'ready' : phase === 'setup' ? 'setup' : 'idle'}`}>
          {phase === 'blasting' ? 'BLASTING' : phase === 'ready' ? 'READY' : phase === 'setup' ? 'SETUP' : 'IDLE'}
        </span>
      </div>

      <div className="main">
        <div className="sidebar">

          {/* Config */}
          <div className="section">
            <div className="section-title">Config</div>
            <div className="section-body">
              <div className="field">
                <label>Host URL</label>
                <input value={hostUrl} onChange={e => setHostUrl(e.target.value)} placeholder="http://arcade.example.com" disabled={phase === 'blasting'} />
              </div>
              <div className="field">
                <label>WIF Private Key</label>
                <input type="password" value={wifKey} onChange={e => setWifKey(e.target.value)} placeholder="5J… or L… or K…" disabled={phase === 'blasting'} />
              </div>
              <div className="field">
                <label>Network</label>
                <select value={network} onChange={e => setNetwork(e.target.value)} disabled={phase === 'blasting'}>
                  <option value="main">Mainnet</option>
                  <option value="test">Testnet</option>
                </select>
              </div>
            </div>
          </div>

          {/* Resume banner */}
          {hasResume && phase === 'idle' && (
            <div className="resume-banner">
              <strong>Saved session found</strong>
              txid: {shortTxid(loadPersist().setupTxid)}<br />
              next vout: {loadPersist().nextVout ?? 0} / {loadPersist().setupOutputCount ?? '?'}
              <button className="btn btn-warn" style={{ marginTop: 8 }} onClick={handleResumeFromSaved}>
                Resume
              </button>
            </div>
          )}

          {/* Phase 1: Setup */}
          <div className="section">
            <div className="section-title">Phase 1 — Setup</div>
            <div className="section-body">
              <div className="field">
                <label>Output Count</label>
                <input type="number" value={outputCount} onChange={e => setOutputCount(e.target.value)} min={1} max={10000} disabled={phase !== 'idle'} />
              </div>
              <div className="field">
                <label>Sats Per Output</label>
                <input type="number" value={satoshisPerOutput} onChange={e => setSatoshisPerOutput(e.target.value)} min={100} disabled={phase !== 'idle'} />
              </div>

              {utxos && (
                <div className="utxo-info">
                  {utxos.length} UTXOs · {utxos.reduce((s, u) => s + u.value, 0).toLocaleString()} sats
                </div>
              )}

              {setupStatus && (
                <div className={`status-text ${setupError ? 'err' : phase === 'ready' ? 'ok' : 'warn'}`}>
                  {setupStatus}
                </div>
              )}
              {setupError && <div className="status-text err">{setupError}</div>}

              <button className="btn btn-secondary" onClick={handleFetchUTXOs} disabled={!canFetchUtxos || phase !== 'idle'}>
                Fetch UTXOs
              </button>
              <button className="btn btn-primary" onClick={handleBroadcastSetup} disabled={!canBroadcastSetup}>
                Build & Broadcast
              </button>

              {phase === 'setup' && (
                <button className="btn btn-secondary" onClick={handleEnableBlastManually}>
                  Enable Blast Manually
                </button>
              )}

              {(phase === 'ready' || phase === 'blasting') && setupTxid && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div className="status-text ok">
                    Setup txid: {shortTxid(setupTxid)}
                  </div>
                  <div className="status-text ok">
                    {remaining.toLocaleString()} / {setupOutputCount.toLocaleString()} outputs remaining
                  </div>
                  <button className="btn btn-secondary" style={{ marginTop: 4 }} onClick={resetSetup} disabled={phase === 'blasting'}>
                    Reset Setup
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Phase 2: Blast */}
          <div className="section">
            <div className="section-title">Phase 2 — Blast</div>
            <div className="section-body">
              <div className="field">
                <label>Target TPS</label>
                <input type="number" value={blastRate} onChange={e => setBlastRate(e.target.value)} min={0.1} step={1} disabled={phase === 'blasting'} />
              </div>
              <div className="field">
                <label>Batch Size (txs per call)</label>
                <input type="number" value={batchSize} onChange={e => setBatchSize(e.target.value)} min={1} max={1000} disabled={phase === 'blasting'} />
              </div>

              {phase === 'blasting' && (
                <div className="tps-display">{stats.tps} <span style={{ fontSize: 12, color: 'var(--muted)' }}>TPS</span></div>
              )}

              <div className="stats-grid">
                <div className="stat-box">
                  <div className="stat-value">{stats.sent.toLocaleString()}</div>
                  <div className="stat-label">Sent</div>
                </div>
                <div className="stat-box">
                  <div className="stat-value" style={{ color: stats.errors > 0 ? 'var(--err)' : 'var(--accent)' }}>
                    {stats.errors.toLocaleString()}
                  </div>
                  <div className="stat-label">Errors</div>
                </div>
              </div>

              <div className="btn-row">
                <button className="btn btn-primary" onClick={handleStartBlast} disabled={!canStartBlast}>
                  Start Blast
                </button>
                <button className="btn btn-danger" onClick={handleAbort} disabled={phase !== 'blasting'}>
                  Abort
                </button>
              </div>

              {!canStartBlast && phase === 'idle' && (
                <div className="status-text">Complete setup phase first</div>
              )}
            </div>
          </div>

        </div>

        {/* Log pane */}
        <div className="log-pane">
          <div className="log-header">
            <span>Transaction Log</span>
            <button className="clear-btn" onClick={clearLog}>clear</button>
          </div>
          <div className="log-entries">
            {log.length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'center', marginTop: 40 }}>
                No transactions yet
              </div>
            )}
            {log.map(entry => (
              <div key={entry.id} className="log-entry">
                <span className="log-time">{entry.time}</span>
                <span className={`log-type log-type-${entry.type}`}>{entry.type}</span>
                <span className="log-content">
                  {entry.txid && (
                    <span className="log-txid">{shortTxid(entry.txid)} </span>
                  )}
                  {entry.status && (
                    <span className={`log-status log-status-${entry.status}`}>{entry.status} </span>
                  )}
                  {entry.msg && <span className="log-msg">{entry.msg}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
