// 곰곰 사주 후기 서버
// Vercel 환경변수:
//   저장 공간(Upstash Redis): KV_REST_API_URL, KV_REST_API_TOKEN  (Vercel에서 연결하면 자동으로 들어감)
//                            또는 UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   관리자 비밀번호: ADMIN_CODE
// 손님 IP는 저장하지 않음. 도배 방지용으로 IP를 알아볼 수 없게 바꾼 값만 1시간 동안 셈.

const crypto = require('crypto');
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ADMIN = String(process.env.ADMIN_CODE || '');

const KINDS = ['무료 사주', '연애운', '재물운', '직업·적성', '결혼운', '합격운', '궁합', '타로'];
const PER_HOUR = 6;        // 한 접속지에서 1시간에 보낼 수 있는 후기 수
const MAX_TEXT = 100;
const PUB_MAX = 30;        // 손님 화면에 보여줄 최근 공개 후기 수

async function redis(cmds) {
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const j = await r.json();
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const ipKey = req => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return crypto.createHash('sha256').update('gomgom:' + ip + ':' + new Date().toISOString().slice(0, 13)).digest('hex').slice(0, 24);
};
const sameCode = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clean = t => String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const nick = id => {
  const A = ['포근한', '졸린', '배부른', '수줍은', '씩씩한', '느긋한', '반짝이는', '말랑한', '꼬마', '용감한', '예리한'];
  const h = parseInt(crypto.createHash('md5').update(id).digest('hex').slice(0, 8), 16);
  return A[h % A.length] + ' 곰 #' + String(h % 10000).padStart(4, '0');
};
const pubView = r => ({ s: r.s, t: r.t, k: r.k, f: r.f, ev: r.ev, d: r.at, n: nick(r.id) });

