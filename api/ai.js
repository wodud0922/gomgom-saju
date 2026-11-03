// 곰 상담소 AI 서버 (지인 테스트용)
// Vercel 환경변수: ANTHROPIC_API_KEY, TESTER_CODES (쉼표로 여러 개 가능)
// 기본은 Sonnet 5.5 (빠르고 Opus의 절반 가격). 더 깊은 글이 필요하면 Vercel 환경변수 CLAUDE_MODEL에 claude-opus-5-5
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const LIMIT_ON = false;
const LIMIT = { report: 18, ask: 30 }; // 하루: 보고서 6개(보고서 1개 = 3번 호출), 질문 30개
const MAX_PROMPT = 16000;               // 글자 수
const hits = new Map();                 // 간단한 하루 횟수 기록 (서버가 재시작되면 초기화됨)

function today() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
function count(key) {
  const k = today() + ':' + key;
  if (hits.size > 5000) hits.clear();
  const n = (hits.get(k) || 0) + 1; hits.set(k, n); return n;
}
function parseJSON(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no json');
  return JSON.parse(text.slice(a, b + 1));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ code: 'method', error: 'POST만 받아곰' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ code: 'setup', error: '서버 설정이 아직 덜 됐어곰' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { b = {}; } }
  b = b || {};

  const codes = String(process.env.TESTER_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
  const code = String(b.code || '').trim();
  if (!codes.length || !codes.includes(code)) return res.status(401).json({ code: 'not_granted', error: '테스터 코드가 맞지 않아곰' });

  const kind = b.kind === 'ask' ? 'ask' : 'report';
  const prompt = String(b.prompt || '');
  if (prompt.length < 20 || prompt.length > MAX_PROMPT) return res.status(400).json({ code: 'bad', error: '요청이 이상해곰' });

  // 하루 횟수 제한 없음 (지인 테스트). 다시 걸려면 LIMIT_ON을 true로
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (LIMIT_ON && count(kind + ':' + ip + ':' + code) > LIMIT[kind])
    return res.status(429).json({ code: 'rate_limited', error: '오늘 쓸 수 있는 만큼 다 썼어곰. 내일 다시 와줘곰' });

  // 재시도 없음: 실패해도 같은 글을 두 번 쓰지 않게 (비용 절약)
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 280000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: kind === 'ask' ? 1200 : 4500, messages: [{ role: 'user', content: prompt }] }),
    });
    clearTimeout(timer);
    if (r.status === 429 || r.status === 529) return res.status(429).json({ code: 'rate_limited', error: '곰이 잠깐 쉬는 중이야곰. 1분 뒤에 다시 해보자곰' });
    if (r.status === 401) return res.status(500).json({ code: 'setup', error: '서버의 API 키가 맞지 않아곰 (관리자 확인 필요)' });
    if (r.status === 400) { const t = await r.text(); console.error('anthropic 400', t.slice(0, 300)); return res.status(500).json({ code: 'setup', error: /credit/i.test(t) ? '콘솔 크레딧이 부족해곰 (관리자 충전 필요)' : '곰에게 보낸 요청이 이상해곰' }); }
    if (!r.ok) { console.error('anthropic', r.status, (await r.text()).slice(0, 300)); return res.status(502).json({ code: 'fail', error: '곰이 글을 가져오지 못했어곰. 다시 해보자곰' }); }
    const j = await r.json();
    const text = (j.content || []).map(c => c.text || '').join('');
    try { return res.status(200).json({ ok: true, data: parseJSON(text) }); }
    catch (e) { console.error('json fail', j.stop_reason, text.slice(-200)); return res.status(502).json({ code: 'fail', error: '곰의 글이 중간에 끊겼어곰. 다시 해보자곰' }); }
  } catch (e) { console.error('ai fail', e.message); }
  return res.status(502).json({ code: 'fail', error: '곰이 글을 가져오지 못했어곰' });
};
