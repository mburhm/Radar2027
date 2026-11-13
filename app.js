/**
 * رادار بايننس الاحترافي — 7 طبقات + حيتان
 * مستوحى من نظام التأكيد المتعدد (Trend/Momentum/Volume/Squeeze/Structure/Smart Money/MTF)
 * يعمل على GitHub Pages — بيانات عامة من Binance
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
    whales: [],
    exits: [],
    selected: null,
    settings: {
      whaleMin: 25000,
      excludeMajors: true,
      longOnly: true,
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
    exMajors: $("ex-majors"),
    longOnly: $("long-only"),
    panels: {
      radar: $("panel-radar"),
      whales: $("panel-whales"),
      layers: $("panel-layers"),
      exit: $("panel-exit"),
    },
  };

  // ── utils ──
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
    return (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
  };
  const fmtVol = (n) => {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
    return String(Math.round(n || 0));
  };
  const fmtPrice = (p) => {
    if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
    return p.toLocaleString("en-US", { maximumFractionDigits: 6 });
  };
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
            last = new Error(`HTTP ${res.status}`);
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
      t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5], qv: +c[7],
    }));
  }

  // ── universe ──
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

  // ── indicators ──
  function macdHist(closes) {
    if (closes.length < 35) return null;
    const ema12 = [];
    const ema26 = [];
    const k12 = 2 / 13, k26 = 2 / 27;
    let e12 = avg(closes.slice(0, 12));
    let e26 = avg(closes.slice(0, 26));
    for (let i = 0; i < closes.length; i++) {
      if (i === 11) e12 = avg(closes.slice(0, 12));
      else if (i > 11) e12 = closes[i] * k12 + e12 * (1 - k12);
      if (i === 25) e26 = avg(closes.slice(0, 26));
      else if (i > 25) e26 = closes[i] * k26 + e26 * (1 - k26);
      if (i >= 25) {
        ema12.push(e12);
        ema26.push(e26);
      }
    }
    const macdLine = ema12.map((x, i) => x - ema26[i]);
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
    const variance = avg(slice.map((x) => (x - m) ** 2));
    const sd = Math.sqrt(variance);
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

  // ── 7 layers (long bias) ──
  function scoreLayers(h1, h4, d1) {
    const c1 = h1.map((x) => x.c);
    const c4 = h4.map((x) => x.c);
    const cd = d1.map((x) => x.c);
    const v1 = h1.map((x) => x.qv);
    const layers = {
      trend: false,
      mom: false,
      vol: false,
      squeeze: false,
      struct: false,
      smart: false,
      mtf: false,
    };
    const notes = [];

    // 1 Trend — EMA20 > EMA50 on 1h
    const e20 = ema(c1, 20);
    const e50 = ema(c1, 50);
    if (e20 != null && e50 != null && e20 > e50) {
      layers.trend = true;
      notes.push({ id: "trend", ok: true, text: "EMA20 فوق EMA50 (1س)" });
    } else {
      notes.push({ id: "trend", ok: false, text: "الاتجاه غير صاعد على 1س" });
    }

    // 2 Momentum — MACD hist rising / positive
    const hist = macdHist(c1);
    if (hist && hist.length >= 3) {
      const a = hist[hist.length - 1];
      const b = hist[hist.length - 2];
      if (a > 0 && a >= b) {
        layers.mom = true;
        notes.push({ id: "mom", ok: true, text: "MACD زخم إيجابي ومتسارع" });
      } else if (a > b && b < 0) {
        layers.mom = true;
        notes.push({ id: "mom", ok: true, text: "تحوّل زخم (تقاطع صاعد تقريبي)" });
      } else {
        notes.push({ id: "mom", ok: false, text: "الزخم غير مؤكد" });
      }
    } else {
      notes.push({ id: "mom", ok: false, text: "بيانات زخم غير كافية" });
    }

    // 3 Volume — recent > SMA20 volume
    const volSma = sma(v1, 20);
    const lastVol = v1[v1.length - 1];
    const prevVol = avg(v1.slice(-6, -1));
    if (volSma && lastVol > volSma * 1.05 && lastVol >= prevVol * 0.9) {
      layers.vol = true;
      notes.push({ id: "vol", ok: true, text: "حجم فوق المتوسط مع مشاركة" });
    } else {
      notes.push({ id: "vol", ok: false, text: "الحجم ضعيف أو متراجع" });
    }

    // 4 Squeeze — BB width compressed then expanding (LazyBear-style idea)
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
        notes.push({ id: "squeeze", ok: true, text: "خروج من ضغط تقلب (Squeeze)" });
      } else if (now < avg(widths.slice(-15)) * 0.75) {
        notes.push({ id: "squeeze", ok: false, text: "ما زال في ضغط — انتظار انفجار" });
      } else {
        notes.push({ id: "squeeze", ok: false, text: "لا إعداد Squeeze واضح" });
      }
    } else {
      notes.push({ id: "squeeze", ok: false, text: "بيانات تقلب غير كافية" });
    }

    // 5 Structure — HH/HL on recent swings (1h)
    if (c1.length >= 30) {
      const seg = c1.slice(-30);
      const mid = Math.floor(seg.length / 2);
      const high0 = Math.max(...seg.slice(0, mid));
      const high1 = Math.max(...seg.slice(mid));
      const low0 = Math.min(...seg.slice(0, mid));
      const low1 = Math.min(...seg.slice(mid));
      if (high1 >= high0 * 0.998 && low1 >= low0) {
        layers.struct = true;
        notes.push({ id: "struct", ok: true, text: "بنية صاعدة (قمم/قيعان أعلى)" });
      } else {
        notes.push({ id: "struct", ok: false, text: "بنية غير صاعدة بوضوح" });
      }
    }

    // 6 Smart money proxy — strong close + volume (institutional-style participation)
    const last = h1[h1.length - 1];
    const body = Math.abs(last.c - last.o);
    const range = last.h - last.l || 1e-12;
    const closePos = (last.c - last.l) / range;
    const volBoost = volSma ? last.qv / volSma : 1;
    if (closePos > 0.65 && volBoost > 1.2 && last.c >= last.o) {
      layers.smart = true;
      notes.push({ id: "smart", ok: true, text: "مشاركة قوية عند الإغلاق (تدفق)" });
    } else {
      notes.push({ id: "smart", ok: false, text: "لا تأكيد تدفق مؤسسي تقريبي" });
    }

    // 7 MTF — 4h and daily bias aligned up
    const e20_4 = ema(c4, 20);
    const e50_4 = ema(c4, 50);
    const e20_d = ema(cd, 20);
    const e50_d = ema(cd, 50);
    const up4 = e20_4 != null && e50_4 != null && e20_4 > e50_4;
    const upd = e20_d != null && e50_d != null && e20_d > e50_d;
    if (up4 && (upd || cd[cd.length - 1] > (e20_d || 0))) {
      layers.mtf = true;
      notes.push({ id: "mtf", ok: true, text: "محاذاة أطر أعلى (4س / يومي)" });
    } else if (up4) {
      notes.push({ id: "mtf", ok: false, text: "4س صاعد لكن اليومي غير متوافق" });
    } else {
      notes.push({ id: "mtf", ok: false, text: "الأطر الأعلى لا تدعم الشراء" });
    }

    const passed = LAYER_NAMES.filter((l) => layers[l.id]).length;
    const side = passed >= 4 && layers.trend ? "long" : passed <= 2 ? "neutral" : "mixed";

    // exit pressure score (distribution) for exit tab
    let exitScore = 0;
    const e20d = ema(cd, 20);
    const e50d = ema(cd, 50);
    if (e20d && e50d && e20d < e50d) exitScore += 25;
    if (cd.length >= 30) {
      const hi = Math.max(...cd.slice(-30));
      const fromHi = (hi - cd[cd.length - 1]) / hi;
      if (fromHi < 0.1) exitScore += 15;
      const volD = d1.map((x) => x.qv);
      if (sma(volD, 7) < sma(volD.slice(0, -7), 14) * 0.75) exitScore += 20;
    }
    if (hist && hist[hist.length - 1] < 0) exitScore += 20;
    if (!layers.struct) exitScore += 10;

    return { layers, notes, passed, side, exitScore: clamp(exitScore, 0, 100) };
  }

  // ── whales via aggTrades ──
  async function whaleScan(symbol, minNotional, signal) {
    try {
      const raw = await fetchJson(
        `/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`,
        { signal }
      );
      const since = Date.now() - 45 * 60 * 1000;
      let buy = 0, sell = 0, nBuy = 0, nSell = 0, bigBuys = 0, bigSells = 0;
      for (const t of raw) {
        if (t.T < since) continue;
        const notion = +t.p * +t.q;
        if (notion < minNotional) continue;
        if (t.m) {
          sell += notion; nSell++; bigSells++;
        } else {
          buy += notion; nBuy++; bigBuys++;
        }
      }
      const total = buy + sell;
      if (total < minNotional * 2) return null;
      return {
        buy, sell, nBuy, nSell, bigBuys, bigSells,
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

  // ── scan ──
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
      setStatus(`تحليل ${candidates.length} زوجاً…`);

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
          let whale = null;
          if (scored.passed >= 3 || scored.exitScore >= 40) {
            whale = await whaleScan(pair.symbol, state.settings.whaleMin, signal);
          }
          return { ...pair, ...scored, whale, atr1h: atr(h1, 14) };
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

      state.whales = ok
        .filter((x) => x.whale && (x.whale.dominant === "buy" || x.whale.dominant === "sell"))
        .sort((a, b) => {
          const pa = Math.max(a.whale.buy, a.whale.sell);
          const pb = Math.max(b.whale.buy, b.whale.sell);
          return pb - pa;
        })
        .slice(0, maxN);

      state.exits = ok
        .filter((x) => x.exitScore >= 45)
        .sort((a, b) => b.exitScore - a.exitScore)
        .slice(0, maxN);

      if (!state.selected && state.results[0]) state.selected = state.results[0];

      renderAll();
      setStatus(`تم: ${state.results.length} فرصة · ${state.whales.length} حيتان · ${state.exits.length} خروج`);
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

  // ── render ──
  function layerDots(layers) {
    return LAYER_NAMES.map((l) => {
      const on = layers[l.id];
      return `<div class="ly ${on ? "on" : "off"}" title="${l.en}">${l.ar}</div>`;
    }).join("");
  }

  function cardOpportunity(row) {
    const bclass = row.passed >= 6 ? "ok" : row.passed >= 5 ? "warn" : "blue";
    return `<article class="card" data-sym="${esc(row.symbol)}">
      <div class="card-h">
        <div><div class="sym">${esc(row.base)}<small>/USDT</small></div></div>
        <div class="badge ${bclass}">${row.passed}/7</div>
      </div>
      <div class="layers-row">${layerDots(row.layers)}</div>
      <div class="grid3">
        <div class="cell"><span class="l">24س</span><span class="v ${row.change24h >= 0 ? "pos" : "neg"}">${fmtPct(row.change24h)}</span></div>
        <div class="cell"><span class="l">حجم</span><span class="v">${fmtVol(row.quoteVolume)}</span></div>
        <div class="cell"><span class="l">السعر</span><span class="v">${fmtPrice(row.price)}</span></div>
      </div>
      <div class="chips">
        ${row.side === "long" ? '<span class="chip g">مرشّح شراء</span>' : ""}
        ${row.whale?.dominant === "buy" ? '<span class="chip g">حوت شراء</span>' : ""}
        ${row.whale?.dominant === "sell" ? '<span class="chip r">حوت بيع</span>' : ""}
        ${row.layers.squeeze ? '<span class="chip">Squeeze</span>' : ""}
        ${row.layers.mtf ? '<span class="chip">MTF</span>' : ""}
      </div>
      <div class="actions">
        <button type="button" class="btn-layers" data-sym="${esc(row.symbol)}">الطبقات</button>
        <a href="https://www.binance.com/ar/trade/${encodeURIComponent(row.base)}_USDT?type=spot" target="_blank" rel="noopener">Binance</a>
        <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(row.symbol)}" target="_blank" rel="noopener">TV</a>
      </div>
    </article>`;
  }

  function cardWhale(row) {
    const w = row.whale;
    const dom = w.dominant === "buy" ? "شراء" : w.dominant === "sell" ? "بيع" : "مختلط";
    const bclass = w.dominant === "buy" ? "ok" : w.dominant === "sell" ? "bad" : "warn";
    return `<article class="card">
      <div class="card-h">
        <div class="sym">${esc(row.base)}<small>/USDT</small></div>
        <div class="badge ${bclass}">حوت ${dom}</div>
      </div>
      <div class="grid3">
        <div class="cell"><span class="l">شراء كبير</span><span class="v pos">${fmtVol(w.buy)}</span></div>
        <div class="cell"><span class="l">بيع كبير</span><span class="v neg">${fmtVol(w.sell)}</span></div>
        <div class="cell"><span class="l">نسبة الشراء</span><span class="v">${(w.ratio * 100).toFixed(0)}%</span></div>
      </div>
      <div class="chips">
        <span class="chip">${w.bigBuys} صفقة شراء</span>
        <span class="chip r">${w.bigSells} صفقة بيع</span>
        <span class="chip">${row.passed}/7 طبقات</span>
      </div>
      <div class="actions">
        <a href="https://www.binance.com/ar/trade/${encodeURIComponent(row.base)}_USDT?type=spot" target="_blank" rel="noopener">Binance</a>
        <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(row.symbol)}" target="_blank" rel="noopener">TradingView</a>
      </div>
    </article>`;
  }

  function cardExit(row) {
    return `<article class="card">
      <div class="card-h">
        <div class="sym">${esc(row.base)}<small>/USDT</small></div>
        <div class="badge bad">خروج ${Math.round(row.exitScore)}</div>
      </div>
      <div class="grid3">
        <div class="cell"><span class="l">24س</span><span class="v ${row.change24h >= 0 ? "pos" : "neg"}">${fmtPct(row.change24h)}</span></div>
        <div class="cell"><span class="l">طبقات</span><span class="v">${row.passed}/7</span></div>
        <div class="cell"><span class="l">حجم</span><span class="v">${fmtVol(row.quoteVolume)}</span></div>
      </div>
      <p style="margin:10px 0 0;font-size:0.82rem;color:var(--muted);line-height:1.5">
        إشارات توزيع / ضعف بنية على الأطر الأعلى — للمراقبة أو تجنب الشراء المتأخر.
      </p>
      <div class="actions">
        <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(row.symbol)}" target="_blank" rel="noopener">TradingView</a>
      </div>
    </article>`;
  }

  function renderRadar() {
    const p = els.panels.radar;
    if (!state.results.length) {
      p.innerHTML = `<div class="empty">
        <p><strong>تبويب الفرص</strong> — صفقات مرشّحة عندما تتحقق عدة طبقات تأكيد معاً (مثل نظام الـ checklist).</p>
        <ul>
          <li>اتجاه · زخم · حجم · ضغط · بنية · تدفق ذكي · محاذاة أطر</li>
          <li>ادخل فقط عند <strong>5/7 أو أعلى</strong> كقاعدة انضباط</li>
          <li>الرادار يعطيك القائمة — القرار النهائي على الشارت + إدارة مخاطر</li>
        </ul>
      </div>`;
      return;
    }
    p.innerHTML = state.results.map(cardOpportunity).join("");
    p.querySelectorAll(".btn-layers").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.getAttribute("data-sym");
        state.selected = state.results.find((r) => r.symbol === sym) ||
          state.whales.find((r) => r.symbol === sym) ||
          state.exits.find((r) => r.symbol === sym);
        switchTab("layers");
        renderLayers();
      });
    });
  }

  function renderWhales() {
    const p = els.panels.whales;
    if (!state.whales.length) {
      p.innerHTML = `<div class="empty">
        <p><strong>تبويب الحيتان</strong> — صفقات كبيرة (AggTrades) خلال آخر ~45 دقيقة فوق حدّك بالـ USDT.</p>
        <ul>
          <li>حوت شراء مع طبقات عالية = تأكيد تدفق</li>
          <li>حوت بيع مع ضعف طبقات = حذر</li>
        </ul>
      </div>`;
      return;
    }
    p.innerHTML = state.whales.map(cardWhale).join("");
  }

  function renderLayers() {
    const p = els.panels.layers;
    const row = state.selected;
    if (!row) {
      p.innerHTML = `<div class="empty"><p>اختر عملة من تبويب <strong>الفرص</strong> عبر زر «الطبقات» لعرض تفاصيل الـ 7 طبقات.</p></div>`;
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
          <div class="sym">${esc(row.base)}<small>/USDT</small></div>
          <div class="badge ${row.passed >= 5 ? "ok" : "warn"}">${row.passed}/7</div>
        </div>
        <div class="layers-row" style="margin-top:12px">${layerDots(row.layers)}</div>
      </article>
      <div class="layer-detail">${items}</div>
      <div class="actions">
        <a href="https://www.binance.com/ar/trade/${encodeURIComponent(row.base)}_USDT?type=spot" target="_blank" rel="noopener">فتح Binance</a>
        <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(row.symbol)}" target="_blank" rel="noopener">TradingView</a>
      </div>`;
  }

  function renderExit() {
    const p = els.panels.exit;
    if (!state.exits.length) {
      p.innerHTML = `<div class="empty">
        <p><strong>تبويب الخروج</strong> — عملات عليها ضغط توزيع / ضعف بنية.</p>
        <p style="margin-top:10px">يفيد لـ: تجنب الشراء المتأخر، أو مراقبة انعكاس، وليس بالضرورة للبيع القصير.</p>
      </div>`;
      return;
    }
    p.innerHTML = state.exits.map(cardExit).join("");
  }

  function renderAll() {
    renderRadar();
    renderWhales();
    renderLayers();
    renderExit();
  }

  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    Object.entries(els.panels).forEach(([k, el]) => {
      el.hidden = k !== name;
      el.classList.toggle("active", k === name);
    });
  }

  function setStatus(t) { els.status.textContent = t; }
  function showErr(m) { els.err.hidden = false; els.err.textContent = m; }

  // settings
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem("radar-pro-v1") || "{}");
      Object.assign(state.settings, s);
    } catch {}
    els.whaleMin.value = state.settings.whaleMin;
    els.exMajors.checked = state.settings.excludeMajors;
    els.longOnly.checked = state.settings.longOnly;
  }
  function saveSettings() {
    state.settings.whaleMin = +els.whaleMin.value || 25000;
    state.settings.excludeMajors = els.exMajors.checked;
    state.settings.longOnly = els.longOnly.checked;
    localStorage.setItem("radar-pro-v1", JSON.stringify(state.settings));
  }

  // events
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
