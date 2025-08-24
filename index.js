// index.js
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

const ALL = [...GERAL, ...BR_STOCKS, ...BR_FIIS, ...US_ETFS];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// cache em memória
const cache = new Map();
ALL.forEach(sym => cache.set(sym, { changePct: null, price: null, ts: 0 }));

// parse "1.234,56" → 1234.56
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

// scrape Google Finance genérico
async function scrapeGoogle(sym, suffix = '') {
  try {
    const url = `https://www.google.com/finance/quote/${encodeURIComponent(sym)}${suffix}?hl=pt-BR`;
    const res = await fetchFn(url, {
      headers: { 'User-Agent':'Mozilla/5.0', 'Accept-Language':'pt-BR' }
    });
    if (!res.ok) return null;
    const $ = cheerio.load(await res.text());
    const txt = $('div.YMlKec.fxKbKc').first().text().trim();
    return parseLocaleNumber(txt);
  } catch {
    return null;
  }
}

// suffix para ações/ETFs
function marketSuffix(sym) {
  return US_ETFS.includes(sym) ? ':NYSEARCA' : ':BVMF';
}

// fetch fechamento anterior via brapi.dev
async function fetchPrevClose(sym) {
  try {
    const url = new URL(`https://brapi.dev/api/quote/${encodeURIComponent(sym)}`);
    url.searchParams.set('token', BRAPI_TOKEN);
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const js = await res.json();
    return Number(js.results?.[0]?.regularMarketPreviousClose) || null;
  } catch {
    return null;
  }
}

// fetch SELIC no BCB (série 432)
async function fetchSelic() {
  try {
    const res = await fetchFn(
      'https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json'
    );
    const j = await res.json();
    return Number(j?.[0]?.valor) || null;
  } catch {
    return null;
  }
}

// atualiza cache de um símbolo
async function updateSymbol(sym) {
  if (GERAL.includes(sym)) {
    if (sym === 'SELIC HOJE') {
      const s = await fetchSelic();
      cache.set(sym, { changePct: null, price: s, ts: Date.now() });
    } else {
      const entry = cache.get(sym);
      if (Date.now() - entry.ts < 10*60*1000) return;
      const pair = sym === 'DOLAR' ? 'USD-BRL' : 'BTC-BRL';
      const price = await scrapeGoogle(pair);
      let pct = null;
      if (price != null && Number.isFinite(entry.price)) {
        pct = clamp((price - entry.price)/entry.price*100, -50, 50);
      }
      cache.set(sym, { changePct: pct, price, ts: Date.now() });
    }
    return;
  }
  const price = await scrapeGoogle(sym, marketSuffix(sym));
  const prev  = await fetchPrevClose(sym);
  let pct = null;
  if (price != null && prev != null && prev !== 0) {
    pct = clamp((price - prev)/prev*100, -50, 50);
  }
  cache.set(sym, {
    changePct: pct,
    price: price != null ? price : cache.get(sym).price,
    ts: Date.now()
  });
}

// ciclo de atualização
async function updateAll() {
  for (const sym of ALL) {
    await updateSymbol(sym);
    await new Promise(r => setTimeout(r, 400));
  }
}
updateAll();
setInterval(updateAll, 3*60*1000);

// API que retorna os grupos ordenados
app.get('/api/heatmap', (req, res) => {
  const make = arr => arr
    .map(sym => ({
      symbol: sym,
      changePct: cache.get(sym).changePct,
      price: cache.get(sym).price
    }))
    .sort((a,b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));

  res.json({
    updatedAt: new Date().toISOString(),
    groups: [
      { name:'GERAL',             items: make(GERAL)    },
      { name:'Ações Brasileiras', items: make(BR_STOCKS)},
      { name:'Fundos Imobiliários', items: make(BR_FIIS)},
      { name:'ETFs Americanos',   items: make(US_ETFS)  }
    ]
  });
});

