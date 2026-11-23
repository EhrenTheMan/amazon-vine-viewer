"use strict";

const $ = (id) => document.getElementById(id);
const defaults = { queue: "encore", pageSize: 24, sort: "recent", interval: 120, scanPages: 5, keywords: "", highlightKeywords: "", categories: "", alertKeywords: false, alertZero: false, alertSound: false, alertDesktop: false, showZero: true, directRequest: false, sharedEtv: false };
const allowedQueues = new Set(["encore", "potluck", "last_chance"]);
const allowedSorts = new Set(["recent", "high", "low"]);
const allowedIntervals = new Set([0, 120, 300, 600, 1800]);
const etvCache = new Map();
const arrivalTrackers = new Map();
const sharedAttempts = new Set();
const eligibleAlerts = new Set();
const sentAlerts = new Set();
let settings = { ...defaults };
let items = [];
let currentPage = 1;
let refreshTimer;
let nextRefreshAt = null;
let scanController;
let etvController;
let lastUpdated = null;
let statusMessage = "";
let scanSummary = "";
let paused = false;
let settingsInvalid = false;

function arrivalTracker(queue) {
  if (!arrivalTrackers.has(queue)) arrivalTrackers.set(queue, VineCore.createArrivalTracker());
  return arrivalTrackers.get(queue);
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function visibleItems() {
  return VineCore.filterItems(items, VineCore.parseKeywords(settings.keywords), settings.showZero, $("search").value);
}

function etvItems() {
  return VineCore.filterItems(items, VineCore.parseKeywords(settings.keywords), settings.showZero);
}

function reportAlertError(message) {
  $("alert-status").textContent = message;
  $("alert-status").hidden = false;
}

async function playAlertSound() {
  const context = new AudioContext();
  let timeout;
  try {
    await Promise.race([
      context.resume(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Audio was blocked. Check Firefox autoplay settings.")), 3000);
      }),
    ]);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.2);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.2);
    await new Promise((resolve) => { oscillator.onended = resolve; });
  } finally {
    clearTimeout(timeout);
    await context.close();
  }
}

function notifyMatches() {
  if (!settings.alertSound && !settings.alertDesktop) return;
  const highlight = VineCore.parseKeywords(settings.highlightKeywords);
  const hidden = VineCore.parseKeywords(settings.keywords);
  const matches = [];
  for (const item of items) {
    const key = `${settings.queue}:${item.asin}`;
    if (!eligibleAlerts.has(key) || VineCore.matchesKeywords(item, hidden)) continue;
    const reasons = [];
    if (settings.alertKeywords && VineCore.matchesKeywords(item, highlight) && !sentAlerts.has(`${key}:keyword`)) reasons.push("keyword");
    if (settings.alertZero && item.etv === 0 && !sentAlerts.has(`${key}:zero`)) reasons.push("$0 ETV");
    if (!reasons.length) continue;
    for (const reason of reasons) sentAlerts.add(`${key}:${reason === "$0 ETV" ? "zero" : reason}`);
    matches.push({ item, reasons });
  }
  if (!matches.length) return;
  if (settings.alertSound) void playAlertSound().catch((error) => reportAlertError(`Could not play alert sound: ${error.message}`));
  if (settings.alertDesktop) {
    const message = matches.length === 1
      ? `${matches[0].item.title} (${matches[0].reasons.join(", ")})`
      : `${matches.length} items matched your alert settings.`;
    void Promise.resolve().then(() => browser.notifications.create({
      type: "basic", iconUrl: browser.runtime.getURL("notification-icon.svg"),
      title: "Vine Viewer", message,
    })).catch((error) => reportAlertError(`Could not show desktop notification: ${error.message}`));
  }
}

