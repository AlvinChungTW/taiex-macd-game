// 執行：node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Indicators = require('../js/indicators.js');
const Strategy = require('../js/strategy.js');
const { Account, Game } = require('../js/game.js');

const { Action } = Strategy;
const PARAMS = { ...Strategy.DEFAULT_PARAMS };

/** 直接指定指標數值的假市場，方便針對單一規則測試 */
function fakeMarket({ maShort, maLong, hist }) {
  return { maShort, maLong, hist };
}

function loadRealBars() {
  const text = fs.readFileSync(path.join(__dirname, '../data/taiex_data.js'), 'utf8');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const data = JSON.parse(json);
  return data.bars.map(([date, open, high, low, close]) => ({ date, open, high, low, close }));
}

test('SMA 計算正確，資料不足處為 null', () => {
  assert.deepEqual(Indicators.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('EMA 以簡單平均起始並遞推', () => {
  const out = Indicators.ema([1, 2, 3, 4], 3);
  assert.deepEqual(out.slice(0, 3), [null, null, 2]);
  assert.equal(out[3], 4 * 0.5 + 2 * 0.5);
});

test('MACD 柱狀圖 = DIF − DEA', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const { dif, dea, hist } = Indicators.macd(closes);
  assert.equal(hist[32], null);
  assert.notEqual(hist[33], null);
  assert.ok(Math.abs(hist[50] - (dif[50] - dea[50])) < 1e-12);
});

test('空手：短均線在上且柱狀圖走高 → 多單進場', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 0, 0, 1, 2] });
  assert.equal(Strategy.evaluate(m, 4, 0, PARAMS).action, Action.LONG);
});

test('空手：短均線在上但柱狀圖走低 → 不進場', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 0, 0, 2, 1] });
  assert.equal(Strategy.evaluate(m, 4, 0, PARAMS).action, Action.NONE);
});

test('空手：短均線在下且柱狀圖走低 → 空單進場', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 9], maLong: [0, 0, 0, 0, 10], hist: [0, 0, 0, 2, 1] });
  assert.equal(Strategy.evaluate(m, 4, 0, PARAMS).action, Action.SHORT);
});

test('持多未滿上限：柱狀圖走高 → 加碼', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [5, 5, 5, 1, 2] });
  assert.equal(Strategy.evaluate(m, 4, 2, PARAMS).action, Action.LONG);
});

test('持多滿上限：柱狀圖未突破前 3 日最高 → 減碼', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 4, 4.5] });
  assert.equal(Strategy.evaluate(m, 4, 3, PARAMS).action, Action.REDUCE);
});

test('滿上限保護期：加到上限那根起的 3 根 K 棒不檢查減碼', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 4, 4.5] });
  // 第 4 天才加到 3 口（第 1 根）、第 2 天加到（第 3 根）：都在保護期內
  for (const capIndex of [4, 3, 2]) {
    const d = Strategy.evaluate(m, 4, 3, PARAMS, capIndex);
    assert.equal(d.action, Action.NONE);
    assert.equal(d.groups.find((g) => g.id === 'reduce').applicable, false);
  }
  // 第 1 天加到 3 口，第 4 天為第 4 根：開始檢查，未突破前 3 根最高 → 減碼
  assert.equal(Strategy.evaluate(m, 4, 3, PARAMS, 1).action, Action.REDUCE);
});

test('保護期內仍會出場', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 9], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 4, 4.5] });
  assert.equal(Strategy.evaluate(m, 4, 3, PARAMS, 4).action, Action.CLOSE);
});

test('只作多：符合空單條件也不進場；只作空：符合多單條件也不進場', () => {
  const bear = fakeMarket({ maShort: [0, 0, 0, 0, 9], maLong: [0, 0, 0, 0, 10], hist: [0, 0, 0, 2, 1] });
  const bull = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 0, 0, 1, 2] });
  assert.equal(Strategy.evaluate(bear, 4, 0, { ...PARAMS, direction: 'long' }).action, Action.NONE);
  assert.equal(Strategy.evaluate(bull, 4, 0, { ...PARAMS, direction: 'long' }).action, Action.LONG);
  assert.equal(Strategy.evaluate(bull, 4, 0, { ...PARAMS, direction: 'short' }).action, Action.NONE);
  assert.equal(Strategy.evaluate(bear, 4, 0, { ...PARAMS, direction: 'short' }).action, Action.SHORT);
});

test('只作多：多單出場時不提示反向進場', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 9], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 4, 1] });
  const d = Strategy.evaluate(m, 4, 2, { ...PARAMS, direction: 'long' });
  assert.equal(d.action, Action.CLOSE);
  assert.equal(d.note, null);
});

