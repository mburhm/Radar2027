/**
 * رادار بايننس — 7 طبقات + دخول + استثمار + حيتان + خروج
 */
(() => {
  "use strict";

  const HOSTS = [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
  ];
  const SKIP = new Set([
    "USDT","USDC","FDUSD","TUSD","USDP","DAI","EUR","AEUR","EURI","USD1","USDE","BFUSD","USDS","RLUSD","GUSD","USDG","USTC","USDD",
  ]);
  const LEV = /(UP|DOWN|BULL|BEAR)$/;
  const MAJORS = new Set(["BTC","ETH"]);
  const LAYER_NAMES = [
    { id: "trend", ar: "اتجاه", en: "Trend" },
    { id: "mom", ar: "زخم", en: "Momentum" },
    { id: "vol", ar: "حجم", en: "Volume" },
    { id: "squeeze", ar: "ضغط", en: "Squeeze" },
    { id: "struct", ar: "بنية", en: "Structure" },
    { id: "smart", ar: "ذكي", en: "Smart$" },
    { id: "mtf", ar: "MTF", en: "MTF" },
  ];

  const state = {
    tab: "radar",
    scanning: false,
    abort: null,
    results: [],
    entries: [],
    whales: [],
    invest: [],
    flow: [],
    exits: [],
    selected: null,
    settings: {
      whaleMin: 25000,
      excludeMajors: true,
      longOnly: true,
      slAtr: 1.5,
      rr: 2,
    },
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"),
    btnScan: $("btn-scan"),
    btnStop: $("btn-stop"),
    progress: $("progress"),
    pfill: $("pfill"),
    ptext: $("ptext"),
    err: $("err"),
    minVol: $("min-vol"),
    minLayers: $("min-layers"),
    maxN: $("max-n"),
    overlay: $("overlay"),
    sheet: $("sheet"),
    whaleMin: $("whale-min"),
    slAtr: $("sl-atr"),
    rr: $("rr"),
    exMajors: $("ex-majors"),
    longOnly: $("long-only"),
    panels: {
      radar: $("panel-radar"),
      entry: $("panel-entry"),
      whales: $("panel-whales"),
      flow: $("panel-flow"),
      invest: $("panel-invest"),
      exit: $("panel-exit"),
      layers: $("panel-layers"),
    },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const sma = (arr, n) => (arr.length < n ? null : avg(arr.slice(-n)));
  const ema = (arr, n) => {
    if (arr.length < n) return null;
    const k = 2 / (n + 1);
    let e = avg(arr.slice(0, n));
    for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  };
  const fmtPct = (x) => {
    if (x == null || Number.isNaN(x)) return "—";
    return (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
  };
  const fmtVol = (n) => {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
    return String(Math.round(n || 0));
  };
  const fmtPrice = (p) => {
    if (p == null || Number.isNaN(p)) return "—";
    if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
    if (p >= 0.01) return p.toLocaleString("en-US", { maximumFractionDigits: 5 });
    return p.toLocaleString("en-US", { maximumFractionDigits: 8 });
  };
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const chgClass = (x) => (x > 0.0005 ? "pos" : x < -0.0005 ? "neg" : "flat");

  async function fetchJson(path, { signal, retries = 3 } = {}) {
    let last;
    for (let a = 0; a < retries; a++) {
      for (const host of HOSTS) {
        try {
          const res = await fetch(host + path, { signal, headers: { Accept: "application/json" } });
          if (res.status === 429) {
            last = new Error("حد الطلبات (429) — انتظر ثم أعد المحاولة");
            await sleep(700 * (a + 1));
            continue;
          }
          if (!res.ok) {
            last = new Error("HTTP " + res.status);
            continue;
          }
          return await res.json();
        } catch (e) {
          if (e.name === "AbortError") throw e;
          last = e;
        }
      }
      await sleep(350 * (a + 1));
    }
    throw last || new Error("فشل الاتصال بـ Binance");
  }

  async function klines(symbol, interval, limit, signal) {
    const raw = await fetchJson(
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
      { signal }
    );
    return raw.map((c) => ({
      t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5], qv: +c[7], tbq: +c[10],
    }));
  }

  async function loadUniverse(minQ, signal) {
    const data = await fetchJson("/api/v3/ticker/24hr", { signal });
    const out = [];
    for (const t of data) {
      if (!t.symbol.endsWith("USDT")) continue;
      const base = t.symbol.slice(0, -4);
      if (SKIP.has(base) || LEV.test(base) || /^\d/.test(base)) continue;
      const qv = +t.quoteVolume;
      if (qv < minQ) continue;
      out.push({
        symbol: t.symbol,
        base,
        price: +t.lastPrice,
        change24h: +t.priceChangePercent / 100,
        quoteVolume: qv,
      });
    }
    out.sort((a, b) => b.quoteVolume - a.quoteVolume);
    return out;
  }

  function macdHist(closes) {
    if (closes.length < 35) return null;
    const k12 = 2 / 13, k26 = 2 / 27;
    let e12 = avg(closes.slice(0, 12));
    let e26 = avg(closes.slice(0, 26));
    const macdLine = [];
    for (let i = 0; i < closes.length; i++) {
      if (i === 11) e12 = avg(closes.slice(0, 12));
      else if (i > 11) e12 = closes[i] * k12 + e12 * (1 - k12);
      if (i === 25) e26 = avg(closes.slice(0, 26));
      else if (i > 25) e26 = closes[i] * k26 + e26 * (1 - k26);
      if (i >= 25) macdLine.push(e12 - e26);
    }
    if (macdLine.length < 9) return null;
    let sig = avg(macdLine.slice(0, 9));
    const k9 = 2 / 10;
    const hist = [];
    for (let i = 0; i < macdLine.length; i++) {
      if (i === 8) sig = avg(macdLine.slice(0, 9));
      else if (i > 8) sig = macdLine[i] * k9 + sig * (1 - k9);
      if (i >= 8) hist.push(macdLine[i] - sig);
    }
    return hist;
  }

  function bbWidth(closes, n = 20, mult = 2) {
    if (closes.length < n) return null;
    const slice = closes.slice(-n);
    const m = avg(slice);
    const sd = Math.sqrt(avg(slice.map((x) => (x - m) ** 2)));
    if (!m) return null;
    return (2 * mult * sd) / m;
  }

  function atr(candles, n = 14) {
    if (candles.length < n + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    }
    return sma(trs, n);
  }

  function slope(closes, bars) {
    if (closes.length < bars + 1) return null;
    const a = closes[closes.length - 1 - bars];
    const b = closes[closes.length - 1];
    if (!a) return null;
    return (b - a) / a;
  }


  /** تقريب CVD/Volume Flow من Klines (taker buy vs sell) — فكرة Cryptometer */
  function flowFromKlines(candles) {
    if (!candles || candles.length < 8) return null;
    // Binance kline already mapped without taker fields — need raw or recompute from qv only
    // We store only qv; re-fetch path uses volume fields if present
    let buyQ = 0, sellQ = 0;
    const deltas = [];
    for (const c of candles) {
      // if takerBuyQuote available use it; else approximate from close vs open + volume share
      let buy, sell;
      if (c.tbq != null) {
        buy = c.tbq;
        sell = Math.max(0, c.qv - buy);
      } else {
        // rough proxy: bullish candle more buy pressure
        const bull = c.c >= c.o;
        const body = Math.abs(c.c - c.o) / (c.h - c.l || 1e-12);
        const buyShare = bull ? 0.5 + 0.35 * body : 0.5 - 0.35 * body;
        buy = c.qv * clamp(buyShare, 0.15, 0.85);
        sell = c.qv - buy;
      }
      buyQ += buy;
      sellQ += sell;
      deltas.push(buy - sell);
    }
    let cvd = 0;
    const cvdSeries = [];
    for (const d of deltas) {
      cvd += d;
      cvdSeries.push(cvd);
    }
    const total = buyQ + sellQ || 1;
    const buyRatio = buyQ / total;
    const recent = deltas.slice(-6);
    const older = deltas.slice(-18, -6);
    const recentNet = recent.reduce((s, x) => s + x, 0);
    const olderNet = older.length ? older.reduce((s, x) => s + x, 0) : 0;
    const priceChg = candles[candles.length - 1].c / candles[Math.max(0, candles.length - 7)].c - 1;
    const cvdChg = cvdSeries.length > 6
      ? (cvdSeries[cvdSeries.length - 1] - cvdSeries[cvdSeries.length - 7])
      : 0;
    // divergence
    let div = null;
    if (priceChg > 0.01 && cvdChg < 0) div = "bearish"; // price up, flow down
    if (priceChg < -0.01 && cvdChg > 0) div = "bullish"; // price down, buyers absorb
    const strength = clamp(Math.round((buyRatio - 0.5) * 200 + (recentNet > olderNet ? 15 : -10)), -100, 100);
    return {
      buyQ, sellQ, buyRatio, recentNet, cvd: cvdSeries[cvdSeries.length - 1],
      div, strength, priceChg,
    };
  }

  function scoreLayers(h1, h4, d1) {
    const c1 = h1.map((x) => x.c);
    const c4 = h4.map((x) => x.c);
    const cd = d1.map((x) => x.c);
    const v1 = h1.map((x) => x.qv);
    const layers = {
      trend: false, mom: false, vol: false, squeeze: false,
      struct: false, smart: false, mtf: false,
    };
    const notes = [];

    const e20 = ema(c1, 20);
    const e50 = ema(c1, 50);
    if (e20 != null && e50 != null && e20 > e50) {
      layers.trend = true;
      notes.push({ id: "trend", ok: true, text: "EMA20 فوق EMA50 (1س)" });
    } else {
      notes.push({ id: "trend", ok: false, text: "الاتجاه غير صاعد على 1س" });
    }

    const hist = macdHist(c1);
    if (hist && hist.length >= 3) {
      const a = hist[hist.length - 1];
      const b = hist[hist.length - 2];
      if (a > 0 && a >= b) {
        layers.mom = true;
        notes.push({ id: "mom", ok: true, text: "MACD زخم إيجابي ومتسارع" });
      } else if (a > b && b < 0) {
        layers.mom = true;
        notes.push({ id: "mom", ok: true, text: "تحوّل زخم تقريبي" });
      } else {
        notes.push({ id: "mom", ok: false, text: "الزخم غير مؤكد" });
      }
    } else {
      notes.push({ id: "mom", ok: false, text: "بيانات زخم غير كافية" });
    }

    const volSma = sma(v1, 20);
    const lastVol = v1[v1.length - 1];
    const prevVol = avg(v1.slice(-6, -1));
    if (volSma && lastVol > volSma * 1.05 && lastVol >= prevVol * 0.9) {
      layers.vol = true;
      notes.push({ id: "vol", ok: true, text: "حجم فوق المتوسط" });
    } else {
      notes.push({ id: "vol", ok: false, text: "الحجم ضعيف أو متراجع" });
    }

    const widths = [];
    for (let i = 25; i <= c1.length; i++) {
      const w = bbWidth(c1.slice(0, i), 20, 2);
      if (w != null) widths.push(w);
    }
    if (widths.length >= 8) {
      const recent = widths.slice(-3);
      const older = widths.slice(-10, -3);
      const minOld = Math.min(...older);
      const now = recent[recent.length - 1];
      const expanding = now > minOld * 1.15 && now > older[older.length - 1];
      const wasTight = minOld < avg(older) * 0.85;
      if (wasTight && expanding) {
        layers.squeeze = true;
        notes.push({ id: "squeeze", ok: true, text: "خروج من ضغط تقلب" });
      } else {
        notes.push({ id: "squeeze", ok: false, text: "لا إعداد Squeeze واضح" });
      }
    } else {
      notes.push({ id: "squeeze", ok: false, text: "بيانات تقلب غير كافية" });
    }

    if (c1.length >= 30) {
      const seg = c1.slice(-30);
      const mid = Math.floor(seg.length / 2);
      const high0 = Math.max(...seg.slice(0, mid));
      const high1 = Math.max(...seg.slice(mid));
      const low0 = Math.min(...seg.slice(0, mid));
      const low1 = Math.min(...seg.slice(mid));
      if (high1 >= high0 * 0.998 && low1 >= low0) {
        layers.struct = true;
        notes.push({ id: "struct", ok: true, text: "بنية صاعدة" });
      } else {
        notes.push({ id: "struct", ok: false, text: "بنية غير صاعدة بوضوح" });
      }
    }

    const last = h1[h1.length - 1];
    const range = last.h - last.l || 1e-12;
    const closePos = (last.c - last.l) / range;
    const volBoost = volSma ? last.qv / volSma : 1;
    if (closePos > 0.65 && volBoost > 1.2 && last.c >= last.o) {
      layers.smart = true;
      notes.push({ id: "smart", ok: true, text: "إغلاق قوي مع حجم" });
    } else {
      notes.push({ id: "smart", ok: false, text: "لا تأكيد تدفق تقريبي" });
    }

    const e20_4 = ema(c4, 20);
    const e50_4 = ema(c4, 50);
    const e20_d = ema(cd, 20);
    const e50_d = ema(cd, 50);
    const up4 = e20_4 != null && e50_4 != null && e20_4 > e50_4;
    const upd = e20_d != null && e50_d != null && e20_d > e50_d;
    if (up4 && (upd || cd[cd.length - 1] > (e20_d || 0))) {
      layers.mtf = true;
      notes.push({ id: "mtf", ok: true, text: "محاذاة 4س / يومي" });
    } else {
      notes.push({ id: "mtf", ok: false, text: "الأطر الأعلى لا تدعم الشراء" });
    }

    const passed = LAYER_NAMES.filter((l) => layers[l.id]).length;
    const side = passed >= 4 && layers.trend ? "long" : "mixed";

    let exitScore = 0;
    if (e20_d && e50_d && e20_d < e50_d) exitScore += 25;
    if (cd.length >= 30) {
      const hi = Math.max(...cd.slice(-30));
      const fromHi = (hi - cd[cd.length - 1]) / hi;
      if (fromHi < 0.1) exitScore += 15;
      const volD = d1.map((x) => x.qv);
      if (sma(volD, 7) < (sma(volD.slice(0, -7), 14) || 1) * 0.75) exitScore += 20;
    }
    if (hist && hist[hist.length - 1] < 0) exitScore += 20;
    if (!layers.struct) exitScore += 10;

    const change30 = slope(cd, Math.min(30, cd.length - 1));
    const change90 = slope(cd, Math.min(90, cd.length - 1));
    const dailyUp = !!(e20_d && e50_d && e20_d > e50_d);
    const notOverextended = cd.length >= 30
      ? (Math.max(...cd.slice(-30)) - cd[cd.length - 1]) / Math.max(...cd.slice(-30)) > 0.03
      : true;

    let investScore = 0;
    if (dailyUp) investScore += 30;
    if (layers.mtf) investScore += 15;
    if (layers.trend) investScore += 10;
    if (change30 != null && change30 > -0.05 && change30 < 0.35) investScore += 15;
    if (change90 != null && change90 > 0) investScore += 15;
    if (notOverextended) investScore += 10;
    if (exitScore < 40) investScore += 5;

    return {
      layers, notes, passed, side,
      exitScore: clamp(exitScore, 0, 100),
      investScore: clamp(investScore, 0, 100),
      change30, change90, dailyUp,
    };
  }

  function buildTradePlan(price, atrVal) {
    const slMult = state.settings.slAtr || 1.5;
    const rr = state.settings.rr || 2;
    const atrUse = atrVal && atrVal > 0 ? atrVal : price * 0.02;
    const entry = price;
    const stop = entry - slMult * atrUse;
    const risk = entry - stop;
    const target = entry + rr * risk;
    const riskPct = entry ? risk / entry : 0;
    return {
      entry, stop, target, risk, riskPct, rr,
      atr: atrUse,
    };
  }

  async function whaleScan(symbol, minNotional, signal) {
    try {
      const raw = await fetchJson(
        `/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`,
        { signal }
      );
      const since = Date.now() - 45 * 60 * 1000;
      let buy = 0, sell = 0, nBuy = 0, nSell = 0;
      for (const t of raw) {
        if (t.T < since) continue;
        const notion = +t.p * +t.q;
        if (notion < minNotional) continue;
        if (t.m) { sell += notion; nSell++; }
        else { buy += notion; nBuy++; }
      }
      const total = buy + sell;
      if (total < minNotional * 2) return null;
      return {
        buy, sell, nBuy, nSell,
        ratio: total ? buy / total : 0.5,
        dominant: buy > sell * 1.25 ? "buy" : sell > buy * 1.25 ? "sell" : "mixed",
      };
    } catch {
      return null;
    }
  }

  async function mapPool(items, conc, fn, onProg) {
    const out = new Array(items.length);
    let i = 0, done = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await fn(items[idx], idx); }
        catch (e) { out[idx] = { error: e }; }
        done++;
        onProg?.(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, items.length) }, () => worker()));
    return out;
  }

  async function runScan() {
    if (state.scanning) return;
    state.scanning = true;
    state.abort = new AbortController();
    const { signal } = state.abort;

    els.btnScan.disabled = true;
    els.btnStop.hidden = false;
    els.err.hidden = true;
    els.progress.hidden = false;
    els.pfill.style.width = "0%";
    setStatus("جلب الأزواج السائلة…");

    try {
      const minQ = +els.minVol.value;
      const minL = +els.minLayers.value;
      const maxN = +els.maxN.value;
      let uni = await loadUniverse(minQ, signal);
      if (state.settings.excludeMajors) uni = uni.filter((p) => !MAJORS.has(p.base));
      if (!uni.length) throw new Error("لا أزواج تحقق حد السيولة.");

      const candidates = uni.slice(0, 70);
      setStatus("تحليل " + candidates.length + " زوجاً…");

      const analyzed = await mapPool(
        candidates,
        3,
        async (pair) => {
          const [h1, h4, d1] = await Promise.all([
            klines(pair.symbol, "1h", 120, signal),
            klines(pair.symbol, "4h", 80, signal),
            klines(pair.symbol, "1d", 90, signal),
          ]);
          await sleep(30 + Math.random() * 50);
          const scored = scoreLayers(h1, h4, d1);
          const atr1h = atr(h1, 14);
          const plan = buildTradePlan(pair.price, atr1h);
          const flow = flowFromKlines(h1);
          let whale = null;
          if (scored.passed >= 3 || scored.exitScore >= 40 || scored.investScore >= 50) {
            whale = await whaleScan(pair.symbol, state.settings.whaleMin, signal);
          }
          return { ...pair, ...scored, whale, atr1h, plan, flow };
        },
        (done, total) => {
          const pct = Math.round((done / total) * 100);
          els.pfill.style.width = pct + "%";
          els.ptext.textContent = pct + "%";
        }
      );

      const ok = analyzed.filter((x) => x && !x.error && x.passed != null);

      state.results = ok
        .filter((x) => x.passed >= minL)
        .filter((x) => !state.settings.longOnly || x.side === "long" || x.passed >= 5)
        .sort((a, b) => b.passed - a.passed || b.change24h - a.change24h)
        .slice(0, maxN);

      state.entries = ok
        .filter((x) => x.passed >= Math.max(minL, 5) && x.layers.trend && x.side === "long")
        .sort((a, b) => b.passed - a.passed || (b.whale?.ratio || 0) - (a.whale?.ratio || 0))
        .slice(0, maxN);

      state.whales = ok
        .filter((x) => x.whale && (x.whale.dominant === "buy" || x.whale.dominant === "sell"))
        .sort((a, b) => Math.max(b.whale.buy, b.whale.sell) - Math.max(a.whale.buy, a.whale.sell))
        .slice(0, maxN);

      state.flow = ok
        .filter((x) => x.flow)
        .sort((a, b) => Math.abs(b.flow.strength) - Math.abs(a.flow.strength) || b.quoteVolume - a.quoteVolume)
        .slice(0, maxN);

      state.invest = ok
        .filter((x) => x.investScore >= 55 && x.dailyUp && x.exitScore < 50)
        .sort((a, b) => b.investScore - a.investScore || (b.change90 || 0) - (a.change90 || 0))
        .slice(0, maxN);

      state.exits = ok
        .filter((x) => x.exitScore >= 45)
        .sort((a, b) => b.exitScore - a.exitScore)
        .slice(0, maxN);

      if (!state.selected && state.results[0]) state.selected = state.results[0];

      renderAll();
      setStatus(
        "فرص " + state.results.length +
        " · دخول " + state.entries.length +
        " · تدفق " + state.flow.length +
        " · استثمار " + state.invest.length +
        " · خروج " + state.exits.length
      );
    } catch (e) {
      if (e.name === "AbortError") setStatus("تم الإيقاف");
      else {
        showErr(e.message || "فشل الاتصال بـ Binance");
        setStatus("خطأ");
      }
    } finally {
      state.scanning = false;
      state.abort = null;
      els.btnScan.disabled = false;
      els.btnStop.hidden = true;
      els.progress.hidden = true;
    }
  }

  function priceBlock(row) {
    return `<div class="price-line">
      <span class="price">${fmtPrice(row.price)}</span>
      <span class="chg ${chgClass(row.change24h)}">${fmtPct(row.change24h)}</span>
    </div>`;
  }

  function layerDots(layers) {
    return LAYER_NAMES.map((l) => {
      const on = layers[l.id];
      return `<div class="ly ${on ? "on" : "off"}" title="${l.en}">${l.ar}</div>`;
    }).join("");
  }

  function links(row) {
    return `<div class="actions">
      <button type="button" class="btn-layers" data-sym="${esc(row.symbol)}">الطبقات</button>
      <a href="https://www.binance.com/ar/trade/${encodeURIComponent(row.base)}_USDT?type=spot" target="_blank" rel="noopener">Binance</a>
      <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(row.symbol)}" target="_blank" rel="noopener">TV</a>
    </div>`;
  }

  function cardOpportunity(row) {
    const bclass = row.passed >= 6 ? "ok" : row.passed >= 5 ? "warn" : "blue";
    return `<article class="card">
      <div class="card-h">
        <div class="sym-block">
          <div class="sym">${esc(row.base)}<small>/USDT</small></div>
          ${priceBlock(row)}
        </div>
        <div class="badge ${bclass}">${row.passed}/7</div>
      </div>
      <div class="layers-row">${layerDots(row.layers)}</div>
      <div class="grid3">
        <div class="cell"><span class="l">حجم 24س</span><span class="v">${fmtVol(row.quoteVolume)}</span></div>
        <div class="cell"><span class="l">30 يوم</span><span class="v ${chgClass(row.change30 || 0)}">${fmtPct(row.change30)}</span></div>
        <div class="cell"><span class="l">الاتجاه</span><span class="v">${row.side === "long" ? "شراء" : "مختلط"}</span></div>
      </div>
      <div class="chips">
        ${row.side === "long" ? '<span class="chip g">مرشّح شراء</span>' : ""}
        ${row.whale?.dominant === "buy" ? '<span class="chip g">حوت شراء</span>' : ""}
        ${row.whale?.dominant === "sell" ? '<span class="chip r">حوت بيع</span>' : ""}
        ${row.layers.squeeze ? '<span class="chip">Squeeze</span>' : ""}
      </div>
      ${links(row)}
    </article>`;
  }

  function cardEntry(row) {
    const p = row.plan;
    return `<article class="card">
      <div class="card-h">
        <div class="sym-block">
          <div class="sym">${esc(row.base)}<small>/USDT</small></div>
          ${priceBlock(row)}
        </div>
        <div class="badge ok">${row.passed}/7 دخول</div>
      </div>
      <div class="plan-box">
        <div class="plan-title">خطة الصفقة (تقريبية · راجع الشارت)</div>
        <div class="plan-grid">
          <div class="plan-item"><div class="l">نقطة الدخول</div><div class="v hl">${fmtPrice(p.entry)}</div></div>
          <div class="plan-item"><div class="l">ستوب لوز</div><div class="v neg">${fmtPrice(p.stop)}</div></div>
          <div class="plan-item"><div class="l">الهدف (R:R ${p.rr})</div><div class="v pos">${fmtPrice(p.target)}</div></div>
          <div class="plan-item"><div class="l">المخاطرة ≈</div><div class="v">${fmtPct(p.riskPct)}</div></div>
        </div>
        <p class="hint">الستوب = السعر − ${state.settings.slAtr}×ATR(1س). الهدف = الدخول + ${state.settings.rr}× المخاطرة. لا تدخل بكامل رأس المال.</p>
      </div>
      <div class="chips">
        ${row.layers.trend ? '<span class="chip g">اتجاه</span>' : ""}
        ${row.layers.mom ? '<span class="chip g">زخم</span>' : ""}
        ${row.layers.mtf ? '<span class="chip">MTF</span>' : ""}
        ${row.whale?.dominant === "buy" ? '<span class="chip g">حوت شراء</span>' : ""}
      </div>
      ${links(row)}
    </article>`;
  }


  function cardFlow(row) {
    const f = row.flow;
    const buyPct = Math.round(f.buyRatio * 100);
    const sellPct = 100 - buyPct;
    const bias = f.strength >= 20 ? "شراء مسيطر" : f.strength <= -20 ? "بيع مسيطر" : "متوازن";
    const bclass = f.strength >= 20 ? "ok" : f.strength <= -20 ? "bad" : "warn";
    const divChip = f.div === "bullish"
      ? '<span class="chip g">تباين صاعد (امتصاص)</span>'
      : f.div === "bearish"
      ? '<span class="chip r">تباين هابط (توزيع)</span>'
      : "";
    return `<article class="card">
      <div class="card-h">
        <div class="sym-block">
          <div class="sym">${esc(row.base)}<small>/USDT</small></div>
          ${priceBlock(row)}
        </div>
        <div class="badge ${bclass}">${bias}</div>
      </div>
      <div class="flow-bar"><div class="buy" style="width:${buyPct}%"></div></div>
      <div class="flow-split"><span class="b">شراء ${buyPct}%</span><span class="s">بيع ${sellPct}%</span></div>
      <div class="grid3">
        <div class="cell"><span class="l">قوة التدفق</span><span class="v ${f.strength >= 0 ? "pos" : "neg"}">${f.strength > 0 ? "+" : ""}${f.strength}</span></div>
        <div class="cell"><span class="l">طبقات</span><span class="v">${row.passed}/7</span></div>
        <div class="cell"><span class="l">حجم 24س</span><span class="v">${fmtVol(row.quoteVolume)}</span></div>
      </div>
      <div class="chips">
        ${divChip}
        ${row.whale?.dominant === "buy" ? '<span class="chip g">حوت شراء</span>' : ""}
        ${row.whale?.dominant === "sell" ? '<span class="chip r">حوت بيع</span>' : ""}
        ${row.layers.trend ? '<span class="chip g">اتجاه</span>' : ""}
      </div>
      <p class="hint">تدفق أوامر تقريبي (Buy/Sell Delta + CVD) على فريم 1س — نفس فكرة Volume Flow / CVD في Cryptometer.</p>
      ${links(row)}
    </article>`;
  }

  function renderFlow() {
    const p = els.panels.flow;
    if (!p) return;
    if (!state.flow.length) {
      p.innerHTML = `<div class="empty">
        <p><strong>التدفق (Order Flow)</strong> — مستوحى من Cryptometer: من يضغط أكثر، المشترون أم البائعون؟</p>
        <ul>
          <li><strong>شريط أخضر/أحمر:</strong> نسبة حجم الشراء العدواني مقابل البيع</li>
          <li><strong>تباين صاعد:</strong> السعر ينزل والتدفق شراء → غالباً امتصاص (فرصة مراقبة للشراء)</li>
          <li><strong>تباين هابط:</strong> السعر يطلع والتدفق بيع → حذر من التوزيع</li>
          <li>الأقوى عندما يتوافق التدفق مع <strong>5/7 طبقات</strong> + حوت شراء</li>
        </ul>
      </div>`;
      return;
    }
    p.innerHTML = state.flow.map(cardFlow).join("");
    bindLayerButtons(p);
  }

  function cardWhale(row) {
    const w = row.whale;
    const dom = w.dominant === "buy" ? "شراء" : w.dominant === "sell" ? "بيع" : "مختلط";
    const bclass = w.dominant === "buy" ? "ok" : w.dominant === "sell" ? "bad" : "warn";
    return `<article class="card">
      <div class="card-h">
        <div class="sym-block">
          <div class="sym">${esc(row.base)}<small>/USDT</small></div>
          ${priceBlock(row)}
        </div>
        <div class="badge ${bclass}">حوت ${dom}</div>
      </div>
      <div class="grid3">
        <div class="cell"><span class="l">شراء كبير</span><span class="v pos">${fmtVol(w.buy)}</span></div>
        <div class="cell"><span class="l">بيع كبير</span><span class="v neg">${fmtVol(w.sell)}</span></div>
        <div class="cell"><span class="l">نسبة الشراء</span><span class="v">${(w.ratio * 100).toFixed(0)}%</span></div>
      </div>
      <div class="chips">
        <span class="chip">${w.nBuy} شراء</span>
        <span class="chip r">${w.nSell} بيع</span>
        <span class="chip">${row.passed}/7 طبقات</span>
      </div>
      ${links(row)}
    </article>`;
  }

  function cardInvest(row) {
    return `<article class="card">
      <div class="card-h">
        <div class="sym-block">
          <div class="sym">${esc(row.base)}<small>/USDT</small></div>
          ${priceBlock(row)}
        </div>
        <div class="badge purple">استثمار ${Math.round(row.investScore)}</div>
      </div>
      <div class="grid4">
        <div class="cell"><span class="l">30 يوم</span><span class="v ${chgClass(row.change30 || 0)}">${fmtPct(row.change30)}</span></div>
        <div class="cell"><span class="l">90 يوم</span><span class="v ${chgClass(row.change90 || 0)}">${fmtPct(row.change90)}</span></div>
        <div class="cell"><span class="l">طبقات</span><span class="v">${row.passed}/7</span></div>
        <div class="cell"><span class="l">حجم 24س</span><span class="v">${fmtVol(row.quoteVolume)}</span></div>
      </div>
      <p class="hint">اتجاه يومي صاعد + ضعف إشارات الخروج. مناسب لمراقبة أفق شهر–3 أشهر بعد تأكيدك الأساسي والأساسيات.</p>
      <div class="chips">
        ${row.dailyUp ? '<span class="chip g">يومي صاعد</span>' : ""}
        ${row.layers.mtf ? '<span class="chip">MTF</span>' : ""}
        ${row.whale?.dominant === "buy" ? '<span class="chip g">حوت شراء</span>' : ""}
      </div>
      ${links(row)}
    </article>`;
  }

  function cardExit(row) {
    return `<article class="card">
      <div class="card-h">
        <div class="sym-block">
          <div class="sym">${esc(row.base)}<small>/USDT</small></div>
          ${priceBlock(row)}
        </div>
        <div class="badge bad">خروج ${Math.round(row.exitScore)}</div>
      </div>
      <div class="grid3">
        <div class="cell"><span class="l">طبقات</span><span class="v">${row.passed}/7</span></div>
        <div class="cell"><span class="l">30 يوم</span><span class="v ${chgClass(row.change30 || 0)}">${fmtPct(row.change30)}</span></div>
        <div class="cell"><span class="l">حجم</span><span class="v">${fmtVol(row.quoteVolume)}</span></div>
      </div>
      <p class="hint"><strong>كيف تستغله:</strong> ليست إشارة بيع قصير بالضرورة. استخدمها لـ (1) تجنب الشراء المتأخر بعد موجة (2) تضييق أهداف صفقاتك المفتوحة (3) مراقبة انكسار يومي قبل زيادة المخاطرة.</p>
      ${links(row)}
    </article>`;
  }

  function bindLayerButtons(root) {
    root.querySelectorAll(".btn-layers").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.getAttribute("data-sym");
        const pools = [state.results, state.entries, state.whales, state.flow, state.invest, state.exits];
        state.selected = null;
        for (const pool of pools) {
          const f = pool.find((r) => r.symbol === sym);
          if (f) { state.selected = f; break; }
        }
        switchTab("layers");
        renderLayers();
      });
    });
  }

  function renderRadar() {
    const p = els.panels.radar;
    if (!state.results.length) {
      p.innerHTML = `<div class="empty"><p><strong>الفرص</strong> — عملات بعدد طبقات كافٍ.</p>
        <ul><li>كل بطاقة تعرض <strong>السعر</strong> و<strong>نسبة 24س</strong></li>
        <li>ادخل من تبويب <strong>دخول</strong> للخطط</li></ul></div>`;
      return;
    }
    p.innerHTML = state.results.map(cardOpportunity).join("");
    bindLayerButtons(p);
  }

  function renderEntry() {
    const p = els.panels.entry;
    if (!state.entries.length) {
      p.innerHTML = `<div class="empty"><p><strong>الدخول</strong> — عملات مؤكدة (5/7+ واتجاه صاعد) مع نقطة دخول وهدف وستوب.</p>
        <ul><li>الستوب مبني على ATR</li><li>الهدف حسب R:R من الإعدادات</li>
        <li>راجع دائماً على الشارت قبل التنفيذ</li></ul></div>`;
      return;
    }
    p.innerHTML = state.entries.map(cardEntry).join("");
    bindLayerButtons(p);
  }

  function renderWhales() {
    const p = els.panels.whales;
    if (!state.whales.length) {
      p.innerHTML = `<div class="empty"><p><strong>الحيتان</strong> — صفقات كبيرة آخر ~45 دقيقة.</p></div>`;
      return;
    }
    p.innerHTML = state.whales.map(cardWhale).join("");
    bindLayerButtons(p);
  }

  function renderInvest() {
    const p = els.panels.invest;
    if (!state.invest.length) {
      p.innerHTML = `<div class="empty"><p><strong>الاستثمار</strong> — عملات باتجاه يومي صاعد وإشارات خروج ضعيفة لأفق شهر–3 أشهر.</p>
        <ul><li>ليست توصية شراء تلقائية</li><li>ادمج مع أساسيات المشروع وحجم محفظتك</li></ul></div>`;
      return;
    }
    p.innerHTML = state.invest.map(cardInvest).join("");
    bindLayerButtons(p);
  }

  function renderExit() {
    const p = els.panels.exit;
    if (!state.exits.length) {
      p.innerHTML = `<div class="empty"><p><strong>الخروج</strong> — ضغط توزيع / ضعف بنية.</p>
        <ul>
          <li>لا تستخدمه وحده لفتح بيع</li>
          <li>تجنّب مطاردة القمم</li>
          <li>راجع صفقاتك المفتوحة إذا ظهرت عملتك هنا</li>
        </ul></div>`;
      return;
    }
    p.innerHTML = state.exits.map(cardExit).join("");
    bindLayerButtons(p);
  }

  function renderLayers() {
    const p = els.panels.layers;
    const row = state.selected;
    if (!row) {
      p.innerHTML = `<div class="empty"><p>اختر عملة من أي تبويب عبر زر <strong>الطبقات</strong>.</p></div>`;
      return;
    }
    const items = LAYER_NAMES.map((l) => {
      const note = row.notes.find((n) => n.id === l.id);
      const ok = row.layers[l.id];
      return `<div class="layer-item">
        <div class="dot ${ok ? "y" : "n"}"></div>
        <div class="info">
          <div class="name">${l.ar} · ${l.en}</div>
          <div class="desc">${esc(note?.text || (ok ? "متحقق" : "غير متحقق"))}</div>
        </div>
      </div>`;
    }).join("");
    p.innerHTML = `
      <article class="card">
        <div class="card-h">
          <div class="sym-block">
            <div class="sym">${esc(row.base)}<small>/USDT</small></div>
            ${priceBlock(row)}
          </div>
          <div class="badge ${row.passed >= 5 ? "ok" : "warn"}">${row.passed}/7</div>
        </div>
        <div class="layers-row" style="margin-top:12px">${layerDots(row.layers)}</div>
      </article>
      <div class="layer-detail">${items}</div>
      <div class="actions">
        <a href="https://www.binance.com/ar/trade/${encodeURIComponent(row.base)}_USDT?type=spot" target="_blank" rel="noopener">Binance</a>
        <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(row.symbol)}" target="_blank" rel="noopener">TradingView</a>
      </div>`;
  }

  function renderAll() {
    renderRadar();
    renderEntry();
    renderWhales();
    renderFlow();
    renderInvest();
    renderExit();
    renderLayers();
  }

  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    Object.entries(els.panels).forEach(([k, el]) => {
      if (!el) return;
      el.hidden = k !== name;
      el.classList.toggle("active", k === name);
    });
  }

  function setStatus(t) { els.status.textContent = t; }
  function showErr(m) { els.err.hidden = false; els.err.textContent = m; }

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem("radar-pro-v2") || "{}");
      Object.assign(state.settings, s);
    } catch {}
    els.whaleMin.value = state.settings.whaleMin;
    els.slAtr.value = state.settings.slAtr;
    els.rr.value = state.settings.rr;
    els.exMajors.checked = state.settings.excludeMajors;
    els.longOnly.checked = state.settings.longOnly;
  }
  function saveSettings() {
    state.settings.whaleMin = +els.whaleMin.value || 25000;
    state.settings.slAtr = +els.slAtr.value || 1.5;
    state.settings.rr = +els.rr.value || 2;
    state.settings.excludeMajors = els.exMajors.checked;
    state.settings.longOnly = els.longOnly.checked;
    localStorage.setItem("radar-pro-v2", JSON.stringify(state.settings));
  }

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      switchTab(t.dataset.tab);
      if (t.dataset.tab === "layers") renderLayers();
    });
  });
  els.btnScan.addEventListener("click", runScan);
  els.btnStop.addEventListener("click", () => state.abort?.abort());
  $("btn-settings").addEventListener("click", () => {
    els.sheet.hidden = false;
    els.overlay.hidden = false;
  });
  $("btn-close").addEventListener("click", closeSheet);
  els.overlay.addEventListener("click", closeSheet);
  $("btn-save").addEventListener("click", () => {
    saveSettings();
    closeSheet();
  });
  function closeSheet() {
    els.sheet.hidden = true;
    els.overlay.hidden = true;
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  loadSettings();
  renderAll();
})();