function draw() {
  const visible = visibleItems();
  const highlight = VineCore.parseKeywords(settings.highlightKeywords);
  const ordered = VineCore.sortItems(visible, settings.sort);
  const pages = Math.max(1, Math.ceil(ordered.length / settings.pageSize));
  currentPage = Math.min(currentPage, pages);
  const container = $("items");
  container.replaceChildren();
  for (const item of ordered.slice((currentPage - 1) * settings.pageSize, currentPage * settings.pageSize)) {
    const card = document.createElement("article");
    if (arrivalTracker(settings.queue).isArrival(item.asin)) {
      card.classList.add("new-arrival");
      const badge = document.createElement("span");
      badge.className = "arrival-badge";
      badge.textContent = "New arrival";
      card.append(badge);
    }
    if (VineCore.matchesKeywords(item, highlight)) {
      card.classList.add("keyword-match");
      const badge = document.createElement("span");
      badge.className = "keyword-badge";
      badge.textContent = "Keyword match";
      card.append(badge);
    }
    if (item.image) {
      const image = document.createElement("img");
      image.src = item.image;
      image.alt = "";
      image.loading = "lazy";
      card.append(image);
    }
    const link = document.createElement("a");
    link.href = `https://www.amazon.com/dp/${item.asin}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.title;
    const etv = document.createElement("strong");
    etv.textContent = Number.isFinite(item.etv)
      ? `${item.etvSource === "shared" ? "Shared estimate: " : ""}ETV ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(item.etv)}${item.isParent ? " (one variant)" : ""}`
      : item.etvChecked ? "ETV unavailable" : "ETV pending";
    if (item.etvError) etv.title = item.etvError;
    card.append(link, etv);
    const request = document.createElement(settings.directRequest ? "button" : "a");
    if (settings.directRequest) {
      request.type = "button";
      request.addEventListener("click", () => DirectRequest.open(item));
    } else {
      const vineUrl = new URL("https://www.amazon.com/vine/vine-items");
      vineUrl.searchParams.set("queue", item.sourceQueue);
      if (item.sourceCategory) {
        vineUrl.searchParams.set("pn", item.sourceCategory.pn);
        vineUrl.searchParams.set("cn", item.sourceCategory.cn);
      }
      if (item.sourcePage > 1) vineUrl.searchParams.set("page", String(item.sourcePage));
      vineUrl.hash = `vine-viewer-request=${item.asin}`;
      request.href = vineUrl.href;
      request.target = "_blank";
      request.rel = "noopener noreferrer";
    }
    request.className = "request-button";
    request.textContent = settings.directRequest ? "Request product" : "Open Vine request";
    card.append(request);
    container.append(card);
  }
  $("pagination").textContent = `Page ${currentPage} of ${pages} · ${visible.length} visible · ${items.length - visible.length} hidden`;
  $("previous").disabled = currentPage <= 1;
  $("next").disabled = currentPage >= pages;
  $("refresh").disabled = !!scanController;
  $("stop").disabled = paused;
  $("status").textContent = `${lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}. ` : ""}${scanSummary}${statusMessage}`;
}

async function amazonDocument(url, signal) {
  const response = await fetch(url, { credentials: "include", cache: "no-store", signal });
  if (!response.ok) throw new Error(`Amazon returned HTTP ${response.status}.`);
  const finalUrl = new URL(response.url);
  if (finalUrl.hostname !== "www.amazon.com") throw new Error("Amazon redirected away from the expected site.");
  const doc = new DOMParser().parseFromString(await response.text(), "text/html");
  if (finalUrl.pathname.startsWith("/ap/signin") ||
      doc.querySelector('form[action*="validateCaptcha"], #captchacharacters, form[name="signIn"], #ap_signin_form')) {
    throw new Error("Amazon requires sign-in or verification. Open Amazon in Firefox and resolve it before retrying.");
  }
  return doc;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  nextRefreshAt = null;
  if (settings.interval && !paused && !scanController) {
    const seconds = arrivalTracker(settings.queue).fast ? 30 : settings.interval;
    nextRefreshAt = new Date(Date.now() + seconds * 1000);
    refreshTimer = setTimeout(() => void refresh(), seconds * 1000);
  }
  $("next-refresh").textContent = nextRefreshAt
    ? `Next refresh: ${nextRefreshAt.toLocaleTimeString()}.`
    : "Next refresh: not scheduled.";
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function cacheKey(item) {
  return `${item.asin}|${item.recommendationId}`;
}

function restoreCachedEtv(item) {
  const cached = etvCache.get(cacheKey(item));
  if (cached && Date.now() - cached.time < 30 * 60 * 1000) {
    item.etv = cached.etv;
    item.etvChecked = true;
  }
}

class ItemEtvError extends Error {}

async function amazonEtvResponse(path, signal) {
  const response = await fetch(`https://www.amazon.com/vine/api/recommendations/${path}`, {
    credentials: "include", cache: "no-store", signal,
    headers: { accept: "application/json" },
  });
  if ([401, 403, 429].includes(response.status)) throw new Error(`Amazon returned HTTP ${response.status}; sign in or wait before retrying.`);
  if (!response.ok) throw new ItemEtvError(`Amazon returned HTTP ${response.status} for this item.`);
  const finalUrl = new URL(response.url);
  if (finalUrl.hostname !== "www.amazon.com" || !finalUrl.pathname.startsWith("/vine/api/recommendations/")) {
    throw new Error("Amazon redirected the ETV request. Sign in or complete verification in Firefox.");
  }
  const type = response.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("json")) throw new Error("Amazon returned a non-JSON ETV response. Check sign-in or verification.");
  const data = await response.json();
  if (!data || !data.result) throw new ItemEtvError(`Amazon could not provide item details${data?.error?.message ? `: ${data.error.message}` : "."}`);
  return data.result;
}

