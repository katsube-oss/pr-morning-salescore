// ===============================
// PR朝刊 API（Slack/Markdown/JSON 両対応）
// - /api/run                -> Markdown
// - /api/run?format=slack  -> Slack用（タイトルリンクのみ）
// - /api/run?format=json   -> JSON（UIページ用）
// ===============================

const env = (k, d = '') => (process.env[k] ?? d);
const OPENAI_API_KEY = env('OPENAI_API_KEY', '');
const APP_MAX_ITEMS  = parseInt(env('APP_MAX_ITEMS', '10'), 10);
const APP_TZ         = env('APP_TZ', 'Asia/Tokyo');
const APP_KEYWORDS   = env('APP_KEYWORDS', 'SALESCORE').split(',').map(s=>s.trim()).filter(Boolean);
const APP_RSS_URLS   = env('APP_RSS_URLS', '').split('\n').map(s=>s.trim()).filter(Boolean);

const TRUSTED = /(日経|日本経済新聞|ITmedia|東洋経済|ダイヤモンド|Forbes|MarkeZine|SalesZine|PR TIMES)/i;

// ---- Utils ----
function jstNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: APP_TZ })); }
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
function escapeSlack(s = '') { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\|/g,'／'); }

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

// ---- RSS取得 ----
async function fetchRSS(url){
  const res = await fetch(url, { redirect:'follow' });
  const xml = await res.text();
  const items = [];

  const itemBlocks = xml.split(/<item[\s>]/i).slice(1).map(s=>'<item'+s.split('</item>')[0]+'</item>');
  for (const block of itemBlocks) {
    const g = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))||[])[1]||'';
    const title = g('title')?.replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const link  = g('link')?.replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const desc  = g('description')?.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').trim();
    const pub   = g('pubDate') || g('updated') || g('published');
    const srcT  = g('source') || g('author');
    if (title && link) items.push({ title, link, summary:desc, pubDate:pub, source:srcT });
  }
  return items;
}

// ---- 一言（ルールベースのみ使用。OpenAIは今回はスキップ）----
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

// ---- 出力 ----
function toSlackText(items){
  const header = `📰 *【PR朝刊】${mdHeaderDate()}*`;
  const lines = items.map(it => {
    const when  = it.pubDate ? fmtJST(new Date(it.pubDate)) : '';
    const title = escapeSlack(it.title).replace(/\n/g,' ');
    const media = escapeSlack(it.media || 'News');
    const link  = `<${it.link}|${title}>`; 
    return `• ${link}（${media}）\n↳ ${escapeSlack(it.impact || '')} _(${when})_`;
  });
  return [header, ...lines].join('\n');
}
function toMarkdown(items){
  const lines = [
    `# PR朝刊 ${mdHeaderDate()}`,
    ...items.map(it=>{
      const when = it.pubDate ? fmtJST(new Date(it.pubDate)) : '';
      return `- ${it.title}（${it.media}） ${it.link} — ${it.impact} _(${when})_`;
    })
  ];
  return lines.join('\n');
}
function toJSON(items){
  return items.map(it => ({
    title: it.title,
    link: it.link,
    media: it.media,
    impact: it.impact,
    pubDate: it.pubDate
  }));
}

// ---- メイン ----
export default async function handler(req, res){
  try {
    const all = [];
    for (const url of APP_RSS_URLS) {
      try { all.push(...await fetchRSS(url)); } catch {}
    }

    const { start, end } = jstYesterdayRange();
    const filtered = all.filter(it => {
      const d = parseDateAny(it.pubDate);
      if (!d || d < start || d > end) return false;
      if (!isJapanese(it.title)) return false;
      const hay = `${it.title} ${it.summary||''} ${it.link}`.toLowerCase();
      return APP_KEYWORDS.some(k => hay.includes(k.toLowerCase()));
    });

    const seen = new Set(); const uniq = [];
    for (const it of filtered) {
      const key = normalizeTitle(it.title);
      if (!seen.has(key)) { seen.add(key); uniq.push(it); }
    }

    const ranked = uniq.map(it=>{
      let s=0; const hay=`${it.title} ${it.summary||''} ${it.link}`;
      APP_KEYWORDS.forEach(k=>{ if(hay.includes(k.toLowerCase())) s+=2; });
      if (TRUSTED.test(hay)) s+=3;
      return { ...it, score:s };
    }).sort((a,b)=>b.score-a.score).slice(0, APP_MAX_ITEMS);

    for (const it of ranked) {
      it.media = detectMedia(`${it.title} ${it.source||''} ${it.link}`);
      it.impact = ruleImpact(it.title);
    }

    const useSlack = req?.url?.includes('format=slack');
    const useJson  = req?.url?.includes('format=json');
    let body;
    if (useSlack) body = toSlackText(ranked);
    else if (useJson) body = JSON.stringify(toJSON(ranked));
    else body = toMarkdown(ranked);

    res.setHeader('Content-Type', useJson ? 'application/json' : 'text/plain; charset=utf-8');
    res.status(200).send(body);
  } catch (e) {
    res.status(500).send('Internal Error');
  }
}
