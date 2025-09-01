// ------------- 設定値の取得 -------------
const env = (k, d = '') => (process.env[k] ?? d);
const OPENAI_API_KEY = env('OPENAI_API_KEY', '');
const APP_MAX_ITEMS  = parseInt(env('APP_MAX_ITEMS', '10'), 10);
const APP_TZ         = env('APP_TZ', 'Asia/Tokyo');
const APP_KEYWORDS   = env('APP_KEYWORDS', 'SALESCORE').split(',').map(s=>s.trim()).filter(Boolean);
const APP_RSS_URLS   = env('APP_RSS_URLS', '').split('\n').map(s=>s.trim()).filter(Boolean);
const SLACK_WEBHOOK  = env('APP_SLACK_WEBHOOK_URL', '');

const TRUSTED = /(日経|日本経済新聞|ITmedia|東洋経済|ダイヤモンド|Forbes|MarkeZine|SalesZine|PR TIMES)/i;

// ------------- ユーティリティ -------------
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
function isJapanese(s='') { return /[ぁ-んァ-ン一-龠]/.test(s); }
function normalizeTitle(t=''){ return t.replace(/\s+/g,'').replace(/[【】「」『』（）()［］\[\]<>]/g,'').toLowerCase(); }
function parseDateAny(s){ if(!s) return null; const d=new Date(s); return isNaN(+d)?null:d; }
function fmtJST(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), da=String(d.getDate()).padStart(2,'0'), H=String(d.getHours()).padStart(2,'0'), M=String(d.getMinutes()).padStart(2,'0'); return `${y}/${m}/${da} ${H}:${M}`; }
function mdHeaderDate(){ const {start}=jstYesterdayRange(); const y=start.getFullYear(), m=String(start.getMonth()+1).padStart(2,'0'), d=String(start.getDate()).padStart(2,'0'); return `${y}/${m}/${d}`; }

// ------------- RSS取得（RSS/Atom簡易対応） -------------
async function fetchRSS(url){
  const res = await fetch(url, { redirect:'follow' });
  const xml = await res.text();

  // 超軽量パース（正規表現ベース・厳密性より簡便さ優先）
  const items = [];

  // RSS(item)
  const itemBlocks = xml.split(/<item[\s>]/i).slice(1).map(s=>'<item'+s.split('</item>')[0]+'</item>');
  for (const block of itemBlocks) {
    const g = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))||[])[1]||'';
    const title = g('title').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const link  = g('link').replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const desc  = g('description').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').trim();
    const pub   = g('pubDate') || g('updated') || g('published');
    if (title && link) items.push({ title, link, summary:desc, pubDate:pub, source:'' });
  }

  // Atom(entry)（簡易）
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

// ------------- 一言生成 -------------
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
  } catch(e){ return ruleImpact(title); }
}

// ------------- メイン処理 -------------
export default async function handler(req, res){
  try{
    // 1) RSSを全部取得
    const all = [];
    for (const url of APP_RSS_URLS) {
      try { all.push(...await fetchRSS(url)); } catch {}
    }

    // 2) フィルタ（昨日・日本語・自社キーワード）
    const { start, end } = jstYesterdayRange();
    const filtered = all.filter(it => {
      const d = parseDateAny(it.pubDate);
      if (!d || d < start || d > end) return false;              // 昨日だけ
      if (!isJapanese(it.title)) return false;                    // 日本語タイトル
      const hay = `${it.title} ${it.summary||''} ${it.link}`.toLowerCase();
      return APP_KEYWORDS.some(k => hay.includes(k.toLowerCase())); // 自社KW
    });

    // 3) 重複除去
    const seen = new Set(); const uniq = [];
    for (const it of filtered) {
      const key = normalizeTitle(it.title);
      if (!seen.has(key)) { seen.add(key); uniq.push(it); }
    }

    // 4) スコアリング＆上位抽出
    const scored = uniq.map(it => {
      let s = 0;
      const hay = `${it.title} ${it.summary||''} ${it.link}`;
      APP_KEYWORDS.forEach(k => { if (hay.toLowerCase().includes(k.toLowerCase())) s += 2; });
      if (TRUSTED.test(hay)) s += 3;
      const d = parseDateAny(it.pubDate);
      if (d) { const ageH = (jstNow()-d)/36e5; if (ageH<24) s+=1; }
      const len = it.title.length; if (len>=12 && len<=60) s+=1;
      return { ...it, score: s };
    }).sort((a,b)=>b.score-a.score).slice(0, APP_MAX_ITEMS);

    // 5) 一言生成
    for (const it of scored) {
      const src = /itmedia/i.test(it.link) ? 'ITmedia'
              : /toyokeizai|東洋経済/i.test(it.link) ? '東洋経済'
              : /forbes/i.test(it.link) ? 'ForbesJ'
              : /diamond|ダイヤモンド/i.test(it.link) ? 'ダイヤモンド'
              : /markezine/i.test(it.link) ? 'MarkeZine'
              : /saleszine/i.test(it.link) ? 'SalesZine'
              : /nikkei|日本経済新聞|日経/i.test(it.link) ? '日経'
              : /prtimes/i.test(it.link) ? 'PR TIMES' : 'News';
      it.impact = await impactOneLiner(it.title, src, (it.summary||'').slice(0,300));
      it.media = src;
    }

    // 6) Markdownに整形
    const lines = [
      `# PR朝刊（営業DX/AI/Enablement）${mdHeaderDate()}`,
      ...scored.map(it=>{
        const when = it.pubDate ? fmtJST(new Date(it.pubDate)) : '';
        return `- ${it.title}（${it.media}） ${it.link} — ${it.impact} _(${when})_`;
      })
    ];
    const md = lines.join('\n');

    // （任意）Slack Webhook
    if (SLACK_WEBHOOK && scored.length) {
      const text = ['【PR朝刊】'+mdHeaderDate(), ...scored.map(it=>`• ${it.title}（${it.media}） ${it.link} — ${it.impact}`)].join('\n');
      try {
        await fetch(SLACK_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
      } catch {}
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.status(200).send(md);
  } catch(e){
    res.status(500).send('Internal Error');
  }
}