async function fetchEtv(item, signal) {
  if (!item.recommendationId) throw new ItemEtvError("Amazon did not provide a recommendation ID.");
  const encoded = encodeURIComponent(item.recommendationId);
  let asin = item.asin;
  if (item.isParent) {
    const parent = await amazonEtvResponse(encoded, signal);
    const variants = Array.isArray(parent.variations) ? parent.variations : [];
    asin = variants.find((variant) => /^[A-Z0-9]{10}$/i.test(variant?.asin || ""))?.asin;
    if (!asin) throw new ItemEtvError("Amazon did not provide an available variant.");
    await wait(1000, signal);
    if (signal.aborted) return null;
  }
  const result = await amazonEtvResponse(`${encoded}/item/${asin}?imageSize=180`, signal);
  if (result.asin && String(result.asin).toUpperCase() !== asin.toUpperCase()) {
    throw new ItemEtvError("Amazon returned details for a different item.");
  }
  if (result.taxCurrency && result.taxCurrency !== "USD") throw new ItemEtvError(`Unexpected ETV currency: ${result.taxCurrency}.`);
  const etv = VineCore.parseEtv(result.taxValue);
  if (etv === null) throw new ItemEtvError("Amazon did not provide a valid ETV for this item.");
  return etv;
}

async function loadEtvs(controller) {
  try {
    while (!controller.signal.aborted) {
      let visible = etvItems();
      const candidates = settings.sharedEtv ? visible.filter((entry) => entry.sourceQueue === "encore" &&
        !entry.etvChecked && !sharedAttempts.has(cacheKey(entry))).slice(0, 80) : [];
      if (candidates.length) {
        for (const entry of candidates) sharedAttempts.add(cacheKey(entry));
        try {
          const results = await SharedEtv.lookup(candidates, controller.signal);
          if (controller.signal.aborted) return;
          if (settings.sharedEtv) {
            for (const result of results) {
              for (const entry of items.filter((entry) => entry.sourceQueue === "encore" && !entry.etvChecked &&
                entry.asin === result.asin && entry.isParent === result.parent)) {
                entry.etv = result.cents / 100;
                entry.etvChecked = true;
                entry.etvSource = "shared";
              }
            }
            $("cache-status").hidden = true;
            draw();
            notifyMatches();
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          $("cache-status").textContent = `Shared ETV cache unavailable (${error.message}); using Amazon instead.`;
          $("cache-status").hidden = false;
        }
        visible = etvItems();
        if (settings.sharedEtv && visible.some((entry) => entry.sourceQueue === "encore" &&
            !entry.etvChecked && !sharedAttempts.has(cacheKey(entry)))) continue;
      }
      const item = visible.find((entry) => !entry.etvChecked);
      if (!item) {
        statusMessage = "ETV lookup complete for visible items.";
        draw();
        return;
      }
      statusMessage = `Checking ETV (${visible.filter((entry) => entry.etvChecked).length}/${visible.length})…`;
      draw();
      let etv;
      try {
        etv = await fetchEtv(item, controller.signal);
      } catch (error) {
        if (!(error instanceof ItemEtvError)) throw error;
        if (controller.signal.aborted) return;
        for (const entry of items.filter((entry) => cacheKey(entry) === cacheKey(item))) {
          entry.etvChecked = true;
          entry.etvError = error.message;
        }
        draw();
        await wait(1000, controller.signal);
        continue;
      }
      if (controller.signal.aborted) return;
      for (const entry of items.filter((entry) => cacheKey(entry) === cacheKey(item))) {
        entry.etv = etv;
        entry.etvChecked = true;
        delete entry.etvSource;
        delete entry.etvError;
      }
      etvCache.set(cacheKey(item), { etv, time: Date.now() });
      for (const [key, cached] of etvCache) {
        if (Date.now() - cached.time >= 30 * 60 * 1000) etvCache.delete(key);
      }
      await browser.storage.local.set({ etvCache: Object.fromEntries(etvCache) });
      draw();
      notifyMatches();
      if (settings.sharedEtv && item.sourceQueue === "encore") {
        try {
          await SharedEtv.contribute(item, etv, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          $("cache-status").textContent = `Could not contribute to the shared ETV cache (${error.message}); Amazon lookup succeeded.`;
          $("cache-status").hidden = false;
        }
      }
      await wait(1000, controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    paused = true;
    clearTimeout(refreshTimer);
    nextRefreshAt = null;
    $("next-refresh").textContent = "Next refresh: not scheduled.";
    scanController?.abort();
    scanController = null;
    statusMessage = "ETV lookups and automatic scanning paused.";
    $("scan-progress").textContent = "Scan paused because an ETV lookup failed.";
    showError(`ETV lookup failed: ${error.message} Scan again to retry.`);
    draw();
  } finally {
    if (etvController === controller) etvController = null;
  }
}

function startEtvs() {
  if (paused || etvController || !items.length) return;
  etvController = new AbortController();
  void loadEtvs(etvController);
}

function stop() {
  paused = true;
  clearTimeout(refreshTimer);
  nextRefreshAt = null;
  $("next-refresh").textContent = "Next refresh: not scheduled.";
  scanController?.abort();
  scanController = null;
  etvController?.abort();
  etvController = null;
  statusMessage = "Scanning stopped. Select Scan now to resume.";
  $("scan-progress").textContent = "Scan stopped.";
  draw();
}

async function refresh() {
  if (scanController) return;
  paused = false;
  sharedAttempts.clear();
  clearTimeout(refreshTimer);
  const controller = new AbortController();
  scanController = controller;
  nextRefreshAt = null;
  $("next-refresh").textContent = "Next refresh: waiting for scan to finish.";
  const queue = settings.queue;
  const pageLimit = queue === "encore" ? settings.scanPages : 1;
  const categories = queue === "encore" ? VineCore.parseCategories(settings.categories) : [];
  const scopes = [null, ...categories];
  const scopeKey = JSON.stringify([pageLimit, categories]);
  const scanned = new Map();
  let scannedPages = 0;
  let ended = false;
  scanSummary = "";
  showError("");
  try {
    for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex++) {
      const category = scopes[scopeIndex];
      const scopeName = category ? `favorite category ${scopeIndex} of ${categories.length}` : "all items";
      for (let page = 1; page <= pageLimit; page++) {
        if (scannedPages) await wait(5000, controller.signal);
        if (controller.signal.aborted) return;
        $("scan-progress").textContent = `Scanning ${scopeName}: page ${page} of up to ${pageLimit}; ${scannedPages} total pages completed.`;
        statusMessage = `Scanning Amazon page ${page} of up to ${pageLimit}…`;
        draw();
        const url = new URL("https://www.amazon.com/vine/vine-items");
        url.searchParams.set("queue", queue);
        if (category) {
          url.searchParams.set("pn", category.pn);
          url.searchParams.set("cn", category.cn);
        }
        if (page > 1) url.searchParams.set("page", String(page));
        const doc = await amazonDocument(url.href, controller.signal);
        if (controller.signal.aborted) return;
        const pageItems = VineCore.parseVineDocument(doc);
        const hasNext = queue === "encore" ? VineCore.hasNextPage(doc, queue, page, category) : false;
        for (const item of pageItems) {
          if (!scanned.has(item.asin)) {
            item.sourceQueue = queue;
            item.sourcePage = page;
            item.sourceCategory = category;
            restoreCachedEtv(item);
            scanned.set(item.asin, item);
          }
        }
        scannedPages++;
        items = [...scanned.values()];
        currentPage = Math.min(currentPage, Math.max(1, Math.ceil(visibleItems().length / settings.pageSize)));
        lastUpdated = new Date();
        $("scan-progress").textContent = `Scanned ${scopeName}: ${page} of up to ${pageLimit} pages; ${scannedPages} total pages completed.`;
        statusMessage = `Scanned ${scannedPages} Amazon page${scannedPages === 1 ? "" : "s"}; ${items.length} unique items.`;
        draw();
        startEtvs();
        if (!hasNext) { if (!category) ended = true; break; }
      }
    }
    const arrival = arrivalTracker(queue).complete(items, scopeKey, settings.interval > 0);
    for (const item of items) eligibleAlerts.add(`${queue}:${item.asin}`);
    notifyMatches();
    const arrivalSummary = arrival.baseline ? "Baseline established." : `${arrival.count} new arrival${arrival.count === 1 ? "" : "s"}.`;
    const intervalSummary = arrival.fast ? ` Fast refresh: 30 seconds (${arrival.quietScans}/3 quiet scans).` : "";
    scanSummary = `Scanned ${scannedPages} Amazon page${scannedPages === 1 ? "" : "s"}, ${items.length} unique items${ended && !categories.length ? " (end reached)" : ""}. ${arrivalSummary}${intervalSummary} `;
    $("scan-progress").textContent = `Scan complete: ${scannedPages} total pages across ${scopes.length} ${scopes.length === 1 ? "scope" : "scopes"}.`;
    statusMessage = "Scan complete.";
  } catch (error) {
    if (controller.signal.aborted) return;
    paused = true;
    etvController?.abort();
    etvController = null;
    statusMessage = `Scan stopped after ${scannedPages} Amazon page${scannedPages === 1 ? "" : "s"}; displayed results may be incomplete.`;
    $("scan-progress").textContent = `Scan failed after ${scannedPages} total pages.`;
    showError(`Could not scan Vine results: ${error.message} Scan again to retry.`);
  } finally {
    if (scanController === controller) {
      scanController = null;
      draw();
      scheduleRefresh();
      startEtvs();
    }
  }
}

async function applySettings() {
  const pageSize = Number($("page-size").value);
  const scanPages = Number($("scan-pages").value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isInteger(scanPages) || scanPages < 1 || scanPages > 100) {
    settingsInvalid = true;
    showError("Items per page and pages to scan must be whole numbers from 1 to 100.");
    return;
  }
  try {
    VineCore.parseCategories($("categories").value);
  } catch (error) {
    settingsInvalid = true;
    showError(error.message);
    return;
  }
  if (settingsInvalid) {
    settingsInvalid = false;
    showError("");
  }
  const previous = settings;
  settings = {
    queue: $("queue").value, pageSize, sort: $("sort").value, interval: Number($("interval").value),
    scanPages, keywords: $("keywords").value, highlightKeywords: $("highlight-keywords").value,
    categories: $("categories").value, alertKeywords: $("alert-keywords").checked, alertZero: $("alert-zero").checked,
    alertSound: $("alert-sound").checked, alertDesktop: $("alert-desktop").checked,
    showZero: $("show-zero").checked, directRequest: $("direct-request").checked, sharedEtv: $("shared-etv").checked,
  };
  if (settings.sharedEtv !== previous.sharedEtv) {
    sharedAttempts.clear();
    $("cache-status").hidden = true;
    if (!settings.sharedEtv) {
      for (const item of items.filter((entry) => entry.etvSource === "shared")) {
        delete item.etv;
        delete item.etvSource;
        item.etvChecked = false;
      }
    }
  }
  if (!settings.interval) {
    arrivalTracker(settings.queue).disableFast();
    scanSummary = scanSummary.replace(/ Fast refresh: 30 seconds \(\d\/3 quiet scans\)\./, "");
  }
  currentPage = 1;
  if (settings.queue !== previous.queue) {
    stop();
    items = [];
    lastUpdated = null;
    void refresh();
  } else {
    draw();
    if (settings.interval !== previous.interval) scheduleRefresh();
    startEtvs();
    notifyMatches();
  }
  await browser.storage.local.set({ settings });
}

async function start() {
  const stored = await browser.storage.local.get(["settings", "etvCache"]);
  const saved = stored.settings || {};
  if (stored.etvCache && typeof stored.etvCache === "object") {
    for (const [key, value] of Object.entries(stored.etvCache)) {
      if (value && Number.isFinite(value.etv) && value.etv >= 0 && Number.isFinite(value.time) &&
          Date.now() - value.time >= 0 && Date.now() - value.time < 30 * 60 * 1000) etvCache.set(key, value);
    }
  }
  settings = {
    queue: allowedQueues.has(saved.queue) ? saved.queue : defaults.queue,
    pageSize: Number.isInteger(saved.pageSize) && saved.pageSize >= 1 && saved.pageSize <= 100 ? saved.pageSize : defaults.pageSize,
    sort: allowedSorts.has(saved.sort) ? saved.sort : defaults.sort,
    interval: allowedIntervals.has(saved.interval) ? saved.interval : defaults.interval,
    scanPages: Number.isInteger(saved.scanPages) && saved.scanPages >= 1 && saved.scanPages <= 100 ? saved.scanPages : defaults.scanPages,
    keywords: typeof saved.keywords === "string" ? saved.keywords : defaults.keywords,
    highlightKeywords: typeof saved.highlightKeywords === "string" ? saved.highlightKeywords : defaults.highlightKeywords,
    categories: typeof saved.categories === "string" ? saved.categories : defaults.categories,
    alertKeywords: saved.alertKeywords === true,
    alertZero: saved.alertZero === true,
    alertSound: saved.alertSound === true,
    alertDesktop: saved.alertDesktop === true,
    showZero: typeof saved.showZero === "boolean" ? saved.showZero : defaults.showZero,
    directRequest: typeof saved.directRequest === "boolean" ? saved.directRequest : defaults.directRequest,
    sharedEtv: typeof saved.sharedEtv === "boolean" ? saved.sharedEtv : defaults.sharedEtv,
  };
  VineCore.parseCategories(settings.categories);
  if (settings.alertDesktop && !await browser.permissions.contains({ permissions: ["notifications"] })) {
    settings.alertDesktop = false;
    reportAlertError("Desktop notification permission is unavailable. Enable desktop notifications again to request permission.");
  }
  $("queue").value = settings.queue;
  $("page-size").value = settings.pageSize;
  $("sort").value = settings.sort;
  $("interval").value = settings.interval;
  $("scan-pages").value = settings.scanPages;
  $("keywords").value = settings.keywords;
  $("highlight-keywords").value = settings.highlightKeywords;
  $("categories").value = settings.categories;
  $("alert-keywords").checked = settings.alertKeywords;
  $("alert-zero").checked = settings.alertZero;
  $("alert-sound").checked = settings.alertSound;
  $("alert-desktop").checked = settings.alertDesktop;
  $("show-zero").checked = settings.showZero;
  $("direct-request").checked = settings.directRequest;
  $("shared-etv").checked = settings.sharedEtv;
  $("settings").addEventListener("change", (event) => {
    if (event.target.id === "alert-desktop") return;
    void applySettings().catch((error) => showError(`Could not save settings: ${error.message}`));
  });
  $("alert-desktop").addEventListener("change", () => {
    const checkbox = $("alert-desktop");
    const permission = checkbox.checked
      ? browser.permissions.request({ permissions: ["notifications"] })
      : Promise.resolve(true);
    void permission.then((granted) => {
      if (!granted) {
        checkbox.checked = false;
        reportAlertError("Desktop notification permission was not granted.");
      } else {
        $("alert-status").hidden = true;
      }
      return applySettings();
    }).catch((error) => {
      checkbox.checked = false;
      reportAlertError(`Could not enable desktop notifications: ${error.message}`);
    });
  });
  $("settings").addEventListener("submit", (event) => event.preventDefault());
  $("search").addEventListener("input", () => { currentPage = 1; draw(); });
  $("refresh").addEventListener("click", () => void refresh());
  $("stop").addEventListener("click", stop);
  $("previous").addEventListener("click", () => { currentPage--; draw(); });
  $("next").addEventListener("click", () => { currentPage++; draw(); });
  await refresh();
}

start().catch((error) => showError(`Could not start viewer: ${error.message}`));