test('持多滿上限：柱狀圖突破前 3 日最高 → 續抱', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [9, 5, 3, 4, 6] });
  assert.equal(Strategy.evaluate(m, 4, 3, PARAMS).action, Action.NONE);
});

test('持多 2 口：柱狀圖走低也不減碼', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 4, 1] });
  assert.equal(Strategy.evaluate(m, 4, 2, PARAMS).action, Action.NONE);
});

test('出場優先於減碼；出場當日符合空單條件 → 平倉並反向', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 9], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 4, 1] });
  const d = Strategy.evaluate(m, 4, 3, PARAMS);
  assert.equal(d.action, Action.REVERSE);
  assert.ok(d.note);
});

test('出場當日不符合反向條件 → 只平倉', () => {
  // 均線跌破但柱狀圖比昨日大，不符合空單進場
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 9], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 1, 4] });
  const d = Strategy.evaluate(m, 4, 2, PARAMS);
  assert.equal(d.action, Action.CLOSE);
  assert.equal(d.note, null);
});

test('帳戶：平倉並反向 1 口', () => {
  const a = new Account(3);
  a.apply(Action.LONG, 100, 'd1', 1);
  a.apply(Action.LONG, 110, 'd2', 2);
  assert.equal(a.canApply(Action.REVERSE), true);
  a.apply(Action.REVERSE, 120, 'd3', 3);
  assert.equal(a.position, -1);
  assert.equal(a.realized, 30); // (120−100) + (120−110)
  assert.deepEqual(a.lots, [120]);
  assert.equal(a.trades.length, 4);
  assert.equal(a.roundTrips.length, 1);
  assert.equal(a.openTrip.side, -1);
  assert.equal(a.unrealized(100), 20);
  assert.equal(new Account(3).canApply(Action.REVERSE), false); // 空手不能反手
});

test('帳戶：交易方向未開放反向時不能反手', () => {
  const a = new Account(3, 'long');
  a.apply(Action.LONG, 100, 'd1', 1);
  assert.equal(a.canApply(Action.REVERSE), false);
});

test('空單鏡像：滿上限且柱狀圖未跌破前 3 日最低 → 減碼', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 9], maLong: [0, 0, 0, 0, 10], hist: [0, -5, -3, -4, -4.5] });
  assert.equal(Strategy.evaluate(m, 4, -3, PARAMS).action, Action.REDUCE);
});

test('帳戶 FIFO 減碼與損益計算', () => {
  const a = new Account(3);
  a.apply(Action.LONG, 100, 'd1');
  a.apply(Action.LONG, 110, 'd2');
  assert.equal(a.unrealized(120), 30);
  const t = a.apply(Action.REDUCE, 120, 'd3');
  assert.equal(t.pnl, 20); // 先平 100 那一口
  assert.equal(a.position, 1);
  a.apply(Action.CLOSE, 105, 'd4');
  assert.equal(a.realized, 15);
  assert.equal(a.position, 0);
  assert.equal(a.roundTrips.length, 1);
  assert.equal(a.canApply(Action.SHORT), true);
});

test('帳戶：持多時不能做空、不能超過上限', () => {
  const a = new Account(2);
  a.apply(Action.LONG, 100, 'd1');
  assert.equal(a.canApply(Action.SHORT), false);
  a.apply(Action.LONG, 100, 'd2');
  assert.equal(a.canApply(Action.LONG), false);
});

test('帳戶：記錄加到上限的 K 棒，減碼後清除', () => {
  const a = new Account(2);
  a.apply(Action.LONG, 100, 'd1', 10);
  assert.equal(a.capIndex, null);
  a.apply(Action.LONG, 100, 'd2', 11);
  assert.equal(a.capIndex, 11);
  a.apply(Action.REDUCE, 100, 'd3', 12);
  assert.equal(a.capIndex, null);
});

test('帳戶：交易方向限制', () => {
  assert.equal(new Account(3, 'long').canApply(Action.SHORT), false);
  assert.equal(new Account(3, 'long').canApply(Action.LONG), true);
  assert.equal(new Account(3, 'short').canApply(Action.LONG), false);
  assert.equal(new Account(3, 'short').canApply(Action.SHORT), true);
});

