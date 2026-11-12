/**
 * رادار الخروج — نسخة GitHub Pages
 * بيانات عامة من Binance (data-api + api) بدون مفاتيح
 */
(() => {
  "use strict";

  // ─── API hosts (CORS-friendly public) ───────────────────────────
  const HOSTS = [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
  ];

  // Stable / fiat / leveraged junk to skip
  const SKIP_BASE = new Set([
    "USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "AEUR", "EURI",
    "USD1", "USDE", "BFUSD", "USDS", "RLUSD", "GUSD", "USDG", "USTC", "USDD",
  ]);
  const SKIP_SUFFIX = /(UP|DOWN|BULL|BEAR)$/;
  const MAJORS = new Set(["BTC", "ETH"]);

  const STORAGE_KEY = "radar-exit-settings-v1";

  // ─── State ──────────────────────────────────────────────────────
  const state = {
    horizon: 30, // 30 | 90 days
    scanning: false,
    abort: null,
    weights: { dist: 25, struct: 25, mom: 25, vol: 25 },
    excludeMajors: true,
  };

  // ─── DOM ────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"),
    btnScan: $("btn-scan"),
    btnStop: $("btn-stop"),
    progressWrap: $("progress-wrap"),
    progressFill: $("progress-fill"),
    progressText: $("progress-text"),
    errorBox: $("error-box"),
    results: $("results"),
    empty: $("empty"),
    minVolume: $("min-volume"),
    maxResults: $("max-results"),
    sheet: $("settings-sheet"),
    overlay: $("sheet-overlay"),
    btnSettings: $("btn-settings"),
    btnCloseSettings: $("btn-close-settings"),
    wDist: $("w-dist"),
    wStruct: $("w-struct"),
    wMom: $("w-mom"),
    wVol: $("w-vol"),
    wDistOut: $("w-dist-out"),
    wStructOut: $("w-struct-out"),
    wMomOut: $("w-mom-out"),
    wVolOut: $("w-vol-out"),
    excludeMajors: $("exclude-majors"),
    btnReset: $("btn-reset-weights"),
  };

  // ─── Utils ──────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function fmtPct(x) {
    if (x == null || Number.isNaN(x)) return "—";
    const s = (x * 100).toFixed(1);
    return (x >= 0 ? "+" : "") + s + "%";
  }

  function fmtVol(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
    return String(Math.round(n));
  }

  function sma(arr, len) {
    if (arr.length < len) return null;
    let s = 0;
    for (let i = arr.length - len; i < arr.length; i++) s += arr[i];
    return s / len;
  }

  function slope(arr, lookback) {
    if (arr.length < lookback + 1) return 0;
    const a = arr[arr.length - 1 - lookback];
    const b = arr[arr.length - 1];
    if (!a) return 0;
    return (b - a) / a;
  }

  // ─── Fetch with host fallback + retry/backoff ───────────────────
  async function fetchJson(path, { signal, retries = 3 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      for (const host of HOSTS) {
        try {
          const res = await fetch(host + path, {
            signal,
            headers: { Accept: "application/json" },
          });
          if (res.status === 429) {
            lastErr = new Error("تم تجاوز حد الطلبات (429). انتظر قليلاً.");
            await sleep(800 * (attempt + 1));
            continue;
          }
          if (!res.ok) {
            lastErr = new Error(`HTTP ${res.status} من ${host}`);
            continue;
          }
          return await res.json();
        } catch (e) {
          if (e.name === "AbortError") throw e;
          lastErr = e;
        }
      }
      await sleep(400 * (attempt + 1));
    }
    throw lastErr || new Error("فشل الاتصال بـ Binance");
  }

  async function fetchKlines(symbol, interval, limit, signal) {
    const path = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const raw = await fetchJson(path, { signal });
    return raw.map((c) => ({
      t: c[0],
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
      quoteVol: +c[7],
    }));
  }

  // ─── Universe: all liquid USDT pairs ────────────────────────────
  async function loadUniverse(minQuoteVol, signal) {
    const data = await fetchJson("/api/v3/ticker/24hr", { signal });
    const pairs = [];
    for (const t of data) {
      const sym = t.symbol;
      if (!sym.endsWith("USDT")) continue;
      const base = sym.slice(0, -4);
      if (SKIP_BASE.has(base)) continue;
      if (SKIP_SUFFIX.test(base)) continue;
      if (/^\d/.test(base)) continue;
      const qv = +t.quoteVolume;
      if (!(qv >= minQuoteVol)) continue;
      pairs.push({
        symbol: sym,
        base,
        price: +t.lastPrice,
        change24h: +t.priceChangePercent / 100,
        quoteVolume: qv,
      });
    }
    pairs.sort((a, b) => b.quoteVolume - a.quoteVolume);
    return pairs;
  }

  // ─── Scoring: «خروج / خيانة المستثمرين» ─────────────────────────
  /**
   * Higher score = stronger distribution / exit pressure on chosen horizon.
   * Uses daily + weekly structure.
   */
  function scoreExit(daily, weekly, horizon, weights) {
    const closesD = daily.map((c) => c.close);
    const volsD = daily.map((c) => c.quoteVol);
    const closesW = weekly.map((c) => c.close);
    const volsW = weekly.map((c) => c.quoteVol);

    const signals = [];
    let dist = 0;
    let struct = 0;
    let mom = 0;
    let volScore = 0;

    const look = horizon === 90 ? 90 : 30;
    const dLen = closesD.length;

    // --- Distribution: near local high while volume fades ---
    if (dLen >= look) {
      const window = closesD.slice(-look);
      const hi = Math.max(...window);
      const last = closesD[dLen - 1];
      const fromHigh = hi > 0 ? (hi - last) / hi : 0;
      // still elevated if within ~12% of local high
      const elevated = fromHigh <= 0.12;

      const volRecent = volsD.slice(-7);
      const volPrev = volsD.slice(-21, -7);
      const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
      const vr = avg(volRecent);
      const vp = avg(volPrev);
      const volFade = vp > 0 && vr < vp * 0.75;

      if (elevated && volFade) {
        dist += 35;
        signals.push({ t: "توزيع", label: "قرب القمة + ضعف حجم", warn: false });
      } else if (elevated) {
        dist += 15;
        signals.push({ t: "قرب قمة", label: "السعر مرتفع محلياً", warn: true });
      } else if (volFade) {
        dist += 10;
      }

      // failed push: recent high not sustained
      const last5 = closesD.slice(-5);
      const prev10 = closesD.slice(-15, -5);
      if (prev10.length && Math.max(...last5) < Math.max(...prev10) * 0.98) {
        dist += 15;
        signals.push({ t: "فشل صعود", label: "قمة أدنى من السابقة", warn: false });
      }
    }

    // --- Structure break: below SMAs ---
    const sma20d = sma(closesD, 20);
    const sma50d = sma(closesD, 50);
    const lastD = closesD[closesD.length - 1];
    if (sma20d && lastD < sma20d) {
      struct += 15;
      signals.push({ t: "تحت SMA20", label: "كسر المتوسط 20 يوم", warn: true });
    }
    if (sma50d && lastD < sma50d) {
      struct += 20;
      signals.push({ t: "تحت SMA50", label: "كسر المتوسط 50 يوم", warn: false });
    }
    if (sma20d && sma50d && sma20d < sma50d) {
      struct += 10; // death cross zone
    }

    const sma10w = sma(closesW, 10);
    const lastW = closesW[closesW.length - 1];
    if (sma10w && lastW < sma10w) {
      struct += 20;
      signals.push({ t: "أسبوعي ضعيف", label: "تحت متوسط 10 أسابيع", warn: false });
    }

    // lower highs on weekly
    if (closesW.length >= 8) {
      const w1 = Math.max(...closesW.slice(-4));
      const w0 = Math.max(...closesW.slice(-8, -4));
      if (w1 < w0 * 0.97) {
        struct += 15;
        signals.push({ t: "قمم هابطة", label: "قمم أسبوعية هابطة", warn: false });
      }
    }

    // --- Momentum ---
    const chg30 = slope(closesD, Math.min(30, dLen - 1));
    const chg90 = slope(closesD, Math.min(90, dLen - 1));
    const chgHorizon = horizon === 90 ? chg90 : chg30;
    if (chgHorizon < -0.15) {
      mom += 30;
      signals.push({ t: "زخم هابط", label: fmtPct(chgHorizon) + " على الأفق", warn: false });
    } else if (chgHorizon < -0.05) {
      mom += 15;
      signals.push({ t: "زخم سلبي", label: fmtPct(chgHorizon), warn: true });
    }
    if (chg30 < 0 && chg90 < 0) mom += 10;

    // RSI-ish rough: % of closes up in last 14
    if (dLen >= 15) {
      let up = 0;
      for (let i = dLen - 14; i < dLen; i++) {
        if (closesD[i] >= closesD[i - 1]) up++;
      }
      const strength = up / 14;
      if (strength <= 0.35) {
        mom += 15;
        signals.push({ t: "ضغط بيع", label: "أيام هابطة مسيطرة", warn: false });
      }
    }

    // --- Volume trend (participation leaving) ---
    if (volsW.length >= 8) {
      const recentW = volsW.slice(-4);
      const olderW = volsW.slice(-8, -4);
      const ar = recentW.reduce((s, x) => s + x, 0) / 4;
      const ao = olderW.reduce((s, x) => s + x, 0) / 4;
      if (ao > 0 && ar < ao * 0.7) {
        volScore += 30;
        signals.push({ t: "هجر حجم", label: "تراجع حجم أسبوعي حاد", warn: false });
      } else if (ao > 0 && ar < ao * 0.85) {
        volScore += 15;
        signals.push({ t: "ضعف حجم", label: "تراجع اهتمام", warn: true });
      }
    }

    // normalize component scores 0–100 then weighted
    const clamp = (x) => Math.max(0, Math.min(100, x));
    const cDist = clamp(dist);
    const cStruct = clamp(struct);
    const cMom = clamp(mom);
    const cVol = clamp(volScore);

    const wSum = weights.dist + weights.struct + weights.mom + weights.vol || 1;
    const total =
      (cDist * weights.dist +
        cStruct * weights.struct +
        cMom * weights.mom +
        cVol * weights.vol) /
      wSum;

    // dedupe signal labels
    const seen = new Set();
    const uniq = [];
    for (const s of signals) {
      if (seen.has(s.t)) continue;
      seen.add(s.t);
      uniq.push(s);
    }

    return {
      score: Math.round(total * 10) / 10,
      change30: chg30,
      change90: chg90,
      fromHigh30:
        dLen >= 30
          ? (Math.max(...closesD.slice(-30)) - lastD) / Math.max(...closesD.slice(-30))
          : null,
      signals: uniq.slice(0, 5),
    };
  }

  // ─── Concurrent pool ────────────────────────────────────────────
  async function mapPool(items, concurrency, fn, onProgress) {
    const out = new Array(items.length);
    let i = 0;
    let done = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          out[idx] = { error: e };
        }
        done++;
        onProgress?.(done, items.length);
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return out;
  }

  // ─── Main scan ──────────────────────────────────────────────────
  async function runScan() {
    if (state.scanning) return;
    state.scanning = true;
    state.abort = new AbortController();
    const { signal } = state.abort;

    els.btnScan.disabled = true;
    els.btnStop.hidden = false;
    els.errorBox.hidden = true;
    els.errorBox.textContent = "";
    els.progressWrap.hidden = false;
    els.progressFill.style.width = "0%";
    els.empty?.remove();
    els.results.innerHTML = "";
    setStatus("جلب قائمة الأزواج…");

    try {
      const minVol = +els.minVolume.value;
      const maxResults = +els.maxResults.value;
      const universe = await loadUniverse(minVol, signal);

      if (!universe.length) {
        throw new Error("لا توجد أزواج USDT تحقق حد السيولة المختار.");
      }

      // Cap analysis candidates to keep rate limits safe
      // Take top by volume, then analyze up to ~80
      let candidates = universe.slice(0, 80);
      if (state.excludeMajors) {
        candidates = candidates.filter((p) => !MAJORS.has(p.base));
      }

      setStatus(`تحليل ${candidates.length} زوجاً (من ${universe.length} سائل)…`);

      const dailyLimit = state.horizon === 90 ? 120 : 60;
      const weeklyLimit = 52;

      const analyzed = await mapPool(
        candidates,
        4, // concurrency — stay gentle on Binance
        async (pair) => {
          const [daily, weekly] = await Promise.all([
            fetchKlines(pair.symbol, "1d", dailyLimit, signal),
            fetchKlines(pair.symbol, "1w", weeklyLimit, signal),
          ]);
          // small jitter to spread load
          await sleep(40 + Math.random() * 80);
          const scored = scoreExit(daily, weekly, state.horizon, state.weights);
          return { ...pair, ...scored };
        },
        (done, total) => {
          const pct = Math.round((done / total) * 100);
          els.progressFill.style.width = pct + "%";
          els.progressText.textContent = `تحليل ${done} / ${total}`;
        }
      );

      const ok = analyzed
        .filter((x) => x && !x.error && x.score != null)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      if (!ok.length) {
        els.results.innerHTML =
          '<div class="empty"><p>لم تظهر إشارات خروج قوية ضمن العتبات الحالية. جرّب خفض حد السيولة أو تعديل الأوزان.</p></div>';
        setStatus("انتهى — بدون نتائج");
      } else {
        renderResults(ok);
        setStatus(`تم — ${ok.length} نتيجة مرتبة حسب قوة الخروج`);
      }
    } catch (e) {
      if (e.name === "AbortError") {
        setStatus("تم الإيقاف");
      } else {
        showError(
          (e && e.message) ||
            "فشل الاتصال ببيانات Binance. تحقق من الشبكة ثم أعد المحاولة."
        );
        setStatus("خطأ في الاتصال");
      }
    } finally {
      state.scanning = false;
      state.abort = null;
      els.btnScan.disabled = false;
      els.btnStop.hidden = true;
      els.progressWrap.hidden = true;
    }
  }

  function renderResults(list) {
    const frag = document.createDocumentFragment();
    for (const row of list) {
      const scoreClass =
        row.score >= 55 ? "" : row.score >= 35 ? "mid" : "low";
      const chg = state.horizon === 90 ? row.change90 : row.change30;
      const chgClass = chg < 0 ? "neg" : chg > 0 ? "pos" : "";

      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `
        <div class="card-top">
          <div>
            <span class="sym">${escapeHtml(row.base)}<span style="color:var(--muted);font-weight:500">/USDT</span></span>
            <span class="base-name">${escapeHtml(row.symbol)}</span>
          </div>
          <div class="score-badge ${scoreClass}" title="درجة خروج المستثمرين">خروج ${row.score}</div>
        </div>
        <div class="meta">
          <div class="meta-item">
            <span class="lbl">التغيّر ${state.horizon === 90 ? "90ي" : "30ي"}</span>
            <span class="val ${chgClass}">${fmtPct(chg)}</span>
          </div>
          <div class="meta-item">
            <span class="lbl">حجم 24س</span>
            <span class="val">${fmtVol(row.quoteVolume)}</span>
          </div>
          <div class="meta-item">
            <span class="lbl">السعر</span>
            <span class="val">${formatPrice(row.price)}</span>
          </div>
          <div class="meta-item">
            <span class="lbl">من قمة ${state.horizon === 90 ? "3ش" : "شهر"}</span>
            <span class="val">${row.fromHigh30 != null ? fmtPct(-row.fromHigh30).replace("+", "−") : "—"}</span>
          </div>
        </div>
        <div class="signals">
          ${row.signals
            .map(
              (s) =>
                `<span class="chip ${s.warn ? "warn" : ""}" title="${escapeHtml(s.label)}">${escapeHtml(s.t)}</span>`
            )
            .join("")}
        </div>
        <div class="card-actions">
          <a href="https://www.binance.com/ar/trade/${encodeURIComponent(row.base)}_USDT?type=spot" target="_blank" rel="noopener">Binance</a>
          <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(row.symbol)}" target="_blank" rel="noopener">TradingView</a>
        </div>
      `;
      frag.appendChild(card);
    }
    els.results.innerHTML = "";
    els.results.appendChild(frag);
  }

  function formatPrice(p) {
    if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
    return p.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setStatus(t) {
    els.status.textContent = t;
  }

  function showError(msg) {
    els.errorBox.hidden = false;
    els.errorBox.textContent = msg;
  }

  // ─── Settings persistence ───────────────────────────────────────
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.weights) state.weights = { ...state.weights, ...s.weights };
      if (typeof s.excludeMajors === "boolean") state.excludeMajors = s.excludeMajors;
      if (s.horizon === 30 || s.horizon === 90) state.horizon = s.horizon;
    } catch (_) {}
  }

  function saveSettings() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        weights: state.weights,
        excludeMajors: state.excludeMajors,
        horizon: state.horizon,
      })
    );
  }

  function syncWeightUI() {
    els.wDist.value = state.weights.dist;
    els.wStruct.value = state.weights.struct;
    els.wMom.value = state.weights.mom;
    els.wVol.value = state.weights.vol;
    els.wDistOut.textContent = state.weights.dist;
    els.wStructOut.textContent = state.weights.struct;
    els.wMomOut.textContent = state.weights.mom;
    els.wVolOut.textContent = state.weights.vol;
    els.excludeMajors.checked = state.excludeMajors;
  }

  function openSheet() {
    els.sheet.hidden = false;
    els.overlay.hidden = false;
  }
  function closeSheet() {
    els.sheet.hidden = true;
    els.overlay.hidden = true;
    saveSettings();
  }

  // ─── Events ─────────────────────────────────────────────────────
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.horizon = +tab.dataset.horizon;
      saveSettings();
    });
  });

  els.btnScan.addEventListener("click", () => runScan());
  els.btnStop.addEventListener("click", () => {
    state.abort?.abort();
  });

  els.btnSettings.addEventListener("click", openSheet);
  els.btnCloseSettings.addEventListener("click", closeSheet);
  els.overlay.addEventListener("click", closeSheet);

  function bindWeight(input, out, key) {
    input.addEventListener("input", () => {
      state.weights[key] = +input.value;
      out.textContent = input.value;
    });
  }
  bindWeight(els.wDist, els.wDistOut, "dist");
  bindWeight(els.wStruct, els.wStructOut, "struct");
  bindWeight(els.wMom, els.wMomOut, "mom");
  bindWeight(els.wVol, els.wVolOut, "vol");

  els.excludeMajors.addEventListener("change", () => {
    state.excludeMajors = els.excludeMajors.checked;
  });

  els.btnReset.addEventListener("click", () => {
    state.weights = { dist: 25, struct: 25, mom: 25, vol: 25 };
    state.excludeMajors = true;
    syncWeightUI();
    saveSettings();
  });

  // ─── SW registration (optional, same origin / GH Pages) ─────────
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  // Init
  loadSettings();
  syncWeightUI();
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", +tab.dataset.horizon === state.horizon);
  });
})();
