"use strict";

(() => {
  const match = location.hash.match(/^#vine-viewer-request=([A-Z0-9]{10})$/);
  if (!match) return;
  const asin = match[1];
  history.replaceState(history.state, "", location.pathname + location.search);

  function banner(message, button) {
    const notice = document.createElement("div");
    notice.setAttribute("role", "status");
    Object.assign(notice.style, {
      position: "relative",
      zIndex: "9999",
      padding: "12px",
      background: "#fff3cd",
      color: "#292000",
      font: "16px sans-serif",
    });
    notice.append(document.createTextNode(`Vine Viewer: ${message} `));
    if (button) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Open details again";
      retry.addEventListener("click", () => button.click());
      notice.append(retry);
    }
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => notice.remove());
    notice.append(dismiss);
    document.body.prepend(notice);
  }

  function openDetails() {
    const buttons = document.querySelectorAll("#vvp-items-grid .vvp-item-tile .vvp-details-btn input[data-asin]");
    const button = [...buttons].find((candidate) => candidate.dataset.asin === asin);
    if (!button) {
      banner("The item is no longer on this page or Amazon requires sign-in. Return to the viewer and scan again; no order was placed.");
      return;
    }
    button.click();
    banner("Attempted to open Amazon's item details. If the prompt did not open, use the button below. No order has been placed.", button);
  }

  if (document.readyState === "complete") {
    setTimeout(openDetails, 750);
  } else {
    window.addEventListener("load", () => setTimeout(openDetails, 750), { once: true });
  }
})();
