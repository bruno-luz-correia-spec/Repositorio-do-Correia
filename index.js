const express = require('express');
const cheerio = require('cheerio');
const app = express();

// Fetch nativo Node 18+ ou node-fetch
const fetchFn = (typeof fetch === 'function')
  ? fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(m => m.default(...args));

const BRAPI_TOKEN = "84PcnuP9Y5j7kyv1tBJdEm";

// ativos
const BR_STOCKS = [
  'ITSA4','RAPT4','EGIE3','SAPR11','TAEE11',
  'HYPE3','INTB3','WEGE3','PSSA3','BRSR6','CAML3','HAPV3'
];
const BR_FIIS = [
  'XPLG11','KNRI11','HGLG11','KNIP11',
  'IRDM11','HGRU11','HGRE11','MXRF11'
];
const US_ETFS = ['IVV','BIL','SCHD'];
const GERAL   = ['SELIC HOJE','DOLAR','BITCOIN'];

// todos os símbolos
const ALL = [...GERAL, ...BR_STOCKS, ...BR_FIIS, ...US_ETFS];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// cache em memória
const cache = new Map();
ALL.forEach(sym => cache.set(sym, { changePct: null, price: null, ts: 0 }));

// converte "1.234,56" → 1234.56
function parseLocaleNumber(str) {
  if (!str) return NaN;
  let s = str.trim().replace(/[^\d.,\-+]/g, '');
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c > -1 && d > -1) {
    if (c > d) s = s.replace(/\./g,'').replace(',','.');
    else      s = s.replace(/,/g,'');
  } else if (c > -1) {
    s = s.replace(/\./g,'').replace(',','.');
  } else {
    s = s.replace(/,/g,'');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// scrape de par de moeda/crypo ex: "USD-BRL", "BTC-BRL"
async function scrapeGoogleCurrency(pair) {
  try {
    const url = `https://www.google.com/finance/quote/${encodeURIComponent(pair)}?hl=pt-BR`;
    const res = await fetchFn(url, {
      headers:{ 'User-Agent':'Mozilla/5.0', 'Accept-Language':'pt-BR' }
    });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const txt = $('div.YMlKec.fxKbKc').first().text().trim();
    const num = parseLocaleNumber(txt);
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

// suffix de mercado para Google Finance
function marketSuffix(sym) {
  return US_ETFS.includes(sym) ? 'NYSEARCA' : 'BVMF';
}

// scrape de preço para ações, FIIs e ETFs
async function scrapeGooglePrice(sym) {
  try {
    const url = `https://www.google.com/finance/quote/${encodeURIComponent(sym)}:${marketSuffix(sym)}?hl=pt-BR`;
    const res = await fetchFn(url, {
      headers:{ 'User-Agent':'Mozilla/5.0', 'Accept-Language':'pt-BR' }
    });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const txt = $('div.YMlKec.fxKbKc').first().text().trim();
    const num = parseLocaleNumber(txt);
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

// busca fechamento anterior via brapi.dev
async function fetchPrevClose(sym) {
  try {
    const url = new URL(`https://brapi.dev/api/quote/${encodeURIComponent(sym)}`);
    url.searchParams.set('token', BRAPI_TOKEN);
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const js = await res.json();
    const prev = Number(js.results?.[0]?.regularMarketPreviousClose ?? NaN);
    return Number.isFinite(prev) ? prev : null;
  } catch {
    return null;
  }
}

// busca SELIC no BCB (série 432)
async function fetchSelic() {
  try {
    const res = await fetchFn(
      'https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json'
    );
    const j = await res.json();
    const v = Number(j?.[0]?.valor ?? NaN);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// atualiza um símbolo
async function updateSymbol(sym) {
  // bloco GERAL
  if (GERAL.includes(sym)) {
    // SELIC sempre fresh
    if (sym === 'SELIC HOJE') {
      const s = await fetchSelic();
      cache.set(sym, { changePct: null, price: s, ts: Date.now() });
    }
    // DÓLAR e BITCOIN a cada 10 min
    if (sym === 'DOLAR' || sym === 'BITCOIN') {
      const entry = cache.get(sym);
      if (Date.now() - entry.ts < 10 * 60 * 1000) return;
      const pair = sym === 'DOLAR' ? 'USD-BRL' : 'BTC-BRL';
      const price = await scrapeGoogleCurrency(pair);
      let pct = null;
      if (price != null && Number.isFinite(entry.price)) {
        pct = ((price - entry.price) / entry.price) * 100;
        pct = clamp(pct, -50, 50);
      }
      cache.set(sym, { changePct: pct, price, ts: Date.now() });
    }
    return;
  }

  // ações, FIIs, ETFs (3min)
  const price = await scrapeGooglePrice(sym);
  const prev  = await fetchPrevClose(sym);
  let pct = null;
  if (price != null && prev != null && prev !== 0) {
    pct = ((price - prev) / prev) * 100;
  }
  cache.set(sym, {
    changePct: pct != null ? clamp(pct, -50, 50) : null,
    price: price != null ? price : cache.get(sym).price,
    ts: Date.now()
  });
}

// ciclo de atualização
async function updateAll() {
  console.log('=== Atualização', new Date().toLocaleTimeString(), '===');
  for (const sym of ALL) {
    await updateSymbol(sym);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('=== Fim do ciclo ===\n');
}

updateAll();
setInterval(updateAll, 3 * 60 * 1000);  // a cada 3 minutos

// API /api/heatmap
app.get('/api/heatmap', (req, res) => {
  const make = arr => arr
    .map(sym => ({
      symbol:    sym,
      changePct: cache.get(sym).changePct,
      price:     cache.get(sym).price
    }))
    .sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));

  res.json({
    updatedAt: new Date().toISOString(),
    groups: [
      { name: 'GERAL',               items: make(GERAL) },
      { name: 'Ações Brasileiras',   items: make(BR_STOCKS) },
      { name: 'Fundos Imobiliários', items: make(BR_FIIS) },
      { name: 'ETFs Americanos',     items: make(US_ETFS) }
    ]
  });
});

// painel HTML com hora e data da última atualização
app.get('/', (req, res) => {
  const html = `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Heatmap Pro</title>
<style>
  body { margin:0; background:#0b0f14; font-family:sans-serif; color:#000; }
  .screen { display:grid; grid-template-rows:repeat(4,1fr); min-height:100vh; gap:10px; padding:10px; }
  .group { position:relative; border-radius:12px; background:rgba(255,255,255,0.05); }
  .group-label { position:absolute; top:8px; left:10px; font-size:12px;
    background:rgba(255,255,255,0.08); padding:6px 10px; border-radius:999px;
    color:#c8d1da; font-weight:600; }
  .grid { position:absolute; inset:0; padding:30px 10px 10px;
    display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr));
    grid-auto-rows:100px; gap:10px; }
  .tile { border-radius:15px; display:flex; flex-direction:column;
    justify-content:space-between; padding:14px; background:#cfcfcf; color:#000;
    box-shadow:inset 0 0 8px rgba(0,0,0,0.15);
    transition:background-color .3s ease; }
  .tile-symbol { font-weight:900; font-size:18px; }
  .tile-meta { display:flex; justify-content:space-between; font-weight:700; font-size:14px; }
  .last-update { position:absolute; bottom:8px; right:10px; color:#c8d1da; font-size:12px; }
</style>
</head><body>
<div class="screen">
  <section class="group"><div class="group-label">GERAL</div><div class="grid" id="grid-geral"></div></section>
  <section class="group"><div class="group-label">AÇÕES BRASILEIRAS</div><div class="grid" id="grid-br"></div></section>
  <section class="group"><div class="group-label">FUNDOS IMOBILIÁRIOS</div><div class="grid" id="grid-fiis"></div></section>
  <section class="group"><div class="group-label">ETFs AMERICANOS</div><div class="grid" id="grid-us"></div></section>
</div>
<div class="last-update" id="last-update"></div>
<script>
  function clamp(n,min,max){ return Math.max(min, Math.min(max, n)) }
  function pctToColor(p){
    const pct = clamp(p ?? 0, -5, 5);
    if (isNaN(pct)) return "#cfcfcf";
    if (pct === 0) return "#ffffff";
    const to   = pct>0 ? [0,150,0] : [220,0,0],
          from = [255,255,255],
          t    = Math.abs(pct)/5;
    return "rgb(" +
      [0,1,2].map(i => Math.round(from[i] + (to[i] - from[i]) * t)).join(",") +
      ")";
  }
  function tile(sym,pct,price){
    const d = document.createElement("div"); d.className = "tile";
    d.style.background = pct==null ? "#cfcfcf" : pctToColor(pct);
    const pctTxt = pct==null ? "—" : (pct>0 ? "+" : "") + pct.toFixed(2) + "%";
    let priceTxt;
    if (sym === "SELIC HOJE") priceTxt = price!=null ? price.toFixed(2) + "%" : "—";
    else priceTxt = price!=null
      ? "R$ " + price.toLocaleString("pt-BR",{ minimumFractionDigits:2, maximumFractionDigits:2 })
      : "—";
    d.innerHTML = 
      '<div class="tile-symbol">' + sym + '</div>' +
      '<div class="tile-meta"><span>' + pctTxt + '</span><span>' + priceTxt + '</span></div>';
    return d;
  }
  function render(groups){
    const ids = {
      "GERAL":"grid-geral",
      "Ações Brasileiras":"grid-br",
      "Fundos Imobiliários":"grid-fiis",
      "ETFs Americanos":"grid-us"
    };
    groups.forEach(g=>{
      const grid = document.getElementById(ids[g.name]);
      grid.innerHTML = "";
      g.items.forEach(x=>grid.appendChild(tile(x.symbol,x.changePct,x.price)));
    });
  }
  async function load(){
    try {
      const res = await fetch("/api/heatmap",{ cache:"no-store" });
      const data = await res.json();
      render(data.groups);
      const lu = new Date(data.updatedAt);
      document.getElementById("last-update").textContent =
        "Última atualização: " + lu.toLocaleString("pt-BR");
    } catch(e){
      console.error("Falha ao carregar /api/heatmap", e);
    }
  }
  load();
  setInterval(load, 15000);
</script>
</body></html>`;
  res.type("html").send(html);
});

// inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta " + PORT));