#!/usr/bin/env node

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory cache to reduce API calls during a run
const cache = new Map();
const cached = async (key, fn, ttlMs = 30_000) => {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.t <= ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { v, t: now });
  return v;
};

// Utilities
const toIsoDate = (tsMs) => new Date(tsMs).toISOString().slice(0, 10);
const toIsoTime = (tsMs) => new Date(tsMs).toISOString().slice(11, 19);

// Output record
const txRecord = ({ tsMs, amount, crypto, description, from, to, txHash }) => ({
  date: toIsoDate(tsMs),
  time: toIsoTime(tsMs),
  amount,           
  crypto,           
  description,      
  from,
  to,
  txHash,
});

// Bitcoin (Blockstream Esplora)
const BTC_API = 'https://blockstream.info/api';

async function btcGetTxs(address, limit = 200) {
  // Blockstream returns newest first. 
  // Pagination via "last seen ID".
  // Fetch until there are no more or we reach limit.
  const out = [];
  let lastTxid = null;

  while (out.length < limit) {
    const url = lastTxid
      ? `${BTC_API}/address/${address}/txs/chain/${lastTxid}`
      : `${BTC_API}/address/${address}/txs`;
    const page = await cached(`btc:txs:${address}:${lastTxid ?? 'first'}`, async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`BTC tx fetch failed: ${res.status}`);
      return res.json();
    }, 15_000);

    if (!page.length) break;
    for (const tx of page) {
      out.push(tx);
      lastTxid = tx.txid;
      if (out.length >= limit) break;
    }
    // Delay
    await sleep(200);
  }
  return out;
}

async function btcGetBalance(address) {
  const url = `${BTC_API}/address/${address}`;
  const data = await cached(`btc:addr:${address}`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`BTC addr fetch failed: ${res.status}`);
    return res.json();
  }, 15_000);
  const sats = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum
             + data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
  // sats - BTC units
  return sats / 1e8;
}

async function btcBalanceAtDate(address, dateStr) {
  // Approach: sum confirmed transactions up to end-of-day UTC
  const end = new Date(dateStr + 'T23:59:59.999Z').getTime();
  const txs = await btcGetTxs(address, 1000);
  let sats = 0;
  for (const tx of txs) {
    // Block time; if unconfirmed, skip
    const ts = tx.status?.block_time ? tx.status.block_time * 1000 : Number.MAX_SAFE_INTEGER;
    if (ts > end) continue;

    // Net effect for address: outputs to address - inputs from address
    // Build set of address appearances in inputs
    const inputFromAddr = tx.vin.some((vin) =>
      vin.prevout && vin.prevout.scriptpubkey_address === address
    );
    // Sum outputs to address
    const outputsToAddr = tx.vout
      .filter((v) => v.scriptpubkey_address === address)
      .reduce((s, v) => s + (v.value || 0), 0);

    // Sum inputs from address
    const inputsFromAddr = tx.vin
      .filter((vin) => vin.prevout && vin.prevout.scriptpubkey_address === address)
      .reduce((s, vin) => s + (vin.prevout.value || 0), 0);

    sats += outputsToAddr - inputsFromAddr;
  }
  return sats / 1e8;
}

function btcNormalizeTxs(address, rawTxs) {
  const records = [];
  for (const tx of rawTxs) {
    const tsMs = (tx.status?.block_time || tx.received_at ? (tx.status?.block_time || Math.floor(new Date(tx.received_at).getTime()/1000)) : 0) * 1000;

    const outputsToAddr = tx.vout.filter(v => v.scriptpubkey_address === address);
    const inputsFromAddr = tx.vin.filter(v => v.prevout?.scriptpubkey_address === address);

    const sumOutTo = outputsToAddr.reduce((s, v) => s + (v.value || 0), 0);
    const sumInFrom = inputsFromAddr.reduce((s, vin) => s + (vin.prevout?.value || 0), 0);

    let amountSats = sumOutTo - sumInFrom;
    const direction = amountSats >= 0 ? 'Received' : 'Sent';
    const amount = Math.abs(amountSats) / 1e8;

    // Guess counterparty
    let from = undefined;
    let to = undefined;
    if (direction === 'Received') {
      // from any other input address 
      from = tx.vin.find(v => v.prevout?.scriptpubkey_address && v.prevout.scriptpubkey_address !== address)?.prevout?.scriptpubkey_address;
      to = address;
    } else {
      from = address;
      to = tx.vout.find(v => v.scriptpubkey_address && v.scriptpubkey_address !== address)?.scriptpubkey_address;
    }

    records.push(txRecord({
      tsMs: tsMs || 0,
      amount,
      crypto: 'BTC',
      description: direction,
      from,
      to,
      txHash: tx.txid,
    }));
  }
  return records;
}