// rota principal com blink on update
app.get('/', (req, res) => {
  let html = '<!doctype html>';
  html += '<html lang="pt-BR"><head>';
  html += '<meta charset="utf-8">';
  html += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<title>Heatmap Pro</title>';
  html += '<style>';
  html += 'body{margin:0;background:#0b0f14;color:#fff;font-family:sans-serif;}';
  html += '.screen-wrapper{max-width:1200px;margin:0 auto;padding:10px;}';
  html += '.screen{display:grid;grid-template-rows:1fr 1fr;gap:12px;}';
  html += '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));';
  html += 'grid-auto-rows:90px;gap:8px;padding:30px 10px 10px;}';
  html += '#grid-br{grid-template-columns:repeat(6,minmax(100px,1fr));}';
  html += '.group{position:relative;border-radius:8px;background:rgba(255,255,255,0.05);}';
  html += '.group-label{font-size:14px;padding:8px 12px;background:rgba(255,255,255,0.08);';
  html += 'color:#c8d1da;cursor:pointer;}';
  html += '.tile{border-radius:12px;display:flex;flex-direction:column;';
  html += 'justify-content:space-between;background:#cfcfcf;color:#000;';
  html += 'padding:10px;box-shadow:inset 0 0 6px rgba(0,0,0,0.15);transition:background .3s;}';
  html += '.tile-symbol{font-size:16px;font-weight:700;}';
  html += '.tile-meta{display:flex;justify-content:space-between;';
  html += 'font-size:12px;font-weight:600;}';
  // blink animation
  html += '@keyframes blink {0%{transform:scale(1.05);background:#fffc80;}50%{transform:scale(1);}}';
  html += '.blink{animation:blink 0.8s ease-out;}';
  html += '.last-update{position:fixed;bottom:0;left:0;right:0;';
  html += 'background:rgba(0,0,0,0.7);text-align:center;padding:5px 0;';
  html += 'font-size:12px;color:#c8d1da;}';
  html += '</style></head><body>';
  html += '<div class="screen-wrapper"><div class="screen">';
  ['GERAL','Ações Brasileiras','Fundos Imobiliários','ETFs Americanos']
    .forEach(name => {
      const id = name==='Ações Brasileiras'?'grid-br'
                : name==='GERAL'?'grid-geral'
                : name==='Fundos Imobiliários'?'grid-fiis'
                :'grid-us';
      html += '<section class="group">';
      html += '<div class="group-label">'+name+'</div>';
      html += '<div class="grid" id="'+id+'"></div>';
      html += '</section>';
    });
  html += '</div></div>';
  html += '<div class="last-update" id="last-update"></div>';
  html += '<script>';
  html += 'const prevMap=new Map();';
  html += 'function clamp(n,min,max){return Math.max(min,Math.min(max,n));}';
  html += 'function pctToColor(p){var pct=clamp(p||0,-3,3);';
  html += 'if(isNaN(pct))return"#cfcfcf";if(pct===0)return"#fff";';
  html += 'var to=pct>0?[0,150,0]:[220,0,0],from=[255,255,255],t=Math.abs(pct)/3;';
  html += 'return"rgb("+[0,1,2].map(i=>Math.round(from[i]+(to[i]-from[i])*t)).join(",")+")";}';
  html += 'function createTile(sym,pct,price,updated){';
  html += 'var d=document.createElement("div");d.className="tile";';
  html += 'if(updated)d.classList.add("blink");';
  html += 'd.style.background=pct==null?"#cfcfcf":pctToColor(pct);';
  html += 'var pctTxt=pct==null?"—":(pct>0?"+":"")+pct.toFixed(2)+"%";';
  html += 'var priceTxt=sym==="SELIC HOJE"?';
  html += '(price!=null?price.toFixed(2)+"%":"—")';
  html += ':(price!=null?"R$ "+price.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}):"—");';
  html += 'd.innerHTML="<div class=\'tile-symbol\'>"+sym+"</div>";';
  html += 'd.innerHTML+= "<div class=\'tile-meta\'><span>"+pctTxt+"</span><span>"+priceTxt+"</span></div>";';
  html += 'd.setAttribute("data-tooltip",sym+" | "+pctTxt+" | "+priceTxt);';
  html += 'return d;}';
  html += 'function render(groups){';
  html += 'var ids={"GERAL":"grid-geral","Ações Brasileiras":"grid-br",';
  html += '"Fundos Imobiliários":"grid-fiis","ETFs Americanos":"grid-us"};';
  html += 'groups.forEach(function(g){';
  html += 'var grid=document.getElementById(ids[g.name]);';
  html += 'grid.innerHTML="";';
  html += 'g.items.forEach(function(item){';
  html += 'var prev=prevMap.get(item.symbol);';
  html += 'var updated=prev && (prev.changePct!==item.changePct||prev.price!==item.price);';
  html += 'prevMap.set(item.symbol,{changePct:item.changePct,price:item.price});';
  html += 'grid.appendChild(createTile(item.symbol,item.changePct,item.price,updated));';
  html += '});});}';
  html += 'async function load(){try{';
  html += 'var res=await fetch("/api/heatmap",{cache:"no-store"});';
  html += 'var data=await res.json();render(data.groups);';
  html += 'document.getElementById("last-update").textContent='+
               '"Última atualização: "+new Date(data.updatedAt).toLocaleString("pt-BR");';
  html += '}catch(e){console.error(e);} }';
  html += 'document.querySelectorAll(".group-label").forEach(function(lbl){';
  html += 'lbl.addEventListener("click",function(){var g=lbl.nextElementSibling;';
  html += 'g.style.display=g.style.display==="none"?"":"none";});});';
  html += 'load();setInterval(load,15000);';
  html += '</script></body></html>';
  res.type("html").send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Rodando na porta " + PORT));
