// 곰코인 무료 체험 공통 기능 (밑줄로 시작하는 파일은 Vercel이 주소로 열지 않음)
// Vercel 환경변수(선택): CN_END(마감일, 기본 2026-11-15), CN_POOL(전체 예산 코인, 기본 420), CN_DAILY_WON(하루 사용 한도 원, 기본 7000)
//   CN_DAY_MIN / CN_DAY_MAX: 매일 자정(한국 시간)에 새로 풀리는 '오늘의 곰코인' 개수 범위 (기본 10~18 안의 3의 배수 = 12·15·18 중 하나, 그날 처음 접속할 때 랜덤으로 정해짐)
const crypto = require('crypto');
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const CFG = {
  end: process.env.CN_END || '2026-11-15',
  pool: parseInt(process.env.CN_POOL, 10) || 420,
  dailyWon: parseInt(process.env.CN_DAILY_WON, 10) || 7000,
  dayMin: parseInt(process.env.CN_DAY_MIN, 10) || 10,
  dayMax: parseInt(process.env.CN_DAY_MAX, 10) || 18,
  earn: 3, refEarn: 2, refMax: 5, minText: 20, ipPerDay: 5,
  cost: { report: 3, tarot: 3, ask: 1 },
  won: { report: 200, tarot: 40, ask: 25 },      // 대략 원가 (하루 한도 계산용)
  calls: { report: 25, tarot: 6, ask: 6 },        // 티켓 하나로 곰을 부를 수 있는 횟수 (재시도 포함)
};
const ready = () => !!(URL_ && TOKEN);
const kst = () => new Date(Date.now() + 9 * 3600 * 1000);
const today = () => kst().toISOString().slice(0, 10);
const isOn = () => ready() && today() <= CFG.end;
const ttl = () => Math.max(86400, Math.round((new Date(CFG.end + 'T23:59:59+09:00').getTime() - Date.now()) / 1000) + 30 * 86400); // 마감 30일 뒤 자동 삭제

async function redis(cmds) {
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const j = await r.json();
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const ipHash = req => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return crypto.createHash('sha256').update('gomcoin:' + ip + ':' + today()).digest('hex').slice(0, 24);
};
const okId = w => typeof w === 'string' && /^[a-f0-9]{24}$/.test(w);
const hmap = a => { const o = {}; for (let i = 0; i < (a || []).length; i += 2) o[a[i]] = a[i + 1]; return o; };

async function wallet(w) {
  if (!okId(w)) return null;
  const [h] = await redis([['HGETALL', 'cn:w:' + w]]);
  const o = hmap(h); if (!o.code) return null;
  return { w, bal: +o.bal || 0, claimed: o.claimed === '1', refs: +o.refs || 0, code: o.code };
}
async function newWallet() {
  const w = crypto.randomBytes(12).toString('hex');
  let code = '';
  for (let i = 0; i < 5; i++) {
    const c = 'G' + crypto.randomBytes(4).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5);
    if (c.length < 6) continue;
    const [ok] = await redis([['SET', 'cn:code:' + c, w, 'NX', 'EX', ttl()]]);
    if (ok) { code = c; break; }
  }
  if (!code) throw new Error('code');
  await redis([['HSET', 'cn:w:' + w, 'bal', 0, 'claimed', 0, 'refs', 0, 'code', code], ['EXPIRE', 'cn:w:' + w, ttl()], ['HINCRBY', 'cn:stat', 'wallets', 1]]);
  return { w, bal: 0, claimed: false, refs: 0, code };
}
// 오늘의 곰코인: 그날 처음 부를 때 dayMin~dayMax 사이 랜덤으로 한 번만 정함 (진짜 한도)
async function dayQuota() {
  const k = 'cn:dq:' + today();
  const step = CFG.earn, lo = Math.ceil(CFG.dayMin / step), hi = Math.max(lo, Math.floor(CFG.dayMax / step)); // 후기 1명 = 3코인이라 3의 배수로 (10~18 → 12·15·18)
  const n = (lo + crypto.randomInt(hi - lo + 1)) * step;
  const [, v] = await redis([['SET', k, n, 'NX', 'EX', 172800], ['GET', k]]);
  return +v || n;
}
async function poolLeft() { const [n] = await redis([['GET', 'cn:issued']]); return Math.max(0, CFG.pool - (+n || 0)); }
async function takePool(n) {
  const q = await dayQuota(), dk = 'cn:di:' + today();
  const [d] = await redis([['INCRBY', dk, n], ['EXPIRE', dk, 172800]]);
  if (d > q) { await redis([['DECRBY', dk, n]]); return 'today'; }
  const [v] = await redis([['INCRBY', 'cn:issued', n]]);
  if (v > CFG.pool) { await redis([['DECRBY', 'cn:issued', n], ['DECRBY', dk, n]]); return 'pool'; }
  return '';
}
async function state(wl) {
  const q = await dayQuota();
  const [n, used, di] = await redis([['GET', 'cn:issued'], ['GET', 'cn:day:' + today()], ['GET', 'cn:di:' + today()]]);
  const left = Math.max(0, CFG.pool - (+n || 0));
  return { on: isOn(), end: CFG.end, left, pool: CFG.pool, dayFull: (+used || 0) >= CFG.dailyWon,
    dayQuota: q, dayLeft: Math.min(left, Math.max(0, q - (+di || 0))),
    cost: CFG.cost, earn: CFG.earn, refEarn: CFG.refEarn, refMax: CFG.refMax, minText: CFG.minText,
    w: wl && wl.w, bal: wl ? wl.bal : 0, claimed: wl ? wl.claimed : false, refs: wl ? wl.refs : 0, code: wl && wl.code };
}

