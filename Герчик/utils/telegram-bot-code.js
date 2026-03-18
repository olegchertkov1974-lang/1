const msg = $input.first().json;
const text = (msg.message?.text || '').trim();
const chatId = msg.message?.chat?.id?.toString() || '';
const ALLOWED_CHAT = '543663073';
if (chatId !== ALLOWED_CHAT) {
  return [{ json: { message: '⛔ Unauthorized' } }];
}
const parts = text.split(/\s+/);
const command = parts[0].toLowerCase();
const args = parts.slice(1);
const apiKey = 'YOUR_BYBIT_API_KEY';
const apiSecret = 'YOUR_BYBIT_API_SECRET';
const baseUrl = 'https://api.bybit.com';
// === Pure JS SHA-256 + HMAC (no crypto module) ===
function sha256(bytes) {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a;
  let h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const m = bytes.slice();
  const bitLen = m.length * 8;
  m.push(0x80);
  while ((m.length + 8) % 64 !== 0) m.push(0);
  m.push(0,0,0,0,(bitLen>>>24)&0xff,(bitLen>>>16)&0xff,(bitLen>>>8)&0xff,bitLen&0xff);
  function rr(v,n){return((v>>>n)|(v<<(32-n)))>>>0;}
  for (let i=0;i<m.length;i+=64){
    const w=new Array(64);
    for(let j=0;j<16;j++) w[j]=((m[i+j*4]<<24)|(m[i+j*4+1]<<16)|(m[i+j*4+2]<<8)|m[i+j*4+3])>>>0;
    for(let j=16;j<64;j++){
      const s0=rr(w[j-15],7)^rr(w[j-15],18)^(w[j-15]>>>3);
      const s1=rr(w[j-2],17)^rr(w[j-2],19)^(w[j-2]>>>10);
      w[j]=(w[j-16]+s0+w[j-7]+s1)>>>0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for(let j=0;j<64;j++){
      const S1=rr(e,6)^rr(e,11)^rr(e,25);
      const ch=(e&f)^((~e>>>0)&g);
      const t1=(h+S1+ch+K[j]+w[j])>>>0;
      const S0=rr(a,2)^rr(a,13)^rr(a,22);
      const maj=(a&b)^(a&c)^(b&c);
      const t2=(S0+maj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;
    h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+h)>>>0;
  }
  const r=[];
  [h0,h1,h2,h3,h4,h5,h6,h7].forEach(v=>{r.push((v>>>24)&0xff,(v>>>16)&0xff,(v>>>8)&0xff,v&0xff);});
  return r;
}
function hmacSHA256(keyStr, msgStr) {
  const toB=s=>Array.from(s).map(c=>c.charCodeAt(0));
  let k=toB(keyStr);
  if(k.length>64)k=sha256(k);
  while(k.length<64)k.push(0);
  const inner=sha256([...k.map(b=>b^0x36),...toB(msgStr)]);
  const hmac=sha256([...k.map(b=>b^0x5c),...inner]);
  return hmac.map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function signedGet(endpoint, params) {
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const qs = Object.entries(params).map(([k,v])=>`${k}=${v}`).join('&');
  const signature = hmacSHA256(apiSecret, timestamp + apiKey + recvWindow + qs);
  return await this.helpers.httpRequest({
    method:'GET',
    url:`${baseUrl}${endpoint}?${qs}`,
    headers:{
      'X-BAPI-API-KEY':apiKey,'X-BAPI-SIGN':signature,
      'X-BAPI-TIMESTAMP':timestamp,'X-BAPI-RECV-WINDOW':recvWindow
    }
  });
}

// === Model list ===
const models = [
  { num: 1, id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', desc: 'Anthropic — быстрый и умный' },
  { num: 2, id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus 4', desc: 'Anthropic — самый мощный' },
  { num: 3, id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', desc: 'DeepSeek — быстрый, дешёвый' },
  { num: 4, id: 'deepseek/deepseek-reasoner', name: 'DeepSeek R1', desc: 'DeepSeek — с рассуждением' },
  { num: 5, id: 'openai/gpt-4o', name: 'GPT-4o', desc: 'OpenAI — мультимодальный' },
  { num: 6, id: 'openai/o3-mini', name: 'o3-mini', desc: 'OpenAI — быстрый reasoning' },
  { num: 7, id: 'google/gemini-2.5-pro-preview-03-25', name: 'Gemini 2.5 Pro', desc: 'Google — большой контекст' },
  { num: 8, id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash', desc: 'Google — быстрый и дешёвый' },
  { num: 9, id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', desc: 'Meta — открытая модель' },
  { num: 10, id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', desc: 'Alibaba — мощная открытая' }
];

const store = $getWorkflowStaticData('global');
if (!store.OPENROUTER_MODEL) store.OPENROUTER_MODEL = 'anthropic/claude-sonnet-4-20250514';

let message = '';
if (command === '/balance') {
  try {
    const resp = await signedGet.call(this,'/v5/account/wallet-balance',{accountType:'UNIFIED'});
    if (resp.retCode===0 && resp.result?.list?.length>0) {
      const w=resp.result.list[0];
      const equity=parseFloat(w.totalEquity||0);
      const available=parseFloat(w.totalAvailableBalance||0);
      const walletBal=parseFloat(w.totalWalletBalance||0);
      message=`💰 <b>Баланс</b>\n\n`;
      message+=`<b>Эквити:</b> <code>$${equity.toFixed(2)}</code>\n`;
      message+=`<b>Баланс:</b> <code>$${walletBal.toFixed(2)}</code>\n`;
      message+=`<b>Доступно:</b> <code>$${available.toFixed(2)}</code>\n`;
      const coins=(w.coin||[]).filter(c=>parseFloat(c.walletBalance)>0.001);
      if(coins.length>0){
        message+=`\n<b>Активы:</b>\n`;
        for(const c of coins){
          const bal=parseFloat(c.walletBalance);
          const usd=parseFloat(c.usdValue||0);
          message+=`  • <b>${c.coin}</b>: <code>${bal.toFixed(4)}</code>`;
          if(usd>0.01)message+=` (~$${usd.toFixed(2)})`;
          message+=`\n`;
        }
      }
    } else { message=`❌ ${resp.retMsg}`; }
  } catch(e) { message=`❌ ${e.message}`; }
}
else if (command === '/status') {
  try {
    const balResp=await signedGet.call(this,'/v5/account/wallet-balance',{accountType:'UNIFIED'});
    let equity=0,available=0;
    if(balResp.retCode===0){equity=parseFloat(balResp.result.list[0].totalEquity);available=parseFloat(balResp.result.list[0].totalAvailableBalance);}
    let positions=[];
    try{const posResp=await signedGet.call(this,'/v5/position/list',{category:'linear',settleCoin:'USDT'});
    if(posResp.retCode===0)positions=(posResp.result?.list||[]).filter(p=>parseFloat(p.size)>0);}catch(e){}
    message=`📊 <b>Статус</b> MAINNET\n\n<b>Эквити:</b> <code>$${equity.toFixed(2)}</code>\n<b>Доступно:</b> <code>$${available.toFixed(2)}</code>\n\n`;
    if(positions.length>0){message+=`<b>Позиции (${positions.length}):</b>\n`;for(const p of positions){const pnl=parseFloat(p.unrealisedPnl);message+=`${pnl>=0?'🟢':'🔴'} <b>${p.symbol}</b> ${p.side} P&L: <code>$${pnl.toFixed(2)}</code>\n`;}}
    else{message+='<i>Нет открытых позиций</i>';}
  } catch(e){message=`❌ ${e.message}`;}
}
else if (command === '/pairs') {
  try {
    const resp=await this.helpers.httpRequest({method:'GET',url:`${baseUrl}/v5/market/tickers?category=spot`});
    const pairs=resp.result.list.filter(t=>t.symbol.endsWith('USDT')).map(t=>({symbol:t.symbol,price:parseFloat(t.lastPrice),volume:parseFloat(t.turnover24h),change:parseFloat(t.price24hPcnt)*100})).filter(t=>t.volume>=50000000).sort((a,b)=>b.volume-a.volume).slice(0,20);
    message=`📋 <b>Топ-${pairs.length} пар</b>\n\n`;
    pairs.forEach((p,i)=>{message+=`<b>${i+1}.</b> ${p.symbol} <code>${p.price}</code> ${p.change>=0?'🟢':'🔴'} ${p.change.toFixed(1)}% $${(p.volume/1e6).toFixed(0)}M\n`;});
  } catch(e){message=`❌ ${e.message}`;}
}
else if (command === '/model') {
  const currentModel = store.OPENROUTER_MODEL;
  if (args.length === 0) {
    const current = models.find(m => m.id === currentModel);
    const currentName = current ? current.name : currentModel;
    message = `🤖 <b>AI Модель</b>\n\n`;
    message += `<b>Текущая:</b> ${currentName}\n`;
    message += `<code>${currentModel}</code>\n\n`;
    message += `<b>Доступные модели:</b>\n\n`;
    for (const m of models) {
      const active = m.id === currentModel ? ' ✅' : '';
      message += `<b>${m.num}.</b> ${m.name}${active}\n   <i>${m.desc}</i>\n\n`;
    }
    message += `<b>Использование:</b>\n<code>/model 3</code> — выбрать по номеру`;
  } else {
    const input = args[0];
    const num = parseInt(input);
    let selected = null;
    if (!isNaN(num) && num >= 1 && num <= models.length) {
      selected = models[num - 1];
    } else {
      selected = models.find(m => m.id === input || m.id.includes(input));
    }
    if (selected) {
      store.OPENROUTER_MODEL = selected.id;
      message = `✅ <b>Модель изменена</b>\n\n<b>Новая:</b> ${selected.name}\n<code>${selected.id}</code>\n<i>${selected.desc}</i>`;
    } else {
      store.OPENROUTER_MODEL = input;
      message = `✅ <b>Модель изменена</b>\n\n<code>${input}</code>\n<i>Кастомная модель — убедитесь что она доступна на OpenRouter</i>`;
    }
  }
}
else if (command==='/help'){message='🤖 <b>Gerchik Bot</b>\n\n/balance — баланс\n/status — позиции\n/pairs — топ пары\n/model — список AI моделей\n/model 3 — сменить модель\n/stop — стоп\n/start — старт\n/help — справка';}
else if (command==='/stop'){message='⛔ <b>Бот остановлен</b>';}
else if (command==='/start'){message='🟢 <b>Бот запущен</b>';}
else{message='❓ Неизвестная команда. /help';}
message+=`\n\n⏱ ${new Date().toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}`;
return [{json:{message}}];
