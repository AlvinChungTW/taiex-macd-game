/**
 * 均線 + MACD 加減碼策略的規則引擎（純函式，不依賴畫面）。
 *
 * 每天收盤後依「當日收盤資料」與「目前部位」判斷，隔日開盤執行。
 * 部位以帶正負號的整數表示：+n 為 n 口多單，−n 為 n 口空單，0 為空手。
 *
 * 規則（多單；空單全部相反）：
 *   進場：短均線 > 長均線，且 MACD 柱狀體 > 昨日          → 隔日多單 1 口
 *   加碼：持有多單且未達口數上限，柱狀體 > 前一日          → 隔日加碼 1 口
 *   減碼：達口數上限時，柱狀體未突破前 N 日最高值          → 隔日減碼 1 口
 *   出場：短均線 < 長均線                                  → 隔日全部平倉
 *   同日多個訊號時優先序：出場 > 減碼 > 加碼。
 *   出場當日即使符合反向進場條件也只平倉，隔日收盤再重新判斷。
 */
(function (root) {
  'use strict';

  const Indicators =
    typeof module !== 'undefined' && module.exports ? require('./indicators.js') : root.Indicators;

  const MACD_PARAMS = Object.freeze({ fast: 12, slow: 26, signal: 9 });
  /** MACD 需要一段資料才會穩定，起始日之前至少保留的交易日數 */
  const MACD_WARMUP = 60;

  const Action = Object.freeze({
    NONE: 'none',
    LONG: 'long', // 多單進場或加碼 1 口
    SHORT: 'short', // 空單進場或加碼 1 口
    REDUCE: 'reduce', // 減碼 1 口（先平最早進場的一口）
    CLOSE: 'close', // 全部平倉
  });

  const LIMITS = Object.freeze({
    maShort: { min: 2, max: 60 },
    maLong: { min: 3, max: 240 },
    maxLots: { min: 2, max: 10 },
    reduceDays: { min: 1, max: 10 },
  });

  const DEFAULT_PARAMS = Object.freeze({ maShort: 5, maLong: 20, maxLots: 3, reduceDays: 3 });

  /** 計算整段資料的指標 */
  function buildMarket(bars, params) {
    const closes = bars.map((b) => b.close);
    const { dif, dea, hist } = Indicators.macd(
      closes,
      MACD_PARAMS.fast,
      MACD_PARAMS.slow,
      MACD_PARAMS.signal
    );
    return {
      bars,
      maShort: Indicators.sma(closes, params.maShort),
      maLong: Indicators.sma(closes, params.maLong),
      dif,
      dea,
      hist,
      minStartIndex: minStartIndex(params),
    };
  }

  /** 起始日最早可選的索引：長均線、MACD 暖機與「前 N 日」都要有資料 */
  function minStartIndex(params) {
    const histFirst = MACD_PARAMS.slow + MACD_PARAMS.signal - 2;
    return Math.max(params.maLong - 1, MACD_WARMUP - 1, histFirst + params.reduceDays);
  }

  /** 驗證玩家輸入的參數，回傳錯誤訊息陣列（空陣列代表通過） */
  function validateParams(params) {
    const names = {
      maShort: '短均線天數',
      maLong: '長均線天數',
      maxLots: '口數上限',
      reduceDays: '減碼判斷天數',
    };
    const errors = [];
    for (const key of Object.keys(LIMITS)) {
      const v = params[key];
      const { min, max } = LIMITS[key];
      if (!Number.isInteger(v) || v < min || v > max) {
        errors.push(`${names[key]}須為 ${min}～${max} 的整數`);
      }
    }
    if (errors.length === 0 && params.maShort >= params.maLong) {
      errors.push('短均線天數必須小於長均線天數');
    }
    return errors;
  }

  const fmt = (v) => v.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /**
   * 依第 t 日收盤資料與目前部位，判斷隔日動作。
   * 回傳 { action, reason, groups, note }，groups 為逐條規則的檢查結果，供畫面顯示。
   */
  function evaluate(market, t, position, params) {
    const s = market.maShort[t];
    const l = market.maLong[t];
    const h = market.hist[t];
    const hPrev = market.hist[t - 1];
    const sName = `${params.maShort}MA`;
    const lName = `${params.maLong}MA`;
    const size = Math.abs(position);
    const side = Math.sign(position);

    if ([s, l, h, hPrev].some((v) => v === null || v === undefined)) {
      return { action: Action.NONE, reason: '指標資料不足', groups: [], note: null };
    }

    const bull = { text: `${sName} ${fmt(s)} > ${lName} ${fmt(l)}`, pass: s > l };
    const bear = { text: `${sName} ${fmt(s)} < ${lName} ${fmt(l)}`, pass: s < l };
    const histUp = { text: `柱狀體 ${fmt(h)} > 昨日 ${fmt(hPrev)}`, pass: h > hPrev };
    const histDown = { text: `柱狀體 ${fmt(h)} < 昨日 ${fmt(hPrev)}`, pass: h < hPrev };

    const group = (id, title, conditions, applicable = true, skipNote = null) => ({
      id,
      title,
      conditions,
      applicable,
      skipNote,
      met: applicable && conditions.every((c) => c.pass),
    });

    if (side === 0) {
      const groups = [
        group('enterLong', '多單進場', [bull, histUp]),
        group('enterShort', '空單進場', [bear, histDown]),
      ];
      if (groups[0].met) return { action: Action.LONG, reason: '多單進場 1 口', groups, note: null };
      if (groups[1].met) return { action: Action.SHORT, reason: '空單進場 1 口', groups, note: null };
      return { action: Action.NONE, reason: '空手觀望', groups, note: null };
    }

    const isLong = side > 0;
    const sideName = isLong ? '多單' : '空單';
    const n = params.reduceDays;
    const recent = market.hist.slice(t - n, t);
    const extreme = isLong ? Math.max(...recent) : Math.min(...recent);
    const failBreak = isLong
      ? { text: `柱狀體 ${fmt(h)} 未突破前 ${n} 日最高 ${fmt(extreme)}`, pass: h <= extreme }
      : { text: `柱狀體 ${fmt(h)} 未跌破前 ${n} 日最低 ${fmt(extreme)}`, pass: h >= extreme };
    const atCap = size >= params.maxLots;

    const groups = [
      group('exit', `${sideName}出場`, [isLong ? bear : bull]),
      group('reduce', '減碼 1 口', [failBreak], atCap, `未達 ${params.maxLots} 口上限，不檢查減碼`),
      group('add', '加碼 1 口', [isLong ? histUp : histDown], !atCap, `已達 ${params.maxLots} 口上限，不再加碼`),
    ];

    if (groups[0].met) {
      // 出場當日即使符合反向進場條件，也只平倉
      const reverse = isLong ? bear.pass && histDown.pass : bull.pass && histUp.pass;
      const note = reverse
        ? `今日也符合${isLong ? '空單' : '多單'}進場條件，但出場當日只平倉、不反向進場，明日收盤再判斷。`
        : null;
      return { action: Action.CLOSE, reason: `${sideName}全部平倉`, groups, note };
    }
    if (groups[1].met) return { action: Action.REDUCE, reason: `${sideName}減碼 1 口`, groups, note: null };
    if (groups[2].met) return { action: isLong ? Action.LONG : Action.SHORT, reason: `${sideName}加碼 1 口`, groups, note: null };
    return { action: Action.NONE, reason: `續抱 ${size} 口${sideName}`, groups, note: null };
  }

  const Strategy = {
    Action,
    LIMITS,
    DEFAULT_PARAMS,
    MACD_PARAMS,
    MACD_WARMUP,
    buildMarket,
    minStartIndex,
    validateParams,
    evaluate,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Strategy;
  else root.Strategy = Strategy;
})(typeof window !== 'undefined' ? window : globalThis);
