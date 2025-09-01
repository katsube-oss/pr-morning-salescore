// ---------- 環境変数 ----------
const env = (k, d = '') => (process.env[k] ?? d);
const OPENAI_API_KEY = env('OPENAI_API_KEY', '');
const APP_MAX_ITEMS  = parseInt(env('APP_MAX_ITEMS', '10'), 10);
const APP_TZ         = env('APP_TZ', 'Asia/Tokyo');
const APP_KEYWORDS   = env('APP_KEYWORDS', 'SALESCORE').split(',').map(s=>s.trim()).filter(Boolean);
const APP_RSS_URLS   = env('APP_RSS_URLS', '').split('\n').map(s=>s.trim()).filter(Boolean);
const SLACK_WEBHOOK  = env('APP_SLACK_WEBHOOK_URL', '');

const TRUSTED = /(日経|日本経済新聞|ITmedia|東洋経済|ダイヤモンド|Forbes|MarkeZine|SalesZine|PR TIMES)/i;

// ---------- ユーティリティ ----------
function jstNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: APP_TZ }));
}
function jstYesterdayRange() {
  const now = jstNow();
  const start = new Date(now);
  start.setDate(start.getDate() - 1);
  start.setHours(0,0,0,0);
  const end = new Date(start);
  end.setHours(23,59,59,999);
  return { start, end };
}
function isJapanese(s=''){ return /[ぁ-んァ-ン一-龠]/.test(s); }
function normalizeTitle(t=''){ return t.replace(/\s+/g,'').replace(/[【】「」『』（）()［］\[\]<>]/g,'').toLowerCase(); }
function parseDateAny(s){ if(!s) return null; const d=new Date(s); return isNaN(+d)?null:d; }
function fmtJST(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), da=String(d.getDate()).padStart(2,'0'), H=String(d.getHours()).padStart(2,'0'), M=String(d.getMinutes()).padStart(2,'0'); return `${y}/${m}/${da} ${H}:${M}`; }
function mdHeaderDate(){ const {start}=jstYesterdayRange(); const y=start.getFullYear(), m=String(start.getMonth()+1).padStart(2,'0'), d=String(start.getDate()).padStart(2,'0'); return `${y}/${m}/${d}`; }
function truncate(s = '', n = 60) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function detectMedia(hay='') {
  if (/itmedia/i.test(hay)) return 'ITmedia';
  if (/toyokeizai|東洋経済/i.test(hay)) return '東洋経済';
  if (/forbes/i.test(hay)) return 'ForbesJ';
  if (/diamond|ダイヤモンド/i.test(hay)) return 'ダイヤモンド';
  if (/markezine/i.test(hay)) return 'MarkeZine';
  if (/saleszine/i.test(hay)) return 'SalesZine';
  if (/nikkei|日本経済新聞|日経/i.test(hay)) return '日経';
  if (/prtimes/i.test(hay)) return 'PR TIMES';
  return 'News';
}

// ---------- RSS取得（軽量パーサ：RSS/Atomざっくり両対応） ----------
async function fetchRSS(url){
  const res = await fetch(url, { redirect:'follow' });
  const xml = await res.text();
  const items = [];

  // RSS <item>
  const itemBlocks = xml.split(/<item[\s>]/i).slice(1).map(s=>'<item'+s.split('</item>')[0]+'</item>');
  for (const block of itemBlocks) {
    const g = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))||[])[1]||'';
    const title = g('title').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const link  = g('link').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const desc  = g('description').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').trim();
    const pub   = g('pubDate') || g('updated') || g('published');
    const srcT  = g('source') || g('author');
    if (title && link) items.push({ title, link, summary:desc, pubDate:pub, source:srcT });
  }

  // Atom <entry>
  if (items.length === 0) {
    const entryBlocks = xml.split(/<entry[\s>]/i).slice(1).map(s=>'<entry'+s.split('</entry>')[0]+'</entry>');
    for (const block of entryBlocks) {
      const g = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))||[])[1]||'';
      const title = g('title').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
      const link  = (block.match(/<link[^>]+href="([^"]+)"/i)||[])[1] || g('link');
      const summary = (g('summary') || g('content')).replace(/<[^>]+>/g,'').trim();
      const pub   = g('updated') || g('published');
      const author = (block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i)||[])[1]||'';
      if (title && link) items.push({ title, link, summary, pubDate:pub, source:author });
    }
  }

  return items;
}

