"use strict";

const preview = document.querySelector(".product-shot");
const image = preview.querySelector("img");

function updatePreview() {
  const loaded = image.naturalWidth > 0;
  preview.classList.toggle("is-loaded", loaded);
  preview.classList.toggle("has-error", !loaded);
}

image.addEventListener("load", updatePreview);
image.addEventListener("error", updatePreview);
if (image.complete) updatePreview();