test('真實資料：玩家完全照策略提示操作，結果與策略對照組一致', () => {
  const bars = loadRealBars();
  const market = Strategy.buildMarket(bars, PARAMS);
  const game = new Game(market, PARAMS, market.minStartIndex, bars.length - 1);
  while (!game.finished) {
    assert.ok(Math.abs(game.player.position) <= PARAMS.maxLots);
    game.step(game.coach().action);
  }
  assert.equal(game.player.position, game.strategy.position);
  assert.ok(Math.abs(game.player.equity(game.bar.close) - game.strategy.equity(game.bar.close)) < 1e-6);
  assert.ok(game.strategy.trades.length > 0);
});

test('真實資料：滿上限後至少持有 N+1 根 K 棒才減碼', () => {
  const bars = loadRealBars();
  const market = Strategy.buildMarket(bars, PARAMS);
  const game = new Game(market, PARAMS, market.minStartIndex, bars.length - 1);
  let capAt = null;
  let reduces = 0;
  while (!game.finished) {
    const before = game.strategy.size;
    game.step(game.coach().action);
    const s = game.strategy;
    if (s.size === PARAMS.maxLots && before < PARAMS.maxLots) capAt = game.t;
    if (before === PARAMS.maxLots && s.size === PARAMS.maxLots - 1) {
      reduces++;
      assert.ok(game.t - capAt >= PARAMS.reduceDays + 1, `${game.bar.date} 在保護期內減碼`);
    }
  }
  assert.ok(reduces > 0);
});

test('真實資料：只作多時不會持有空單，只作空時不會持有多單', () => {
  const bars = loadRealBars();
  for (const direction of ['long', 'short']) {
    const params = { ...PARAMS, direction };
    const market = Strategy.buildMarket(bars, params);
    const game = new Game(market, params, market.minStartIndex, bars.length - 1);
    let traded = false;
    while (!game.finished) {
      game.step(game.coach().action);
      const p = game.strategy.position;
      if (p !== 0) traded = true;
      assert.ok(direction === 'long' ? p >= 0 : p <= 0);
      assert.equal(p, game.player.position);
    }
    assert.ok(traded);
  }
});

test('真實資料：連續多次回到前一天，帳戶狀態與交易紀錄完全還原', () => {
  const bars = loadRealBars();
  const market = Strategy.buildMarket(bars, PARAMS);
  const game = new Game(market, PARAMS, market.minStartIndex, market.minStartIndex + 200);
  const state = () =>
    JSON.stringify({ t: game.t, p: game.player, s: game.strategy, rows: game.rows });
  const saved = [];
  while (!game.finished) {
    saved.push(state());
    game.step(game.coach().action);
  }
  for (let i = saved.length - 1; i >= 0; i--) {
    assert.ok(game.undo());
    assert.equal(state(), saved[i]);
  }
  assert.equal(game.undo(), false);
});

test('真實資料：策略會反手，反手當天記錄兩筆成交，部位直接翻向', () => {
  const bars = loadRealBars();
  const market = Strategy.buildMarket(bars, PARAMS);
  const game = new Game(market, PARAMS, market.minStartIndex, bars.length - 1);
  let reversals = 0;
  while (!game.finished) {
    const before = game.strategy.position;
    const action = game.strategyDecision().action;
    game.step(action);
    if (action === Action.REVERSE) {
      reversals++;
      const row = game.rows[game.rows.length - 1];
      assert.equal(row.strategyTrades.length, 2);
      assert.equal(Math.sign(game.strategy.position), -Math.sign(before));
      assert.equal(Math.abs(game.strategy.position), 1);
    }
  }
  assert.ok(reversals > 0);
});

test('真實資料：回到前一天可還原狀態', () => {
  const bars = loadRealBars();
  const market = Strategy.buildMarket(bars, PARAMS);
  const game = new Game(market, PARAMS, market.minStartIndex, market.minStartIndex + 30);
  for (let i = 0; i < 10; i++) game.step(game.coach().action);
  const before = JSON.stringify(game.rows);
  game.step(game.player.position === 0 ? Action.LONG : Action.CLOSE);
  game.undo();
  assert.equal(JSON.stringify(game.rows), before);
});

test('參數驗證', () => {
  assert.deepEqual(Strategy.validateParams(PARAMS), []);
  assert.ok(Strategy.validateParams({ ...PARAMS, maShort: 20, maLong: 5 }).length > 0);
  assert.ok(Strategy.validateParams({ ...PARAMS, maxLots: 1 }).length > 0);
  assert.ok(Strategy.validateParams({ ...PARAMS, reduceDays: 2.5 }).length > 0);
  assert.ok(Strategy.validateParams({ ...PARAMS, direction: 'sideways' }).length > 0);
});
