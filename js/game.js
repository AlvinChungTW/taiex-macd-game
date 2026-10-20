/**
 * 遊戲流程與帳戶損益（純邏輯，不依賴畫面）。
 *
 * 時間軸：畫面停在第 t 日收盤 → 玩家選擇隔日動作 → 第 t+1 日開盤成交 → 以收盤價結算當日損益。
 * 損益單位為「點」，多口時為點數 × 口數，不計交易成本。
 */
(function (root) {
  'use strict';

  const Strategy =
    typeof module !== 'undefined' && module.exports ? require('./strategy.js') : root.Strategy;
  const { Action } = Strategy;

  /** 單一交易帳戶：部位以先進先出（FIFO）管理每一口的進場價 */
  class Account {
    constructor(maxLots, direction = Strategy.Direction.BOTH) {
      this.maxLots = maxLots;
      this.direction = direction;
      this.side = 0; // 1 多、-1 空、0 空手
      this.lots = []; // 每一口的進場價
      this.capIndex = null; // 部位加到上限的那根 K 棒索引，未滿上限時為 null
      this.realized = 0;
      this.trades = [];
      this.roundTrips = [];
      this.openTrip = null;
    }

    get size() {
      return this.lots.length;
    }

    get position() {
      return this.side * this.size;
    }

    get avgPrice() {
      return this.size ? this.lots.reduce((a, b) => a + b, 0) / this.size : null;
    }

    unrealized(price) {
      return this.lots.reduce((sum, entry) => sum + (price - entry) * this.side, 0);
    }

    equity(price) {
      return this.realized + this.unrealized(price);
    }

    canApply(action) {
      switch (action) {
        case Action.NONE:
          return true;
        case Action.LONG:
          return this.direction !== Strategy.Direction.SHORT && this.side >= 0 && this.size < this.maxLots;
        case Action.SHORT:
          return this.direction !== Strategy.Direction.LONG && this.side <= 0 && this.size < this.maxLots;
        case Action.REDUCE:
        case Action.CLOSE:
          return this.size > 0;
        default:
          return false;
      }
    }

    /** 以指定價格執行動作（index 為成交那根 K 棒的索引），回傳成交紀錄（不動作時回傳 null） */
    apply(action, price, date, index = null) {
      if (action === Action.NONE) return null;
      if (!this.canApply(action)) throw new Error(`目前部位無法執行：${action}`);

      if (action === Action.LONG || action === Action.SHORT) {
        const side = action === Action.LONG ? 1 : -1;
        const opening = this.size === 0;
        if (opening) {
          this.openTrip = { side, openDate: date, startRealized: this.realized, maxLots: 0 };
        }
        this.side = side;
        this.lots.push(price);
        if (this.size === this.maxLots) this.capIndex = index;
        this.openTrip.maxLots = Math.max(this.openTrip.maxLots, this.size);
        return this._record(date, action, opening ? '進場' : '加碼', price, 1, 0);
      }

      const count = action === Action.CLOSE ? this.size : 1;
      const side = this.side;
      let pnl = 0;
      for (let i = 0; i < count; i++) pnl += (price - this.lots.shift()) * side;
      this.realized += pnl;
      this.capIndex = null;
      const kind = this.size === 0 ? '平倉' : '減碼';
      const trade = this._record(date, action, kind, price, count, pnl, side);
      if (this.size === 0) {
        this.side = 0;
        this.roundTrips.push({
          ...this.openTrip,
          closeDate: date,
          pnl: this.realized - this.openTrip.startRealized,
        });
        this.openTrip = null;
      }
      return trade;
    }

    _record(date, action, kind, price, count, pnl, side = this.side) {
      const trade = { date, action, kind, side, price, count, pnl, positionAfter: this.position };
      this.trades.push(trade);
      return trade;
    }

    clone() {
      const copy = new Account(this.maxLots, this.direction);
      copy.side = this.side;
      copy.lots = [...this.lots];
      copy.capIndex = this.capIndex;
      copy.realized = this.realized;
      copy.trades = this.trades.map((x) => ({ ...x }));
      copy.roundTrips = this.roundTrips.map((x) => ({ ...x }));
      copy.openTrip = this.openTrip ? { ...this.openTrip } : null;
      return copy;
    }
  }

  /**
   * 一局遊戲：玩家手動操作，策略帳戶以相同參數在背景自動交易作為對照組。
   */
  class Game {
    constructor(market, params, startIndex, endIndex) {
      this.market = market;
      this.params = params;
      this.startIndex = startIndex;
      this.endIndex = endIndex;
      this.t = startIndex;
      this.player = new Account(params.maxLots, params.direction);
      this.strategy = new Account(params.maxLots, params.direction);
      this.rows = [this._row(null, null)];
      this.history = [];
    }

    get bar() {
      return this.market.bars[this.t];
    }

    get dayNumber() {
      return this.t - this.startIndex + 1;
    }

    get totalDays() {
      return this.endIndex - this.startIndex + 1;
    }

    get finished() {
      return this.t >= this.endIndex;
    }

    /** 依策略規則，以玩家目前部位判斷明日動作（策略提示） */
    coach() {
      const p = this.player;
      return Strategy.evaluate(this.market, this.t, p.position, this.params, p.capIndex);
    }

    /** 策略對照組帳戶的明日動作 */
    strategyDecision() {
      const s = this.strategy;
      return Strategy.evaluate(this.market, this.t, s.position, this.params, s.capIndex);
    }

    /** 推進一天：以隔日開盤價執行玩家與策略的動作 */
    step(playerAction) {
      if (this.finished) throw new Error('已到結束日');
      if (!this.player.canApply(playerAction)) throw new Error('目前部位無法執行此動作');

      this.history.push({
        t: this.t,
        player: this.player.clone(),
        strategy: this.strategy.clone(),
        rows: this.rows.length,
      });

      const strategyAction = this.strategyDecision().action;
      this.t += 1;
      const { date, open } = this.bar;
      const playerTrade = this.player.apply(playerAction, open, date, this.t);
      const strategyTrade = this.strategy.apply(strategyAction, open, date, this.t);
      this.rows.push(this._row(playerTrade, strategyTrade));
    }

    /** 回到前一天 */
    undo() {
      const snap = this.history.pop();
      if (!snap) return false;
      this.t = snap.t;
      this.player = snap.player;
      this.strategy = snap.strategy;
      this.rows.length = snap.rows;
      return true;
    }

    _row(playerTrade, strategyTrade) {
      const { date, close } = this.bar;
      const prev = this.rows ? this.rows[this.rows.length - 1] : null;
      const playerEquity = this.player.equity(close);
      const strategyEquity = this.strategy.equity(close);
      return {
        date,
        close,
        playerTrade,
        strategyTrade,
        playerPosition: this.player.position,
        playerEquity,
        playerDaily: prev ? playerEquity - prev.playerEquity : 0,
        strategyPosition: this.strategy.position,
        strategyEquity,
        strategyDaily: prev ? strategyEquity - prev.strategyEquity : 0,
      };
    }

    /** 結算摘要（未平倉部位以最後收盤價計算） */
    summary() {
      const close = this.bar.close;
      const describe = (account, key) => {
        const trips = account.roundTrips.map((r) => r.pnl);
        if (account.openTrip) trips.push(account.equity(close) - account.openTrip.startRealized);
        let peak = 0;
        let maxDrawdown = 0;
        for (const row of this.rows) {
          peak = Math.max(peak, row[key]);
          maxDrawdown = Math.max(maxDrawdown, peak - row[key]);
        }
        const wins = trips.filter((p) => p > 0).length;
        return {
          total: account.equity(close),
          realized: account.realized,
          unrealized: account.unrealized(close),
          trades: account.trades.length,
          roundTrips: trips.length,
          winRate: trips.length ? wins / trips.length : null,
          maxDrawdown,
        };
      };
      return {
        player: describe(this.player, 'playerEquity'),
        strategy: describe(this.strategy, 'strategyEquity'),
      };
    }
  }

  const GameLib = { Account, Game };

  if (typeof module !== 'undefined' && module.exports) module.exports = GameLib;
  else root.GameLib = GameLib;
})(typeof window !== 'undefined' ? window : globalThis);
