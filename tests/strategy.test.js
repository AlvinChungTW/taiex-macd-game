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

test('MACD 柱狀體 = DIF − DEA', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const { dif, dea, hist } = Indicators.macd(closes);
  assert.equal(hist[32], null);
  assert.notEqual(hist[33], null);
  assert.ok(Math.abs(hist[50] - (dif[50] - dea[50])) < 1e-12);
});

test('空手：短均線在上且柱狀體走高 → 多單進場', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 0, 0, 1, 2] });
  assert.equal(Strategy.evaluate(m, 4, 0, PARAMS).action, Action.LONG);
});

test('空手：短均線在上但柱狀體走低 → 不進場', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 0, 0, 2, 1] });
  assert.equal(Strategy.evaluate(m, 4, 0, PARAMS).action, Action.NONE);
});

test('空手：短均線在下且柱狀體走低 → 空單進場', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 9], maLong: [0, 0, 0, 0, 10], hist: [0, 0, 0, 2, 1] });
  assert.equal(Strategy.evaluate(m, 4, 0, PARAMS).action, Action.SHORT);
});

test('持多未滿上限：柱狀體走高 → 加碼', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [5, 5, 5, 1, 2] });
  assert.equal(Strategy.evaluate(m, 4, 2, PARAMS).action, Action.LONG);
});

test('持多滿上限：柱狀體未突破前 3 日最高 → 減碼', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 4, 4.5] });
  assert.equal(Strategy.evaluate(m, 4, 3, PARAMS).action, Action.REDUCE);
});

test('持多滿上限：柱狀體突破前 3 日最高 → 續抱', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [9, 5, 3, 4, 6] });
  assert.equal(Strategy.evaluate(m, 4, 3, PARAMS).action, Action.NONE);
});

test('持多 2 口：柱狀體走低也不減碼', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 11], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 4, 1] });
  assert.equal(Strategy.evaluate(m, 4, 2, PARAMS).action, Action.NONE);
});

test('出場優先於減碼；出場當日符合空單條件也只平倉', () => {
  const m = fakeMarket({ maShort: [0, 0, 0, 0, 9], maLong: [0, 0, 0, 0, 10], hist: [0, 5, 3, 4, 1] });
  const d = Strategy.evaluate(m, 4, 3, PARAMS);
  assert.equal(d.action, Action.CLOSE);
  assert.ok(d.note);
});

test('空單鏡像：滿上限且柱狀體未跌破前 3 日最低 → 減碼', () => {
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
});