// ---------- 一言（AI or ルール） ----------
function ruleImpact(title=''){
  if (/価格|料金|値上げ|値下げ/i.test(title)) return '価格交渉・ROI訴求の材料に';
  if (/生成AI|AI|人工知能/i.test(title)) return '入力ハードルと定着の議論に直結';
  if (/SFA|CRM/i.test(title)) return '“入力ハードル”改善の好例として';
  if (/ABM|アカウント|大口|エンタープライズ/i.test(title)) return '面攻略のアカウント設計に活用';
  if (/事例|成功|導入|ケース/i.test(title)) return '会議体×見える化の裏付けに';
  if (/人手不足|採用|離職|働き方/i.test(title)) return '生産性起点の訴求に合致';
  if (/調査|レポート|統計/i.test(title)) return 'データ根拠として引用しやすい';
  return '提案の刺さり所の仮説づくりに';
}
async function impactOneLiner(title, source, snippet){
  if (!OPENAI_API_KEY) return ruleImpact(title);
  try {
    const prompt = `あなたはB2Bエンタープライズ向けセールスイネーブルメント企業のPR担当です。
次のニュースが自社に与えうる影響を、20〜40字の一言で述べてください。
禁止：一般論/煽り/抽象語の羅列。歓迎：示唆・刺さり所・具体性。
自社語辞書：入力ハードル／会議体／定着／可視化／アカウントプラン
タイトル: ${title}
媒体: ${source}
スニペット: ${snippet}
出力：一言のみ。`;
    const r = await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{ 'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json' },
      body: JSON.stringify({ model:'gpt-4o-mini', temperature:0.2, messages:[{role:'user', content: prompt}] })
    });
    const j = await r.json();
    const text = (j?.choices?.[0]?.message?.content || '').trim();
    return (text || ruleImpact(title)).slice(0,40);
  } catch { return ruleImpact(title); }
}

// ---------- 出力（Markdown / Slack） ----------
function toSlackText(items){
  const header = `*【PR朝刊 / 営業DX・AI・Enablement】${mdHeaderDate()}*`;
  const lines = items.map(it=>{
    const when = it.pubDate ? fmtJST(new Date(it.pubDate)) : '';
    const title = truncate(it.title, 60).replace(/\n/g,' ');
    const link = `<${it.link}|${title}>`;
    return `• ${link}（${it.media}） — ${it.impact} _(${when})_`;
  });
  return [header, ...lines].join('\n');
}
function toMarkdown(items){
  const lines = [
    `# PR朝刊（営業DX/AI/Enablement）${mdHeaderDate()}`,
    ...items.map(it=>{
      const when = it.pubDate ? fmtJST(new Date(it.pubDate)) : '';
      return `- ${it.title}（${it.media}） ${it.link} — ${it.impact} _(${when})_`;
    })
  ];
  return lines.join('\n');
}

// ---------- メイン ----------
export default async function handler(req, res){
  try {
    // 1) 収集
    const all = [];
    for (const url of APP_RSS_URLS) {
      try { all.push(...await fetchRSS(url)); } catch {}
    }

    // 2) フィルタ（昨日・日本語・自社KW）
    const { start, end } = jstYesterdayRange();
    const filtered = all.filter(it => {
      const d = parseDateAny(it.pubDate);
      if (!d || d < start || d > end) return false;
      if (!isJapanese(it.title)) return false;
      const hay = `${it.title} ${it.summary||''} ${it.link}`.toLowerCase();
      return APP_KEYWORDS.some(k => hay.includes(k.toLowerCase()));
    });

    // 3) 重複除去
    const seen = new Set(); const uniq = [];
    for (const it of filtered) {
      const key = normalizeTitle(it.title);
      if (!seen.has(key)) { seen.add(key); uniq.push(it); }
    }

    // 4) スコア & 上位抽出
    const ranked = uniq.map(it=>{
      let s=0; const hay=`${it.title} ${it.summary||''} ${it.link}`;
      APP_KEYWORDS.forEach(k=>{ if(hay.toLowerCase().includes(k.toLowerCase())) s+=2; });
      if (TRUSTED.test(hay)) s+=3;
      const d=parseDateAny(it.pubDate); if(d){ const ageH=(jstNow()-d)/36e5; if(ageH<24) s+=1; }
      const len=it.title.length; if(len>=12&&len<=60) s+=1;
      return { ...it, score:s };
    }).sort((a,b)=>b.score-a.score).slice(0, APP_MAX_ITEMS);

    // 5) 一言 & 媒体名
    for (const it of ranked) {
      it.media = detectMedia(`${it.title} ${it.source||''} ${it.link}`);
      it.impact = await impactOneLiner(it.title, it.media, (it.summary||'').slice(0,300));
    }

    // 6) 出力切替
    const useSlack = typeof req?.url === 'string' && req.url.includes('format=slack');
    const body = useSlack ? toSlackText(ranked) : toMarkdown(ranked);

    // （任意）Slack自動送信
    if (!useSlack && SLACK_WEBHOOK && ranked.length){
      const text = toSlackText(ranked);
      try { await fetch(SLACK_WEBHOOK,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) }); } catch {}
    }

    res.setHeader('Content-Type', (useSlack ? 'text/plain' : 'text/markdown') + '; charset=utf-8');
    res.status(200).send(body);
  } catch (e) {
    res.status(500).send('Internal Error');
  }
}
