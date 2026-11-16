(function (root) {
  "use strict";

  const queueTypes = { encore: "VINE_FOR_ALL", potluck: "VENDOR_TARGETED", last_chance: "VENDOR_VINE_FOR_ALL" };

  function variantLabel(variant) {
    const dimensions = variant.dimensions;
    let parts = [];
    if (Array.isArray(dimensions)) {
      parts = dimensions.map((entry) => typeof entry === "string" ? entry :
        `${entry?.name || entry?.key || entry?.dimensionName || ""}: ${entry?.value || entry?.dimensionValue || ""}`);
    } else if (dimensions && typeof dimensions === "object") {
      parts = Object.entries(dimensions).map(([name, value]) => `${name}: ${value}`);
    }
    return [...parts.filter(Boolean), variant.asin].join(" — ");
  }

  function checkedDetails(result, asin, parseEtv) {
    const etv = parseEtv(result?.taxValue);
    if (String(result?.asin || "").toUpperCase() !== asin || result?.taxCurrency !== "USD" ||
        etv === null || typeof result.promotionId !== "string" || !result.promotionId ||
        result.purchasePolicyCode !== "AmazonVine" || typeof result.productTitle !== "string" || !result.productTitle.trim()) {
      throw new Error("Amazon did not provide complete, matching details for this variant. Open the request on Amazon instead.");
    }
    return { asin, etv, title: result.productTitle, promotionId: result.promotionId, purchasePolicyCode: result.purchasePolicyCode };
  }

  function csrfFromDocument(doc) {
    for (const script of doc.querySelectorAll("script[data-a-state]")) {
      let state;
      try { state = JSON.parse(script.getAttribute("data-a-state")); } catch { continue; }
      if (state?.key !== "vvp-context") continue;
      const context = JSON.parse(script.textContent);
      if (typeof context?.csrfToken === "string" && context.csrfToken) return context.csrfToken;
      break;
    }
    throw new Error("Amazon did not provide a request token. Sign in and try again.");
  }

  function checkoutFields(asin, details, payload) {
    if (payload?.error || payload?.result?.proceedToCheckout !== true ||
        typeof payload.result.offerListingId !== "string" || !payload.result.offerListingId ||
        payload.result.orderId != null || payload.result.legacyOrderId != null) {
      throw new Error("Amazon did not return a usable checkout. Check your Vine orders before trying again.");
    }
    return [
      ["skipCart", "1"], ["quantity", "1"], ["asin", asin],
      ["offerListingID", payload.result.offerListingId],
      ["vinePromotionId", details.promotionId], ["vinePurchasePolicyCode", details.purchasePolicyCode],
    ];
  }

  const helpers = { variantLabel, checkedDetails, csrfFromDocument, checkoutFields };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
    return;
  }

  const el = (id) => document.getElementById(id);
  const dialog = el("request-dialog");
  const variants = el("request-variants");
  const confirm = el("request-confirm");
  const cancel = el("request-cancel");
  const attempted = new Set();
  let item;
  let selectedDetails;
  let selectedRecommendationId;
  let generation = 0;
  let busy = false;

  function error(message) {
    el("request-error").textContent = message;
    el("request-error").hidden = !message;
  }

  async function loadDetails(asin) {
    const current = ++generation;
    selectedDetails = null;
    confirm.disabled = true;
    error("");
    el("request-details").textContent = "Loading current variant details and ETV…";
    try {
      const encoded = encodeURIComponent(selectedRecommendationId);
      const result = await amazonEtvResponse(`${encoded}/item/${asin}?imageSize=180`);
      if (current !== generation || !dialog.open) return;
      selectedDetails = { ...checkedDetails(result, asin, VineCore.parseEtv), loadedAt: Date.now() };
      el("request-details").textContent = `${selectedDetails.title} (${asin}) — ETV ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(selectedDetails.etv)}. ETV may affect your taxes and can change.`;
      confirm.disabled = attempted.has(item.asin);
      if (confirm.disabled) error("A request was already attempted for this item in this viewer session. Check your Vine orders before trying again.");
    } catch (err) {
      if (current === generation && dialog.open) {
        el("request-details").textContent = "";
        error(`Could not load request details: ${err.message}`);
      }
    }
  }

  async function open(chosen) {
    if (dialog.open) return;
    item = chosen;
    selectedDetails = null;
    selectedRecommendationId = chosen.recommendationId;
    generation++;
    error("");
    el("request-product").textContent = chosen.title;
    el("request-details").textContent = "";
    el("request-variants-label").hidden = true;
    variants.replaceChildren();
    confirm.disabled = true;
    cancel.disabled = false;
    cancel.textContent = "Cancel";
    variants.disabled = false;
    dialog.showModal();
    if (!chosen.recommendationId || !queueTypes[chosen.sourceQueue] || chosen.isPreRelease) {
      error(chosen.isPreRelease ? "Pre-release items must be requested on Amazon. Turn off direct requests to open Amazon's prompt." : "This item is missing request information. Open the request on Amazon instead.");
      return;
    }
    if (!chosen.isParent) {
      await loadDetails(chosen.asin);
      return;
    }
    const current = generation;
    el("request-details").textContent = "Loading variants…";
    try {
      const result = await amazonEtvResponse(encodeURIComponent(chosen.recommendationId));
      if (current !== generation || !dialog.open) return;
      const choices = Array.isArray(result.variations) ? result.variations.filter((v) => /^[A-Z0-9]{10}$/.test(v?.asin || "")) : [];
      if (!choices.length) throw new Error("Amazon did not provide selectable variants.");
      if (result.recommendationId !== undefined) {
        if (typeof result.recommendationId !== "string" || !result.recommendationId) throw new Error("Amazon returned an invalid recommendation ID.");
        selectedRecommendationId = result.recommendationId;
      }
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select a variant";
      variants.append(placeholder);
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.asin;
        option.textContent = variantLabel(choice);
        variants.append(option);
      }
      el("request-variants-label").hidden = false;
      el("request-details").textContent = "Select a variant to review its ETV.";
    } catch (err) {
      if (current === generation && dialog.open) {
        el("request-details").textContent = "";
        error(`Could not load variants: ${err.message}`);
      }
    }
  }

  variants.addEventListener("change", () => {
    if (variants.value) void loadDetails(variants.value);
    else {
      generation++;
      selectedDetails = null;
      confirm.disabled = true;
      el("request-details").textContent = "Select a variant to review its ETV.";
      error("");
    }
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { generation++; });

  confirm.addEventListener("click", async () => {
    if (busy || !selectedDetails || attempted.has(item.asin)) return;
    if (Date.now() - selectedDetails.loadedAt > 120000) {
      selectedDetails = null;
      confirm.disabled = true;
      error("These details have expired. Close this dialog and reopen the item to review its current ETV.");
      return;
    }
    const target = `vine_checkout_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tab = window.open("about:blank", target);
    if (!tab) {
      error("The checkout tab was blocked. Allow popups and try again.");
      return;
    }
    busy = true;
    confirm.disabled = true;
    cancel.disabled = true;
    variants.disabled = true;
    error("");
    let sent = false;
    try {
      el("request-details").textContent = "Preparing request…";
      const url = new URL("https://www.amazon.com/vine/vine-items");
      url.searchParams.set("queue", item.sourceQueue);
      const doc = await amazonDocument(url.href);
      const token = csrfFromDocument(doc);
      attempted.add(item.asin);
      sent = true;
      el("request-details").textContent = "Sending request to Amazon…";
      const response = await fetch("https://www.amazon.com/vine/api/voiceOrders", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json", "anti-csrftoken-a2z": token },
        body: JSON.stringify({ recommendationId: selectedRecommendationId, recommendationType: queueTypes[item.sourceQueue], itemAsin: selectedDetails.asin }),
      });
      if (!response.ok || response.redirected || !response.headers.get("content-type")?.toLowerCase().includes("json")) {
        throw new Error(`Amazon returned an unexpected response (HTTP ${response.status}).`);
      }
      const fields = checkoutFields(selectedDetails.asin, selectedDetails, await response.json());
      if (tab.closed) throw new Error("The checkout tab was closed.");
      const form = document.createElement("form");
      form.method = "post";
      form.action = "https://www.amazon.com/checkout/entry/buynow?pipelineType=Chewbacca";
      form.target = target;
      for (const [name, value] of fields) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      try { form.submit(); } finally { form.remove(); }
      el("request-details").textContent = "Checkout was opened in the other tab. This does not confirm an order; check Amazon for its status.";
    } catch (err) {
      tab.close();
      el("request-details").textContent = "";
      error(sent ? `Request outcome is unknown: ${err.message} Check your Vine orders before trying again.` : `Request was not sent: ${err.message}`);
    } finally {
      busy = false;
      cancel.disabled = false;
      cancel.textContent = sent ? "Close" : "Cancel";
      variants.disabled = false;
      confirm.disabled = sent || !selectedDetails;
    }
  });

  root.DirectRequest = { open };
})(globalThis);
