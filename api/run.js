export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  const today = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[0];
  res.status(200).send(`# PR朝刊（疎通テスト）${today}\n- ここにニュースが並びます`);
}
