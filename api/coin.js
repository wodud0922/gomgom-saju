// 곰코인 지갑 서버: 지갑 확인/만들기, 코인 쓰기(티켓 발급), 실패 시 돌려받기
const C = require('./_coin.js');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ code: 'method' });
  if (!C.ready()) return res.status(500).json({ code: 'setup', error: '저장 공간이 아직 연결되지 않았어곰' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { b = {}; } }
  b = b || {};
  try {
    if (b.action === 'me') {
      let wl = await C.wallet(b.w);
      if (!wl && C.isOn()) wl = await C.newWallet();
      return res.status(200).json(await C.state(wl));
    }
    if (b.action === 'spend') {
      const r = await C.spend(b.w, b.kind);
      if (r.err) return res.status(r.err === 'wallet' ? 404 : 409).json({ code: r.err, error: r.msg, bal: r.bal });
      return res.status(200).json(r);
    }
    if (b.action === 'refund') {
      const r = await C.refund(b.w, b.ticket);
      return res.status(r.err ? 409 : 200).json(r);
    }
    return res.status(400).json({ code: 'bad' });
  } catch (e) {
    console.error('coin fail', String(e && e.message || e).slice(0, 120));
    return res.status(500).json({ code: 'fail', error: '잠깐 문제가 생겼어곰. 다시 해줘곰' });
  }
};