// 무료 사주 후기 → 코인 적립 (후기 서버에서 부름). 결과: {got, bal, why}
async function earn(req, w, text, ref) {
  if (!isOn()) return { got: 0, why: 'end' };
  const wl = await wallet(w); if (!wl) return { got: 0, why: 'wallet' };
  if (wl.claimed) return { got: 0, why: 'claimed', bal: wl.bal };
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < CFG.minText) return { got: 0, why: 'short', bal: wl.bal };
  const th = crypto.createHash('sha256').update(t.replace(/\s/g, '')).digest('hex').slice(0, 32);
  const [dup] = await redis([['SET', 'cn:txt:' + th, '1', 'NX', 'EX', ttl()]]);
  if (!dup) return { got: 0, why: 'dup', bal: wl.bal };
  const ik = 'cn:ip:' + ipHash(req);
  const [ipn] = await redis([['INCR', ik], ['EXPIRE', ik, 90000]]);
  if (ipn > CFG.ipPerDay) return { got: 0, why: 'ip', bal: wl.bal };
  // 지갑당 1번: claimed를 먼저 잠금
  const [first] = await redis([['HSETNX', 'cn:once:' + w, 'c', '1'], ['EXPIRE', 'cn:once:' + w, ttl()]]);
  if (!first) return { got: 0, why: 'claimed', bal: wl.bal };
  const fail = await takePool(CFG.earn);
  if (fail) { // 코인이 없으면 잠금을 풀어서 내일 다시 받을 수 있게
    await redis([['DEL', 'cn:once:' + w], ['DEL', 'cn:txt:' + th], ['DECR', ik]]);
    return { got: 0, why: fail, bal: wl.bal };
  }
  const [bal] = await redis([['HINCRBY', 'cn:w:' + w, 'bal', CFG.earn], ['HSET', 'cn:w:' + w, 'claimed', 1], ['HINCRBY', 'cn:stat', 'claims', 1]]);
  // 친구 초대: 공유한 사람에게 2코인 (최대 5명)
  if (typeof ref === 'string' && /^G[A-Z0-9]{5}$/.test(ref) && ref !== wl.code) {
    const [rw] = await redis([['GET', 'cn:code:' + ref]]);
    if (rw && rw !== w) {
      const [rn] = await redis([['HINCRBY', 'cn:w:' + rw, 'refs', 1]]);
      if (rn <= CFG.refMax && !(await takePool(CFG.refEarn))) await redis([['HINCRBY', 'cn:w:' + rw, 'bal', CFG.refEarn], ['HINCRBY', 'cn:stat', 'refs', 1]]);
      else await redis([['HINCRBY', 'cn:w:' + rw, 'refs', -1]]); // 한도 초과나 오늘 코인 마감이면 친구 수도 안 셈
    }
  }
  return { got: CFG.earn, bal };
}

