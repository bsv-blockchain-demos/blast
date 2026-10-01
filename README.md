# BLAST

A browser-based load tester for BSV Arcade. BLAST builds a setup transaction, spends its outputs in configurable batches, and displays broadcast activity alongside live transaction status updates.

[Open BLAST](https://bsv-blockchain-demos.github.io/blast/)

## What it does

- Generates or imports a private key in Wallet Import Format (WIF).
- Looks up spendable outputs through WhatsOnChain and supports funding through a connected BSV wallet.
- Creates a setup transaction with a configurable number of outputs.
- Signs transactions in a Web Worker and submits batches to Arcade.
- Displays broadcast counts, errors, observed transaction rates and server-sent status events.
- Saves setup progress locally and exports transaction IDs as a text file.

## Run locally

Use Node.js 22.12 or later and npm. The locked Vite version requires Node.js `^20.19.0 || >=22.12.0`.

```sh
git clone https://github.com/bsv-blockchain-demos/blast.git
cd blast
npm ci
npm run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`.

To build and preview the production bundle:

```sh
npm run build
npm run preview -- --base=/blast/
```

The build is written to `dist/` and uses the `/blast/` base path. The preview command must specify the same base path; open `http://localhost:4173/blast/`, or the URL printed by Vite. The GitHub Actions workflow deploys `main` to GitHub Pages; adjust `base` in [vite.config.js](vite.config.js) when hosting at a different path.

## Run a load test

BLAST defaults to mainnet and broadcasts real transactions. Each load-test transaction spends an entire setup output as its transaction fee. Use a dedicated key funded only for the intended test.

1. Set **Host URL** and **Network** for your target environment. The network selector changes address derivation and WhatsOnChain lookups; configure the Arcade host and funding wallet for the same network.
2. Generate a key or import a WIF key, then fund the displayed address. **Fund via Wallet** requires a compatible wallet accessible through `WalletClient`.
3. Select **Fetch UTXOs** to retrieve the address's spendable outputs.
4. Set **Output Count** and **Sats Per Output**, then select **Build & Broadcast**. Allow funds for the setup transaction fee as well as the output values.
5. Set **Target TPS** and **Batch Size**, then start the test. Follow broadcast activity and the separate SSE status stream.
6. Stop the test when needed or let it finish when the setup outputs are exhausted. Export transaction IDs for further inspection.

At the default settings, 100 setup outputs at 24 satoshis each allocate 2,400 satoshis to load-test fees, in addition to the setup transaction fee.

## Arcade connection

The default host is `https://arcade-v2-us-1.bsvblockchain.tech`. The target service must permit requests from the browser and expose these interfaces:

| Interface | Purpose |
| --- | --- |
| `POST /tx` | Submit the setup transaction in Extended Format. |
| `POST /txs` | Submit concatenated Extended Format transactions as a batch. |
| `GET /events?callbackToken=...` | Receive transaction status events. |

Broadcast requests include `X-CallbackToken` to associate them with the status stream. Configuration is entered in the interface; no environment file is required.

## Operational notes

- The WIF private key is stored unencrypted in browser `localStorage`. Setup progress is also stored locally; the callback token is stored in `sessionStorage`.
- **Reset Setup** clears saved setup progress while retaining the stored key. Clearing browser storage can remove the only local copy of a generated key, so preserve it first if the address still holds funds.
- Target TPS controls batch pacing. Signing time and request latency also affect the achieved rate.
- A successful HTTP response increments the sent count. Use the status stream or a transaction lookup to check acceptance and confirmation.
- Failed batches advance the saved output cursor and are not retried automatically. A timeout can leave the broadcast outcome uncertain; inspect the exported transaction IDs before reusing outputs.

## Source guide

| File | Responsibility |
| --- | --- |
| [src/App.jsx](src/App.jsx) | Configuration, funding, setup and test controls. |
| [src/buildSetupTx.js](src/buildSetupTx.js) | Setup transaction construction and signing. |
| [src/blastWorker.js](src/blastWorker.js) | Load-test transaction construction and batch submission. |
| [src/SseStream.jsx](src/SseStream.jsx) | Live status events. |
| [src/woc.js](src/woc.js) | WhatsOnChain UTXO lookup. |

## Licence

No licence file is currently included in this repository.
