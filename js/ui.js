/**
 * 畫面：圖表、右側面板、紀錄分頁、快捷鍵。
 * 所有動態文字皆以 textContent 輸出。
 */
(function () {
  'use strict';

  const { Action } = Strategy;
  const { Game } = GameLib;
  const LWC = window.LightweightCharts;

  const $ = (id) => document.getElementById(id);

  /** 建立元素：el('td', { class: 'num', text: '123' }, [子元素...]) */
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
  }

  if (!window.TAIEX_DATA || !LWC) {
    document.body.textContent = '無法載入資料或圖表元件，請確認 data/ 與 vendor/ 資料夾完整。';
    return;
  }

  const bars = window.TAIEX_DATA.bars.map(([date, open, high, low, close]) => ({ date, open, high, low, close }));
  const lastIndex = bars.length - 1;
  const MIN_GAME_DAYS = 5;

  // ---------- 格式 ----------
  const nf = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPrice = (v) => (v === null || v === undefined ? '—' : nf.format(v));
  const fmtSigned = (v) => {
    if (v === null || v === undefined) return '—';
    const r = Math.round(v * 100) / 100;
    if (r === 0) return '0.00';
    return (r > 0 ? '+' : '−') + nf.format(Math.abs(r));
  };
  const signClass = (v) => (v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : '');
  const fmtPosition = (p) => (p > 0 ? `多 ${p} 口` : p < 0 ? `空 ${-p} 口` : '空手');
  const WEEKDAYS = '日一二三四五六';
  const weekday = (date) => `週${WEEKDAYS[new Date(`${date}T00:00:00`).getDay()]}`;

  function actionText(action, position) {
    switch (action) {
      case Action.LONG:
        return position > 0 ? '加碼多單 1 口' : '做多 1 口';
      case Action.SHORT:
        return position < 0 ? '加碼空單 1 口' : '做空 1 口';
      case Action.REDUCE:
        return '減碼 1 口';
      case Action.CLOSE:
        return '全部平倉';
      default:
        return '不動作';
    }
  }

  function tradeText(trade) {
    if (!trade) return '—';
    const side = trade.side > 0 ? '多單' : '空單';
    return `${side}${trade.kind}${trade.count > 1 ? ` ${trade.count} 口` : ''}`;
  }

  const RULE_REFS = {
    enterLong: '規則 2',
    enterShort: '規則 8',
    exit: '規則 7',
    reduce: '規則 4、5',
    add: '規則 3、6',
  };

  // ---------- 狀態 ----------
  const state = {
    params: { ...Strategy.DEFAULT_PARAMS },
    market: null,
    game: null,
    selected: Action.NONE,
    showHints: true,
    showStrategyMarkers: true,
    showRefMa: { ma60: false, ma120: false }, // 參考均線預設不顯示
    hoverIndex: null,
    markers: [], // 目前 K 線上的交易標記（依時間排序）
    markerCounts: { player: 0, strategy: 0 }, // 已轉成標記的交易筆數
  };

  // ---------- 主題 ----------
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function withAlpha(hex, alpha) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function colors() {
    return {
      surface: cssVar('--surface'),
      ink: cssVar('--ink'),
      ink2: cssVar('--ink-2'),
      muted: cssVar('--muted'),
      line: cssVar('--line'),
      lineStrong: cssVar('--line-strong'),
      up: cssVar('--up'),
      down: cssVar('--down'),
      maShort: cssVar('--ma-short'),
      maLong: cssVar('--ma-long'),
      ma60: cssVar('--ma-60'),
      ma120: cssVar('--ma-120'),
      player: cssVar('--player'),
      strategy: cssVar('--strategy'),
    };
  }

  function loadTheme() {
    try {
      const saved = localStorage.getItem('taiex-game-theme');
      if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
    } catch (_) {
      /* 無法使用 localStorage 時沿用系統設定 */
    }
  }

  function toggleTheme() {
    const current =
      document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('taiex-game-theme', next);
    } catch (_) {
      /* 忽略 */
    }
    applyChartTheme();
    render({ full: true });
  }

  // ---------- 圖表 ----------
  const charts = {};

  function baseChartOptions(c, extra = {}) {
    return {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: c.surface },
        textColor: c.ink2,
        fontFamily: '"Barlow Condensed", "Noto Sans TC", "Microsoft JhengHei", sans-serif',
        fontSize: 13,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: c.line } },
      rightPriceScale: { borderColor: c.lineStrong, minimumWidth: 76 },
      timeScale: { borderColor: c.lineStrong, rightOffset: 4 },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: c.muted, labelBackgroundColor: c.ink2 },
        horzLine: { color: c.muted, labelBackgroundColor: c.ink2 },
      },
      localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd' },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      ...extra,
    };
  }

  function createCharts() {
    const c = colors();
    const lineOpts = { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };

    charts.price = LWC.createChart($('priceChart'), baseChartOptions(c, { timeScale: { visible: false } }));
    charts.candles = charts.price.addCandlestickSeries({ priceLineVisible: false });
    // 參考用的長天期均線，預設隱藏，畫在策略均線下層
    for (const key of Object.keys(REF_MA)) {
      charts[key] = charts.price.addLineSeries({ ...lineOpts, visible: state.showRefMa[key] });
    }
    charts.maShort = charts.price.addLineSeries(lineOpts);
    charts.maLong = charts.price.addLineSeries(lineOpts);

    charts.macd = LWC.createChart($('macdChart'), baseChartOptions(c));
    charts.hist = charts.macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    charts.dif = charts.macd.addLineSeries(lineOpts);
    charts.dea = charts.macd.addLineSeries(lineOpts);

    charts.equity = LWC.createChart($('equityChart'), baseChartOptions(c));
    charts.eqPlayer = charts.equity.addLineSeries({ lineWidth: 2, priceLineVisible: false });
    charts.eqStrategy = charts.equity.addLineSeries({
      lineWidth: 2,
      lineStyle: LWC.LineStyle.Dashed,
      priceLineVisible: false,
    });
    charts.eqZero = charts.eqPlayer.createPriceLine({
      price: 0,
      lineWidth: 1,
      lineStyle: LWC.LineStyle.Dotted,
      axisLabelVisible: false,
    });

    // 價格圖與 MACD 圖同步捲動、縮放與十字線
    let syncing = false;
    const sync = (from, to) =>
      from.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        to.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      });
    sync(charts.price, charts.macd);
    sync(charts.macd, charts.price);

    const onHover = (source) => (param) => {
      const idx = param.time ? dateToIndex.get(param.time) : undefined;
      state.hoverIndex = idx === undefined ? null : idx;
      const other = source === 'price' ? charts.macd : charts.price;
      if (state.hoverIndex === null) other.clearCrosshairPosition();
      else if (source === 'price') {
        const h = state.market.hist[idx];
        if (h !== null) other.setCrosshairPosition(h, param.time, charts.hist);
      } else other.setCrosshairPosition(bars[idx].close, param.time, charts.candles);
      renderLegends();
    };
    charts.price.subscribeCrosshairMove(onHover('price'));
    charts.macd.subscribeCrosshairMove(onHover('macd'));

    applyChartTheme();
  }

  const axisFormat = (digits) => {
    const f = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return (v) => f.format(v);
  };

  function applyChartTheme() {
    const c = colors();
    const loc = (digits) => ({ localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd', priceFormatter: axisFormat(digits) } });
    charts.price.applyOptions(baseChartOptions(c, { timeScale: { visible: false }, ...loc(0) }));
    charts.price.applyOptions({ layout: { attributionLogo: true } });
    charts.macd.applyOptions(baseChartOptions(c, loc(1)));
    charts.equity.applyOptions(baseChartOptions(c, loc(0)));
    charts.candles.applyOptions({
      upColor: c.up,
      downColor: c.down,
      borderVisible: false,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });
    charts.maShort.applyOptions({ color: c.maShort });
    charts.maLong.applyOptions({ color: c.maLong });
    for (const key of Object.keys(REF_MA)) charts[key].applyOptions({ color: c[key] });
    charts.dif.applyOptions({ color: c.maShort });
    charts.dea.applyOptions({ color: c.maLong });
    charts.eqPlayer.applyOptions({ color: c.player });
    charts.eqStrategy.applyOptions({ color: c.strategy });
    charts.eqZero.applyOptions({ color: c.lineStrong });
  }

  const dateToIndex = new Map(bars.map((b, i) => [b.date, i]));

  /** 參考用的長天期均線：只供看盤，不影響策略，天數固定 */
  const REF_MA = Object.freeze({ ma60: 60, ma120: 120 });
  const refMaValues = Object.fromEntries(
    Object.entries(REF_MA).map(([key, days]) => [key, Indicators.sma(bars.map((b) => b.close), days)])
  );

  const candlePoint = (i) => {
    const b = bars[i];
    return { time: b.date, open: b.open, high: b.high, low: b.low, close: b.close };
  };

  const linePoint = (values, i) =>
    values[i] === null ? { time: bars[i].date } : { time: bars[i].date, value: values[i] };

  function histPoint(i, c) {
    const h = state.market.hist[i];
    if (h === null) return { time: bars[i].date };
    const prev = state.market.hist[i - 1];
    const weakening = prev !== null && prev !== undefined && Math.abs(h) < Math.abs(prev);
    return { time: bars[i].date, value: h, color: withAlpha(h >= 0 ? c.up : c.down, weakening ? 0.45 : 0.9) };
  }

  function seriesData(point, upto) {
    const out = [];
    for (let i = 0; i <= upto; i++) out.push(point(i));
    return out;
  }

  function markerFor(trade, account, c) {
    const buying =
      ((trade.action === Action.LONG || trade.action === Action.SHORT) && trade.side > 0) ||
      ((trade.action === Action.REDUCE || trade.action === Action.CLOSE) && trade.side < 0);
    const text = { 進場: '+1', 加碼: '+1', 減碼: '減1', 平倉: '平' }[trade.kind];
    const prefix = trade.kind === '進場' || trade.kind === '加碼' ? (trade.side > 0 ? '多' : '空') : '';
    const isPlayer = account === 'player';
    return {
      time: trade.date,
      position: buying ? 'belowBar' : 'aboveBar',
      shape: isPlayer ? (buying ? 'arrowUp' : 'arrowDown') : 'circle',
      color: isPlayer ? c.player : c.strategy,
      text: isPlayer ? prefix + text : '',
      size: isPlayer ? 1 : 0.7,
    };
  }

  /** 依目前交易紀錄重建全部 K 線標記 */
  function rebuildMarkers(c = colors()) {
    const { game } = state;
    const markers = [
      {
        time: bars[game.startIndex].date,
        position: 'aboveBar',
        shape: 'square',
        color: c.muted,
        text: '起始',
        size: 0.6,
      },
    ];
    for (const trade of game.player.trades) markers.push(markerFor(trade, 'player', c));
    if (state.showStrategyMarkers) {
      for (const trade of game.strategy.trades) markers.push(markerFor(trade, 'strategy', c));
    }
    markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    state.markers = markers;
    state.markerCounts = { player: game.player.trades.length, strategy: game.strategy.trades.length };
    charts.candles.setMarkers(markers);
  }

  /** 往後走一天時只附加新的交易標記；新交易一定是最新日期，加在尾端即維持排序 */
  function appendMarkers(c) {
    const { game } = state;
    const fresh = game.player.trades.slice(state.markerCounts.player).map((t) => markerFor(t, 'player', c));
    if (state.showStrategyMarkers) {
      for (const t of game.strategy.trades.slice(state.markerCounts.strategy)) fresh.push(markerFor(t, 'strategy', c));
    }
    state.markerCounts = { player: game.player.trades.length, strategy: game.strategy.trades.length };
    if (fresh.length) {
      state.markers.push(...fresh);
      charts.candles.setMarkers(state.markers);
    }
  }

  /**
   * full：重設全部資料（開新局、回到上一天、切換主題時）。
   * 否則視為往後走了一天，只附加最新一根 K 棒與指標，成本與已玩天數無關。
   */
  function renderCharts({ full = false, rescroll = false } = {}) {
    const { game, market } = state;
    const t = game.t;
    const c = colors();
    const prevRange = charts.price.timeScale().getVisibleLogicalRange();
    const equityPoint = (r, key) => ({ time: r.date, value: r[key] });

    if (full) {
      charts.candles.setData(seriesData(candlePoint, t));
      charts.maShort.setData(seriesData((i) => linePoint(market.maShort, i), t));
      charts.maLong.setData(seriesData((i) => linePoint(market.maLong, i), t));
      for (const key of Object.keys(REF_MA)) charts[key].setData(seriesData((i) => linePoint(refMaValues[key], i), t));
      charts.dif.setData(seriesData((i) => linePoint(market.dif, i), t));
      charts.dea.setData(seriesData((i) => linePoint(market.dea, i), t));
      charts.hist.setData(seriesData((i) => histPoint(i, c), t));
      rebuildMarkers(c);
      charts.eqPlayer.setData(game.rows.map((r) => equityPoint(r, 'playerEquity')));
      charts.eqStrategy.setData(game.rows.map((r) => equityPoint(r, 'strategyEquity')));
    } else {
      charts.candles.update(candlePoint(t));
      charts.maShort.update(linePoint(market.maShort, t));
      charts.maLong.update(linePoint(market.maLong, t));
      for (const key of Object.keys(REF_MA)) charts[key].update(linePoint(refMaValues[key], t));
      charts.dif.update(linePoint(market.dif, t));
      charts.dea.update(linePoint(market.dea, t));
      charts.hist.update(histPoint(t, c));
      appendMarkers(c);
      const last = game.rows[game.rows.length - 1];
      charts.eqPlayer.update(equityPoint(last, 'playerEquity'));
      charts.eqStrategy.update(equityPoint(last, 'strategyEquity'));
    }
    charts.equity.timeScale().fitContent();

    // 保持目前的縮放比例，並讓最新一天固定在右側
    let span;
    if (rescroll || !prevRange) {
      const byWidth = Math.round($('priceChart').clientWidth / 8);
      span = Math.max(40, Math.min(110, byWidth, game.totalDays + 40));
    } else {
      span = prevRange.to - prevRange.from - 4;
    }
    charts.price.timeScale().setVisibleLogicalRange({ from: t - span, to: t + 4 });
  }

  function legendItem(label, value, swatchClass) {
    const children = [];
    if (swatchClass) children.push(el('i', { class: `swatch ${swatchClass}` }));
    children.push(el('span', { text: label }), el('span', { class: 'value', text: value }));
    return el('span', { class: 'item' }, children);
  }

  function renderLegends() {
    const { market, game, params } = state;
    const i = state.hoverIndex ?? game.t;
    const b = bars[i];
    $('priceLegend').replaceChildren(
      legendItem(b.date, '', null),
      legendItem('收', fmtPrice(b.close)),
      legendItem(`${params.maShort}MA`, fmtPrice(market.maShort[i]), 'ma-short'),
      legendItem(`${params.maLong}MA`, fmtPrice(market.maLong[i]), 'ma-long'),
      ...Object.entries(REF_MA)
        .filter(([key]) => state.showRefMa[key])
        .map(([key, days]) => legendItem(`${days}MA`, fmtPrice(refMaValues[key][i]), `ma-${days}`))
    );
    $('macdLegend').replaceChildren(
      legendItem('MACD 12, 26, 9', '', null),
      legendItem('DIF', fmtPrice(market.dif[i]), 'ma-short'),
      legendItem('DEA', fmtPrice(market.dea[i]), 'ma-long'),
      legendItem('柱狀圖', fmtSigned(market.hist[i]))
    );
  }

  // ---------- 右側面板 ----------
  function renderToday() {
    const { game } = state;
    const b = game.bar;
    const prev = bars[game.t - 1];
    const change = prev ? b.close - prev.close : null;
    $('dayCount').textContent =
      `第 ${game.dayNumber} 天，共 ${game.totalDays} 天（${weekday(b.date)}收盤）` + (game.finished ? '，已到結束日' : '');
    $('dayDate').textContent = b.date;

    const cell = (label, value, cls) => el('div', {}, [el('dt', { text: label }), el('dd', { class: cls, text: value })]);
    $('quote').replaceChildren(
      cell('開盤', fmtPrice(b.open)),
      cell('最高', fmtPrice(b.high)),
      cell('最低', fmtPrice(b.low)),
      cell('收盤', fmtPrice(b.close), signClass(change)),
      cell('漲跌', fmtSigned(change), signClass(change))
    );
  }

  function renderRules() {
    const { game } = state;
    $('rulesContent').hidden = !state.showHints;
    $('rulesHidden').hidden = state.showHints;
    $('showHints').checked = state.showHints;
    if (!state.showHints) return;

    const decision = game.coach();
    $('rulesBasis').textContent = `依你目前的部位（${fmtPosition(game.player.position)}），今日收盤檢查：`;

    const groups = decision.groups.map((g) => {
      const cls = ['rule-group', g.met ? 'met' : '', g.applicable ? '' : 'skip'].filter(Boolean).join(' ');
      const title = el('div', { class: 'rule-title' }, [
        el('span', { text: g.met ? `${g.title}：成立` : g.title }),
        el('span', { class: 'rule-ref', text: RULE_REFS[g.id] }),
      ]);
      const body = g.applicable
        ? el(
            'ul',
            { class: 'cond' },
            g.conditions.map((cond) =>
              el('li', {}, [
                el('span', { class: `mark ${cond.pass ? 'ok' : 'no'}`, 'aria-label': cond.pass ? '符合' : '不符合', text: cond.pass ? '✓' : '✗' }),
                el('span', { text: cond.text }),
              ])
            )
          )
        : el('p', { class: 'skip-note', text: g.skipNote });
      return el('div', { class: cls }, [title, body]);
    });
    $('rulesBody').replaceChildren(...groups);

    if (game.finished) {
      $('verdict').replaceChildren(el('span', { text: '已到結束日，按「查看結算」看結果。' }));
    } else {
      $('verdict').replaceChildren(
        el('span', { class: 'lead', text: '策略建議明日：' }),
        el('span', { text: actionText(decision.action, game.player.position) })
      );
    }
    $('ruleNote').hidden = !decision.note;
    $('ruleNote').textContent = decision.note ? `規則 9：${decision.note}` : '';
  }

  function renderOrder() {
    const { game } = state;
    const player = game.player;
    if (!player.canApply(state.selected)) state.selected = Action.NONE;

    for (const btn of $('actions').querySelectorAll('button')) {
      const action = btn.dataset.action;
      if (action === Action.LONG || action === Action.SHORT) {
        btn.querySelector('.label').textContent = actionText(action, player.position);
      }
      btn.disabled = game.finished || !player.canApply(action);
      btn.setAttribute('aria-checked', String(state.selected === action));
      btn.tabIndex = state.selected === action ? 0 : -1;
    }
    $('followBtn').disabled = game.finished || !state.showHints;

    if (game.finished) {
      $('pending').textContent = '已到結束日，不能再下單。';
    } else {
      $('pending').replaceChildren(
        el('span', { text: `明日（${bars[game.t + 1].date}）開盤將：` }),
        el('strong', { text: actionText(state.selected, player.position) })
      );
    }
    $('prevBtn').disabled = game.history.length === 0;
    $('nextBtn').firstChild.textContent = game.finished ? '查看結算 ' : '下一天 ';
  }

  function renderAccounts() {
    const { game } = state;
    const close = game.bar.close;
    const last = game.rows[game.rows.length - 1];
    const p = game.player;
    const s = game.strategy;
    const valueCell = (v) => el('td', { class: signClass(v), text: fmtSigned(v) });
    const row = (label, a, b, cls) => el('tr', { class: cls }, [el('th', { scope: 'row', text: label }), a, b]);
    $('accountBody').replaceChildren(
      row('部位', el('td', { class: 'text', text: fmtPosition(p.position) }), el('td', { class: 'text', text: fmtPosition(s.position) })),
      row('持倉均價', el('td', { text: fmtPrice(p.avgPrice) }), el('td', { text: fmtPrice(s.avgPrice) })),
      row('今日損益', valueCell(last.playerDaily), valueCell(last.strategyDaily)),
      row('未實現', valueCell(p.unrealized(close)), valueCell(s.unrealized(close))),
      row('已實現', valueCell(p.realized), valueCell(s.realized)),
      row('累計損益', valueCell(p.equity(close)), valueCell(s.equity(close)), 'total')
    );
  }

  // ---------- 紀錄分頁 ----------
  // 兩張表都是最新的在最上方。往後走一天只在頂端插入新列，回到上一天只移除頂端的列，
  // 不重畫整張表；rendered 記錄目前畫面上已有幾筆。
  const rendered = { daily: 0, player: 0, strategy: 0 };

  function resetRecords() {
    $('dailyBody').replaceChildren();
    $('tradesBody').replaceChildren();
    Object.assign(rendered, { daily: 0, player: 0, strategy: 0 });
  }

  function dailyRow(r, first) {
    return el('tr', {}, [
      el('td', { class: 'text', text: r.date }),
      el('td', { text: fmtPrice(r.close) }),
      el('td', { class: 'text', text: first ? '起始日' : tradeText(r.playerTrade) }),
      el('td', { class: 'text', text: fmtPosition(r.playerPosition) }),
      el('td', { class: signClass(r.playerDaily), text: fmtSigned(r.playerDaily) }),
      el('td', { class: signClass(r.playerEquity), text: fmtSigned(r.playerEquity) }),
      el('td', { class: 'text', text: first ? '起始日' : tradeText(r.strategyTrade) }),
      el('td', { class: 'text', text: fmtPosition(r.strategyPosition) }),
      el('td', { class: signClass(r.strategyDaily), text: fmtSigned(r.strategyDaily) }),
      el('td', { class: signClass(r.strategyEquity), text: fmtSigned(r.strategyEquity) }),
    ]);
  }

  function syncDaily() {
    const body = $('dailyBody');
    const rows = state.game.rows;
    while (rendered.daily > rows.length) {
      body.firstElementChild.remove();
      rendered.daily--;
    }
    while (rendered.daily < rows.length) {
      body.prepend(dailyRow(rows[rendered.daily], rendered.daily === 0));
      rendered.daily++;
    }
  }

  function tradeRow(t, who) {
    const closing = t.action === Action.REDUCE || t.action === Action.CLOSE;
    return el('tr', {}, [
      el('td', { class: 'text', text: t.date }),
      el('td', { class: 'text', text: who }),
      el('td', { class: 'text', text: tradeText(t) }),
      el('td', { text: fmtPrice(t.price) }),
      el('td', { text: String(t.count) }),
      el('td', { class: closing ? signClass(t.pnl) : '', text: closing ? fmtSigned(t.pnl) : '—' }),
      el('td', { class: 'text', text: fmtPosition(t.positionAfter) }),
    ]);
  }

  function syncTrades() {
    const body = $('tradesBody');
    const { player, strategy } = state.game;
    body.querySelector('tr.empty')?.remove();

    // 回到上一天：被還原的交易都是最新日期，位在最上方
    const removed =
      Math.max(0, rendered.player - player.trades.length) + Math.max(0, rendered.strategy - strategy.trades.length);
    for (let i = 0; i < removed; i++) body.firstElementChild.remove();
    rendered.player = Math.min(rendered.player, player.trades.length);
    rendered.strategy = Math.min(rendered.strategy, strategy.trades.length);

    // 往後走一天：新交易同一天，玩家在前，插在最上方
    const fresh = [
      ...player.trades.slice(rendered.player).map((t) => tradeRow(t, '你')),
      ...strategy.trades.slice(rendered.strategy).map((t) => tradeRow(t, '策略')),
    ];
    if (fresh.length) body.prepend(...fresh);
    rendered.player = player.trades.length;
    rendered.strategy = strategy.trades.length;

    if (!body.firstElementChild) {
      body.append(
        el('tr', { class: 'empty' }, [el('td', { colspan: '7', text: '還沒有任何交易。選擇明日動作後按「下一天」。' })])
      );
    }
  }

  function renderRuleList() {
    const { maShort: s, maLong: l, maxLots: cap, reduceDays: n, direction } = state.params;
    const scope = {
      both: '多單、空單都做（同一時間只持有單一方向）',
      long: '本局只作多單',
      short: '本局只作空單',
    }[direction];
    const rules = [
      `同時間最多持有 ${cap} 口，${scope}。`,
      `多單進場：收盤時 ${s}MA 在 ${l}MA 之上，且 MACD 柱狀圖大於昨日，隔日開盤做多 1 口。`,
      `多單加碼：持有多單且未滿 ${cap} 口時，收盤柱狀圖大於前一日，隔日加碼 1 口。`,
      `減碼：加到第 ${cap} 口的那根 K 棒算第 1 根，前 ${n} 根為保護期、不檢查減碼；第 ${n + 1} 根收盤起，若柱狀圖未突破前 ${n} 日最高值，隔日減碼 1 口（先平最早進場的一口）。因此滿 ${cap} 口後至少持有 ${n + 1} 根 K 棒。`,
      `減碼只在滿 ${cap} 口時才檢查，未滿上限不減碼。`,
      `減碼後若符合加碼條件，照樣再加碼；再次加到 ${cap} 口時，保護期重新計算。`,
      `多單出場：收盤時 ${s}MA 跌破 ${l}MA，隔日全部平倉（保護期內也一樣）。`,
      `空單規則與多單相反：${s}MA 在 ${l}MA 之下且柱狀圖小於昨日時進場；柱狀圖小於前一日時加碼；滿 ${cap} 口且過了保護期後，柱狀圖未跌破前 ${n} 日最低值時減碼；${s}MA 突破 ${l}MA 時出場。`,
      '出場當日即使符合反向進場條件，也只平倉、不反手，隔日收盤再重新判斷。同一天有多個訊號時，優先序為出場、減碼、加碼。',
    ];
    $('ruleList').replaceChildren(...rules.map((text) => el('li', { text })));
  }

  // ---------- 結算 ----------
  function openSummary() {
    const { game } = state;
    const sum = game.summary();
    const p = sum.player;
    const s = sum.strategy;
    $('summaryRange').textContent =
      `${bars[game.startIndex].date} 至 ${bars[game.endIndex].date}，共 ${game.totalDays} 個交易日，` +
      Strategy.DIRECTION_LABELS[state.params.direction];
    const diff = p.total - s.total;
    $('summaryHeadline').textContent =
      Math.abs(diff) < 0.005
        ? '你和策略打成平手。'
        : diff > 0
          ? `你贏過策略 ${nf.format(diff)} 點。`
          : `策略領先你 ${nf.format(-diff)} 點。`;

    const pct = (r) => (r === null ? '—' : `${Math.round(r * 100)}%`);
    const signed = (v) => el('td', { class: signClass(v), text: fmtSigned(v) });
    const plain = (v) => el('td', { text: v });
    const row = (label, a, b, cls) => el('tr', { class: cls }, [el('th', { scope: 'row', text: label }), a, b]);
    $('summaryBody').replaceChildren(
      row('已實現', signed(p.realized), signed(s.realized)),
      row('未實現', signed(p.unrealized), signed(s.unrealized)),
      row('成交筆數', plain(String(p.trades)), plain(String(s.trades))),
      row('完整交易回合', plain(String(p.roundTrips)), plain(String(s.roundTrips))),
      row('回合勝率', plain(pct(p.winRate)), plain(pct(s.winRate))),
      row('最大回撤', plain(nf.format(p.maxDrawdown)), plain(nf.format(s.maxDrawdown))),
      row('總損益', signed(p.total), signed(s.total), 'total')
    );
    $('summaryDialog').showModal();
  }

  // ---------- 流程 ----------
  /** opts 同 renderCharts：預設為「往後走了一天」的增量更新 */
  function render(opts = {}) {
    renderCharts(opts);
    renderLegends();
    renderToday();
    renderRules();
    renderOrder();
    renderAccounts();
    syncDaily();
    syncTrades();
  }

  function selectAction(action) {
    if (state.game.finished || !state.game.player.canApply(action)) return;
    state.selected = action;
    renderOrder();
  }

  function nextDay() {
    const { game } = state;
    if (game.finished) {
      openSummary();
      return;
    }
    game.step(state.selected);
    state.selected = Action.NONE;
    render();
    if (game.finished) openSummary();
  }

  function prevDay() {
    if (state.game.undo()) {
      state.selected = Action.NONE;
      render({ full: true });
    }
  }

  function startGame(params, startIndex, endIndex) {
    state.params = params;
    state.market = Strategy.buildMarket(bars, params);
    state.game = new Game(state.market, params, startIndex, endIndex);
    state.selected = Action.NONE;
    state.hoverIndex = null;
    $('envDirection').textContent = Strategy.DIRECTION_LABELS[params.direction];
    renderRuleList();
    resetRecords();
    render({ full: true, rescroll: true });
  }

  // ---------- 設定表單 ----------
  const fieldIds = ['maShort', 'maLong', 'maxLots', 'reduceDays'];

  function readParams() {
    const params = {};
    for (const id of fieldIds) {
      const raw = $(id).value.trim();
      params[id] = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
    }
    const checked = document.querySelector('input[name="direction"]:checked');
    params.direction = checked ? checked.value : null;
    return params;
  }

  function updateDateLimits() {
    const params = readParams();
    if (Strategy.validateParams(params).length) return;
    const minIdx = Math.min(Strategy.minStartIndex(params), lastIndex - MIN_GAME_DAYS);
    $('startDate').min = bars[minIdx].date;
  }

  function initSettings() {
    const d = Strategy.DEFAULT_PARAMS;
    for (const id of fieldIds) {
      const input = $(id);
      input.min = Strategy.LIMITS[id].min;
      input.max = Strategy.LIMITS[id].max;
      input.value = d[id];
      input.addEventListener('input', updateDateLimits);
    }
    for (const radio of document.querySelectorAll('input[name="direction"]')) {
      radio.checked = radio.value === d.direction;
    }
    const minIdx = Strategy.minStartIndex(d);
    const startIdx = Math.max(minIdx, lastIndex - 119);
    $('startDate').value = bars[startIdx].date;
    $('endDate').value = bars[lastIndex].date;
    for (const id of ['startDate', 'endDate']) {
      $(id).min = bars[0].date;
      $(id).max = bars[lastIndex].date;
    }
    updateDateLimits();

    $('settings').addEventListener('submit', (e) => {
      e.preventDefault();
      const errors = [];
      const invalid = new Set();
      const params = readParams();
      const paramErrors = Strategy.validateParams(params);
      errors.push(...paramErrors);
      for (const id of fieldIds) {
        const { min, max } = Strategy.LIMITS[id];
        if (!Number.isInteger(params[id]) || params[id] < min || params[id] > max) invalid.add(id);
      }
      if (paramErrors.length && invalid.size === 0) {
        invalid.add('maShort');
        invalid.add('maLong');
      }

      let startIdx = -1;
      let endIdx = -1;
      const startVal = $('startDate').value;
      const endVal = $('endDate').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startVal) || !/^\d{4}-\d{2}-\d{2}$/.test(endVal)) {
        errors.push('請選擇起始日與結束日');
        invalid.add('startDate').add('endDate');
      } else if (paramErrors.length === 0) {
        // 非交易日時，起始日往後找、結束日往前找最近的交易日
        startIdx = bars.findIndex((b) => b.date >= startVal);
        endIdx = bars.findLastIndex((b) => b.date <= endVal);
        const minIdx = Strategy.minStartIndex(params);
        if (startIdx < 0 || startIdx < minIdx) {
          errors.push(`起始日最早只能選 ${bars[Math.min(minIdx, lastIndex)].date}，前面要保留足夠的資料計算均線與 MACD`);
          invalid.add('startDate');
        } else if (endIdx - startIdx < MIN_GAME_DAYS) {
          errors.push(`結束日至少要在起始日的 ${MIN_GAME_DAYS} 個交易日之後`);
          invalid.add('endDate');
        }
      }

      for (const id of [...fieldIds, 'startDate', 'endDate']) {
        $(id).setAttribute('aria-invalid', String(invalid.has(id)));
      }
      $('settingsError').textContent = errors.join('；');
      if (errors.length) return;

      $('startDate').value = bars[startIdx].date;
      $('endDate').value = bars[endIdx].date;
      startGame(params, startIdx, endIdx);
    });
  }

  // ---------- 分頁 ----------
  function initTabs() {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const activate = (tab) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        $(t.getAttribute('aria-controls')).hidden = !on;
      }
      if (tab.id === 'tab-equity') requestAnimationFrame(() => charts.equity.timeScale().fitContent());
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => activate(tab));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        activate(next);
      });
    });
  }

  // ---------- 事件 ----------
  function initEvents() {
    $('actions').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (btn) selectAction(btn.dataset.action);
    });
    $('followBtn').addEventListener('click', () => selectAction(state.game.coach().action));
    $('nextBtn').addEventListener('click', nextDay);
    $('prevBtn').addEventListener('click', prevDay);
    $('showHints').addEventListener('change', (e) => {
      state.showHints = e.target.checked;
      renderRules();
      renderOrder();
    });
    // 重新整理時瀏覽器可能還原勾選狀態，先與程式狀態同步
    $('showStrategyMarkers').checked = state.showStrategyMarkers;
    for (const [key, days] of Object.entries(REF_MA)) {
      $(`showMa${days}`).checked = state.showRefMa[key];
      $(`showMa${days}`).addEventListener('change', (e) => {
        state.showRefMa[key] = e.target.checked;
        charts[key].applyOptions({ visible: e.target.checked });
        renderLegends();
      });
    }
    $('showStrategyMarkers').addEventListener('change', (e) => {
      state.showStrategyMarkers = e.target.checked;
      rebuildMarkers();
    });
    $('themeToggle').addEventListener('click', toggleTheme);
    $('summaryBack').addEventListener('click', () => {
      $('summaryDialog').close();
      prevDay();
    });
    $('summaryRestart').addEventListener('click', () => {
      $('summaryDialog').close();
      const { params, game } = state;
      startGame(params, game.startIndex, game.endIndex);
    });

    const keyActions = { 1: Action.LONG, 2: Action.SHORT, 3: Action.REDUCE, 4: Action.CLOSE, 0: Action.NONE };
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ($('summaryDialog').open) return;
      const target = e.target;
      if (target.closest('input, select, textarea, [role="tab"]')) return;

      const key = e.key.toLowerCase();
      if (key === 'arrowright' || key === ' ') {
        e.preventDefault();
        nextDay();
      } else if (key === 'arrowleft') {
        e.preventDefault();
        prevDay();
      } else if (key in keyActions) {
        selectAction(keyActions[key]);
      } else if (key === 'f') {
        if (!$('followBtn').disabled) selectAction(state.game.coach().action);
      } else if (key === 'h') {
        state.showHints = !state.showHints;
        renderRules();
        renderOrder();
      }
    });
  }

  // ---------- 啟動 ----------
  loadTheme();
  $('dataRange').textContent = `${bars[0].date} 至 ${bars[lastIndex].date}`;
  $('envDataRange').textContent = `${bars[0].date} 至 ${bars[lastIndex].date}`;
  createCharts();
  initSettings();
  initTabs();
  initEvents();
  $('settings').requestSubmit();

  // 系統主題改變時同步圖表顏色
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyChartTheme();
    render({ full: true });
  });
})();