// 코인 쓰기 → 티켓(곰을 부를 수 있는 표) 발급
async function spend(w, kind) {
  if (!isOn()) return { err: 'end', msg: '곰코인 무료 체험이 끝났어곰' };
  if (!CFG.cost[kind]) return { err: 'bad', msg: '이상한 요청이야곰' };
  const wl = await wallet(w); if (!wl) return { err: 'wallet', msg: '곰코인 지갑을 찾지 못했어곰. 새로고침해 줘곰' };
  const c = CFG.cost[kind], won = CFG.won[kind], dk = 'cn:day:' + today();
  const [after] = await redis([['HINCRBY', 'cn:w:' + w, 'bal', -c]]);
  if (after < 0) { await redis([['HINCRBY', 'cn:w:' + w, 'bal', c]]); return { err: 'coin', msg: '곰코인이 모자라곰 (필요 ' + c + '개, 내 코인 ' + (after + c) + '개)', bal: after + c }; }
  const [used] = await redis([['INCRBY', dk, won], ['EXPIRE', dk, 172800]]);
  if (used > CFG.dailyWon) { await redis([['DECRBY', dk, won], ['HINCRBY', 'cn:w:' + w, 'bal', c]]); return { err: 'day', msg: '오늘 무료 체험이 다 찼어곰. 내일 다시 와줘곰! (코인은 그대로 남아 있어곰)', bal: after + c }; }
  const tk = crypto.randomBytes(16).toString('hex');
  await redis([['HSET', 'cn:tk:' + tk, 'w', w, 'kind', kind, 'left', CFG.calls[kind], 'ok', 0, 'day', today()], ['EXPIRE', 'cn:tk:' + tk, 3600], ['HINCRBY', 'cn:stat', 'use_' + kind, 1]]);
  return { ticket: tk, bal: after };
}
// 풀이가 하나도 안 나왔을 때만 코인 돌려주기
async function refund(w, tk) {
  if (!/^[a-f0-9]{32}$/.test(String(tk || ''))) return { err: 'bad' };
  const [h] = await redis([['HGETALL', 'cn:tk:' + tk]]);
  const o = hmap(h);
  if (!o.w || o.w !== w || o.ok !== '0' || o.refunded === '1') return { err: 'no' };
  const [first] = await redis([['HSETNX', 'cn:tk:' + tk, 'refunded', '1']]);
  if (!first) return { err: 'no' };
  const k = o.kind, cmds = [['HINCRBY', 'cn:w:' + w, 'bal', CFG.cost[k]], ['HSET', 'cn:tk:' + tk, 'left', 0]];
  if (o.day === today()) cmds.push(['DECRBY', 'cn:day:' + today(), CFG.won[k]]);
  cmds.push(['HINCRBY', 'cn:stat', 'use_' + k, -1], ['HINCRBY', 'cn:stat', 'refunds', 1]);
  const r = await redis(cmds);
  return { bal: r[0] };
}
// 곰 서버(ai.js)에서: 티켓 확인 후 1회 차감
async function useTicket(tk) {
  if (!ready() || !/^[a-f0-9]{32}$/.test(String(tk || ''))) return false;
  const [ex] = await redis([['EXISTS', 'cn:tk:' + tk]]);
  if (!ex) return false;
  const [left] = await redis([['HINCRBY', 'cn:tk:' + tk, 'left', -1]]);
  if (left < 0) { await redis([['HINCRBY', 'cn:tk:' + tk, 'left', 1]]); return false; }
  return true;
}
async function ticketOk(tk) { try { await redis([['HINCRBY', 'cn:tk:' + tk, 'ok', 1]]); } catch (e) {} }
async function ticketBack(tk) { try { await redis([['HINCRBY', 'cn:tk:' + tk, 'left', 1]]); } catch (e) {} }

// 관리자 화면용 숫자
async function stats() {
  const q = await dayQuota(), d = today();
  const [n, used, di, st] = await redis([['GET', 'cn:issued'], ['GET', 'cn:day:' + d], ['GET', 'cn:di:' + d], ['HGETALL', 'cn:stat']]);
  return { on: isOn(), end: CFG.end, pool: CFG.pool, issued: +n || 0, left: Math.max(0, CFG.pool - (+n || 0)),
    today: d, dayQuota: q, dayIssued: +di || 0, dayWon: +used || 0, dailyWon: CFG.dailyWon, stat: hmap(st) };
}
module.exports = { stats, dayQuota, CFG, ready, isOn, wallet, newWallet, state, earn, spend, refund, useTicket, ticketOk, ticketBack, poolLeft };