// Ethereum (EthVM public API)
const ETH_API = ' https://rest-api.ethvm.dev';

async function ethGetTxs(address, limit = 200) {
  const out = [];
  let cursor = '';
  while (out.length < limit) {
    const url = `${ETH_API}/v2/addresses/${address}/transactions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await cached(`eth:txs:${address}:${cursor || 'first'}`, async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ETH tx fetch failed: ${res.status}`);
      return res.json();
    }, 10_000);

    const page = data.items || data.transactions || [];
    for (const tx of page) {
      out.push(tx);
      if (out.length >= limit) break;
    }
    if (!data.nextPageParams?.cursor) break;
    cursor = data.nextPageParams.cursor;
    await sleep(150);
  }
  return out;
}

async function ethGetBalance(address) {
  const url = `${ETH_API}/v2/addresses/${address}`;
  const data = await cached(`eth:addr:${address}`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ETH addr fetch failed: ${res.status}`);
    return res.json();
  }, 10_000);
  // balances are in wei for ETH;
  const wei = data.nativeBalance?.wei ?? data.balance?.wei ?? '0';
  return Number(BigInt(wei)) / 1e18;
}

async function ethBalanceAtDate(address, dateStr) {
  const end = new Date(dateStr + 'T23:59:59.999Z').getTime();
  // Strategy: iterate txs (limited) and accumulate net ether transfers.
  const txs = await ethGetTxs(address, 2000);
  let wei = 0n;
  for (const tx of txs) {
    const tsMs = (tx.timestamp || tx.blockTimestamp || 0) * 1000;
    if (tsMs > end) continue;

    const from = tx.from || tx.sender;
    const to = tx.to || tx.receiver;
    const valueWei = BigInt(tx.valueWei ?? tx.value?.wei ?? '0');

    if (from?.toLowerCase() === address.toLowerCase()) wei -= valueWei;
    if (to?.toLowerCase() === address.toLowerCase()) wei += valueWei;

    // Note: ignores gas costs; for exact historical balance, subtract gas for outgoing txs:
    // wei -= BigInt(tx.gasUsed) * BigInt(tx.gasPriceWei)
    // Include if data available:
    if (from?.toLowerCase() === address.toLowerCase()) {
      const gasUsed = tx.gasUsed ?? tx.receipt?.gasUsed;
      const gasPriceWei = tx.gasPriceWei ?? tx.gasPrice?.wei;
      if (gasUsed != null && gasPriceWei != null) {
        try { wei -= BigInt(gasUsed) * BigInt(gasPriceWei); } catch {}
      }
    }
  }
  return Number(wei) / 1e18;
}

function ethNormalizeTxs(address, rawTxs) {
  const lower = address.toLowerCase();
  return rawTxs.map((tx) => {
    const tsMs = (tx.timestamp || tx.blockTimestamp || 0) * 1000;
    const from = (tx.from || tx.sender) ?? undefined;
    const to = (tx.to || tx.receiver) ?? undefined;
    const valueWei = BigInt(tx.valueWei ?? tx.value?.wei ?? '0');
    const amount = Number(valueWei) / 1e18;

    let description = 'Transfer';
    if (!to) description = 'Contract Creation';
    if (tx.input && tx.input !== '0x' && to) description = 'Contract Call';

    // Direction by address match
    if (from?.toLowerCase() === lower && amount > 0) description = 'Sent';
    if (to?.toLowerCase() === lower && amount > 0) description = 'Received';

    return txRecord({
      tsMs,
      amount,
      crypto: 'ETH',
      description,
      from,
      to,
      txHash: tx.hash || tx.txHash || tx.transactionHash,
    });
  });
}

// Solana (Native RPC API)
const SOL_RPC = 'https://api.mainnet-beta.solana.com';

async function solRpc(method, params) {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SOL RPC failed: ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`SOL RPC error: ${json.error.message}`);
  return json.result;
}

async function solGetTxs(address, limit = 200) {
  // Fetch signatures then details
  const sigRes = await solRpc('getSignaturesForAddress', [
    address,
    { limit: Math.min(limit, 1000) },
  ]);
  const sigs = sigRes?.map((s) => s.signature) || [];
  const chunks = [];
  for (let i = 0; i < sigs.length; i += 10) chunks.push(sigs.slice(i, i + 10));
  const out = [];
  for (const ch of chunks) {
    const details = await solRpc('getTransactions', [ch, { maxSupportedTransactionVersion: 0 }]);
    out.push(...(details || []));
    await sleep(120);
  }
  return out;
}

async function solGetBalance(address) {
  const result = await solRpc('getBalance', [address, { commitment: 'processed' }]);
  return result.value / 1e9; // lamports to SOL
}

async function solBalanceAtDate(address, dateStr) {
  const end = new Date(dateStr + 'T23:59:59.999Z').getTime() / 1000; // in seconds
  const sigRes = await solRpc('getSignaturesForAddress', [
    address,
    { limit: 1000, before: null, until: null },
  ]);
  const sigs = sigRes?.filter(s => s.blockTime && s.blockTime <= end).map(s => s.signature) || [];
  const chunks = [];
  for (let i = 0; i < sigs.length; i += 10) chunks.push(sigs.slice(i, i + 10));

  let lamports = 0n;
  for (const ch of chunks) {
    const details = await solRpc('getTransactions', [ch, { maxSupportedTransactionVersion: 0 }]);
    for (const tx of details || []) {
      if (!tx) continue;
      const meta = tx.meta;
      if (!meta) continue;
      const message = tx.transaction.message;
      const keys = message.accountKeys?.map(k => typeof k === 'string' ? k : k.pubkey) || [];
      const idx = keys.findIndex(k => k === address);
      if (idx >= 0) {
        const pre = BigInt(meta.preBalances?.[idx] ?? 0);
        const post = BigInt(meta.postBalances?.[idx] ?? 0);
        lamports += post - pre;
      }
    }
    await sleep(120);
  }
  return Number(lamports) / 1e9;
}

function solNormalizeTxs(address, rawTxs) {
  const records = [];
  for (const tx of rawTxs) {
    if (!tx) continue;
    const tsMs = (tx.blockTime || 0) * 1000;
    const meta = tx.meta;
    const message = tx.transaction?.message;
    const keys = message?.accountKeys?.map(k => typeof k === 'string' ? k : k.pubkey) || [];
    const idx = keys.findIndex(k => k === address);

    let lamportsDelta = 0n;
    if (idx >= 0 && meta?.preBalances && meta?.postBalances) {
      const pre = BigInt(meta.preBalances[idx] || 0);
      const post = BigInt(meta.postBalances[idx] || 0);
      lamportsDelta = post - pre;
    }

    let description = 'Transfer';
    const programs = (message?.instructions || []).map(ix => {
      const accIdx = ix.programIdIndex;
      return typeof accIdx === 'number' ? keys[accIdx] : undefined;
    });
    if (programs.some(() => false)) {
      // placeholder; default to Transfer
    }

    let from, to;

    records.push(txRecord({
      tsMs,
      amount: Math.abs(Number(lamportsDelta)) / 1e9,
      crypto: 'SOL',
      description: lamportsDelta >= 0n ? 'Received' : 'Sent',
      from,
      to,
      txHash: tx.transaction?.signatures?.[0],
    }));
  }
  return records;
}

// Public API

async function getTransactions(address, crypto) {
  const c = crypto.toUpperCase();
  if (c === 'BTC') {
    const raw = await btcGetTxs(address, 200);
    return btcNormalizeTxs(address, raw);
  }
  if (c === 'ETH') {
    const raw = await ethGetTxs(address, 200);
    return ethNormalizeTxs(address, raw);
  }
  if (c === 'SOL') {
    const raw = await solGetTxs(address, 200);
    return solNormalizeTxs(address, raw);
  }
  throw new Error('Unsupported crypto. Use BTC, ETH, or SOL.');
}

async function getCurrentBalance(address, crypto) {
  const c = crypto.toUpperCase();
  if (c === 'BTC') return btcGetBalance(address);
  if (c === 'ETH') return ethGetBalance(address);
  if (c === 'SOL') return solGetBalance(address);
  throw new Error('Unsupported crypto. Use BTC, ETH, or SOL.');
}

async function getBalanceAtDate(address, crypto, date) {
  const c = crypto.toUpperCase();
  if (c === 'BTC') return btcBalanceAtDate(address, date);
  if (c === 'ETH') return ethBalanceAtDate(address, date);
  if (c === 'SOL') return solBalanceAtDate(address, date);
  throw new Error('Unsupported crypto. Use BTC, ETH, or SOL.');
}

// CLI demo 
async function demo() {
  const sample = {
    //examples
    BTC: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 
    ETH: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 
    SOL: '11111111111111111111111111111111',  
  };

  try {
    const txs = await getTransactions(sample.ETH, 'ETH');
    console.log('Sample ETH transactions (first 3):');
    console.log(JSON.stringify(txs.slice(0, 3), null, 2));

    const balNow = await getCurrentBalance(sample.ETH, 'ETH');
    console.log(`Current ETH balance: ${balNow}`);

    const balOn = await getBalanceAtDate(sample.ETH, 'ETH', '2023-12-31');
    console.log(`ETH balance on 2023-12-31: ${balOn}`);
  } catch (e) {
    console.error('Demo error:', e.message);
  }
}

if (require.main === module) {
  demo();
}

module.exports = {
  getTransactions,
  getCurrentBalance,
  getBalanceAtDate,
};