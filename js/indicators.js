/**
 * 技術指標計算（純函式，不依賴畫面）。
 * 所有函式回傳與輸入等長的陣列，資料不足的位置為 null。
 */
(function (root) {
  'use strict';

  /** 簡單移動平均 */
  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  /**
   * 指數移動平均，以前 period 筆的簡單平均作為起始值。
   * 輸入可以有前置的 null（例如 DIF 尚未產生的區段）。
   */
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    const first = values.findIndex((v) => v !== null);
    if (first < 0 || values.length - first < period) return out;

    let seed = 0;
    for (let i = first; i < first + period; i++) seed += values[i];
    let prev = seed / period;
    out[first + period - 1] = prev;
    for (let i = first + period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /**
   * MACD：DIF = EMA(fast) − EMA(slow)，DEA = EMA(DIF, signal)，柱狀圖 = DIF − DEA。
   */
  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);
    const dif = closes.map((_, i) =>
      emaFast[i] === null || emaSlow[i] === null ? null : emaFast[i] - emaSlow[i]
    );
    const dea = ema(dif, signal);
    const hist = dif.map((d, i) => (d === null || dea[i] === null ? null : d - dea[i]));
    return { dif, dea, hist };
  }

  const Indicators = { sma, ema, macd };

  if (typeof module !== 'undefined' && module.exports) module.exports = Indicators;
  else root.Indicators = Indicators;
})(typeof window !== 'undefined' ? window : globalThis);