module.exports = async (req, res) => {
  if (!URL_ || !TOKEN) return res.status(500).json({ code: 'setup', error: '후기 저장 공간이 아직 연결되지 않았어곰' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { b = {}; } }
  b = b || {};

  try {
    // 1) 손님 화면: 공개된 후기 목록
    if (req.method === 'GET') {
      const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const k = KINDS.includes(q.k) ? q.k : '';
      const off = Math.max(0, Math.min(5000, parseInt(q.off, 10) || 0));
      const n = Math.max(1, Math.min(20, parseInt(q.n, 10) || 10));
      // 풀이별 목록이 없으면(예전에 공개한 후기) 한 번 만들어 둠
      const [mig] = await redis([['GET', 'rv:pubk:v1']]);
      if (!mig) {
        const [all] = await redis([['ZRANGE', 'rv:pub', 0, -1, 'WITHSCORES']]);
        const ids = []; for (let i = 0; i < (all || []).length; i += 2) ids.push([all[i], all[i + 1]]);
        if (ids.length) {
          const [raw] = await redis([['HMGET', 'rv:data', ...ids.map(x => x[0])]]);
          const cmds = [];
          raw.forEach((x, i) => { if (!x) return; const r = JSON.parse(x); if (KINDS.includes(r.k)) cmds.push(['ZADD', 'rv:pub:' + r.k, ids[i][1], ids[i][0]]); });
          if (cmds.length) await redis(cmds);
        }
        await redis([['SET', 'rv:pubk:v1', '1']]);
      }
      const key = k ? 'rv:pub:' + k : 'rv:pub';
      const res1 = await redis([['ZREVRANGE', key, off, off + n - 1], ['HGETALL', 'rv:stat'], ['ZCARD', key], ...KINDS.map(x => ['ZCARD', 'rv:pub:' + x])]);
      const ids = res1[0] || [], sum = res1[1] || [], total = res1[2] || 0;
      const counts = {}; KINDS.forEach((x, i) => { if (res1[3 + i]) counts[x] = res1[3 + i]; });
      const raw = ids.length ? (await redis([['HMGET', 'rv:data', ...ids]]))[0] : [];
      const list = raw.filter(Boolean).map(x => JSON.parse(x)).filter(r => r.st === 'on');
      const st = {}; for (let i = 0; i < sum.length; i += 2) st[sum[i]] = +sum[i + 1];
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({ n: st.n || 0, avg: st.n ? Math.round(st.sum / st.n * 10) / 10 : 0, total, more: off + n < total, counts, list: list.map(pubView) });
    }
    if (req.method !== 'POST') return res.status(405).json({ code: 'method' });

    // 2) 후기 보내기
    if (b.action === 'submit') {
      const s = Math.round(+b.s);
      const k = KINDS.includes(b.k) ? b.k : null;
      if (!(s >= 1 && s <= 5) || !k) return res.status(400).json({ code: 'bad', error: '후기 내용이 이상해곰' });
      const ik = 'rv:ip:' + ipKey(req);
      const [n] = await redis([['INCR', ik], ['EXPIRE', ik, 3600]]);
      if (n > PER_HOUR) return res.status(429).json({ code: 'rate_limited', error: '후기를 너무 많이 보냈어곰. 조금 뒤에 다시 해줘곰' });
      const now = new Date(Date.now() + 9 * 3600 * 1000);
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const r = {
        id, s, k, t: clean(b.t), f: b.f ? 1 : 0,
        ev: k !== '무료 사주' ? 1 : 0,                     // 질문 1개 보상을 받는 후기
        at: now.toISOString().slice(5, 16).replace('-', '.').replace('T', ' '),
        ts: Date.now(), st: 'wait'
      };
      await redis([['HSET', 'rv:data', id, JSON.stringify(r)], ['ZADD', 'rv:all', r.ts, id]]);
      return res.status(200).json({ ok: true });
    }

    // 3) 관리자
    if (['admin', 'set', 'test', 'purge'].includes(b.action)) {
      const ak = 'rv:adm:' + ipKey(req);
      const [tries] = await redis([['GET', ak]]);
      if (+tries >= 10) return res.status(429).json({ code: 'rate_limited', error: '비밀번호를 너무 많이 틀렸어곰. 1시간 뒤에 다시 해줘곰' });
      if (!ADMIN || !sameCode(b.code, ADMIN)) {
        await redis([['INCR', ak], ['EXPIRE', ak, 3600]]);
        return res.status(401).json({ code: 'not_granted', error: '관리자 비밀번호가 맞지 않아곰' });
      }
      // 테스트 후기: 관리자 화면에서만 보이고 손님 화면(공개 목록·평균)에는 절대 안 나감
      if (b.action === 'test') {
        const s = Math.round(+b.s), k = KINDS.includes(b.k) ? b.k : null;
        if (!(s >= 1 && s <= 5) || !k) return res.status(400).json({ code: 'bad', error: '별점과 풀이를 골라 줘곰' });
        const now = new Date(Date.now() + 9 * 3600 * 1000);
        const id = 'test-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        const r = { id, s, k, t: clean(b.t), f: b.f ? 1 : 0, ev: b.ev ? 1 : 0, buy: b.buy ? 1 : 0, test: 1,
          at: now.toISOString().slice(5, 16).replace('-', '.').replace('T', ' '), ts: Date.now(), st: 'test' };
        await redis([['HSET', 'rv:data', id, JSON.stringify(r)], ['ZADD', 'rv:all', r.ts, id]]);
      }
      if (b.action === 'purge') {
        const [ids] = await redis([['ZRANGE', 'rv:all', 0, -1]]);
        const del = (ids || []).filter(x => String(x).startsWith('test-'));
        if (del.length) await redis([['HDEL', 'rv:data', ...del], ['ZREM', 'rv:all', ...del]]);
      }
      if (b.action === 'set') {
        const id = String(b.id || ''), to = b.st;
        if (id.startsWith('test-')) return res.status(400).json({ code: 'bad', error: '테스트 후기는 공개할 수 없어곰' });
        if (!['on', 'off', 'wait'].includes(to)) return res.status(400).json({ code: 'bad' });
        const [raw] = await redis([['HGET', 'rv:data', id]]);
        if (!raw) return res.status(404).json({ code: 'none', error: '그 후기를 못 찾았어곰' });
        const r = JSON.parse(raw), was = r.st;
        r.st = to;
        const cmds = [['HSET', 'rv:data', id, JSON.stringify(r)]];
        if (to === 'on') cmds.push(['ZADD', 'rv:pub', r.ts, id], ['ZADD', 'rv:pub:' + r.k, r.ts, id]); else cmds.push(['ZREM', 'rv:pub', id], ['ZREM', 'rv:pub:' + r.k, id]);
        if (was !== 'on' && to === 'on') cmds.push(['HINCRBY', 'rv:stat', 'n', 1], ['HINCRBY', 'rv:stat', 'sum', r.s]);
        if (was === 'on' && to !== 'on') cmds.push(['HINCRBY', 'rv:stat', 'n', -1], ['HINCRBY', 'rv:stat', 'sum', -r.s]);
        await redis(cmds);
      }
      const [ids] = await redis([['ZREVRANGE', 'rv:all', 0, 499]]);
      const raw = ids && ids.length ? (await redis([['HMGET', 'rv:data', ...ids]]))[0] : [];
      return res.status(200).json({ list: raw.filter(Boolean).map(x => JSON.parse(x)) });
    }
    return res.status(400).json({ code: 'bad' });
  } catch (e) {
    console.error('review fail', String(e && e.message || e).slice(0, 120));
    return res.status(500).json({ code: 'fail', error: '잠깐 문제가 생겼어곰. 다시 해줘곰' });
  }
};
