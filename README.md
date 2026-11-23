# Vine Viewer

A small Firefox extension that opens a separate viewer for your Amazon.com Vine items. It does not use VHelper's servers. The optional shared ETV cache uses a separate Cloudflare service.

## Install

1. Download the repository using GitHub's **Code > Download ZIP**, then extract it.
2. Sign in to your Vine account at [Amazon.com](https://www.amazon.com/vine/vine-items) in Firefox.
3. Visit `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the extracted folder's `manifest.json`.
4. Click the Vine Viewer toolbar button. Keep its tab open while using automatic refresh.

Temporary Firefox add-ons must be loaded again after Firefox restarts. Amazon may require you to sign in or complete a verification challenge. The viewer stops on request errors; resolve the problem in Amazon and use **Scan now**.

By default, each item's **Open Vine request** button opens the Amazon queue page where it was found and attempts to open Amazon's own details prompt. Choose variants and confirm any request on Amazon. If the item moved or disappeared, the page displays a message and you can return to the viewer to rescan. If the prompt does not open automatically, use the retry button or Amazon's own **See details** button.

The optional **Request product from viewer** setting changes that button to **Request product**. Select a variant if needed and review its freshly retrieved ETV before explicitly confirming. Details expire after two minutes; reopen the item to review them again. Confirmation sends a request to Amazon and opens Amazon checkout; checkout may complete an order, so check the delivery address and your Vine orders. ETV may have tax consequences and can change. Pre-release items must use Amazon's prompt instead. If the request fails after submission, the outcome may be unknown: check your Vine orders before attempting again. The viewer prevents a repeat attempt for the same listing during the current tab session, but this protection does not persist across reloads or tabs. Direct requests depend on undocumented Amazon behavior and have not been verified with a live authenticated order.

## How it works

For Additional Items, the viewer scans a configurable number of Amazon pages (1–100, default 5), starting at page 1, with a five-second pause between requests. Changes to the page limit take effect at the start of the next scan. It stops early when Amazon reports the end. Results are combined in Amazon's page order and deduplicated by ASIN. Other queues still load only their first Amazon page. The viewer's separate **Items per page** setting controls display pagination, not Amazon's page size.

Enter words or phrases separated by commas or new lines in **Hide titles containing**. Matching is case-insensitive and uses literal substrings. Filtering is local and reversible, does not hide anything on Amazon, and excludes keyword-hidden items from ETV lookups. Settings persist in Firefox.

**Search scanned titles or ASIN** filters the current results as you type without limiting ETV lookups. **Highlight titles containing** accepts the same literal keyword format and marks matching cards; hiding a title takes precedence. Neither search nor highlighting changes the discovery count.

To scan favorite categories as well as the regular Additional Items pages, paste one full Amazon.com Additional Items category URL per line into **Favorite Additional Items category URLs**. Each URL must contain the numeric `pn` and `cn` parameters; open a subcategory on Amazon and copy its address. Favorites are scanned after the regular pages, with the selected page limit applied separately to each. Pages are deduplicated by ASIN and each item retains the page and category needed for the Amazon request handoff. Five-second pauses also apply between categories. Other queues ignore favorites. Editing favorites or the page limit establishes a new arrival baseline on the next completed scan.

Alerts are off by default. Choose keyword matches and/or $0 ETV, then enable sound and/or desktop notifications. Desktop notifications require optional Firefox permission. The initial completed scan is eligible for alerts, but not new-arrival highlighting. Alerts also apply to items discovered later and are sent at most once per item and alert type per queue during the viewer tab's lifetime; a $0 ETV alert can arrive later when its value is retrieved. Keyword-hidden items do not alert; search does not limit alerts. Shared estimates can trigger $0 alerts and are unverified. Alert failures are shown in the viewer. Keep the tab open; alerts do not run in the background when it is closed.

After a scan completes, the refresh interval controls the wait before a new scan starts at page 1; Off disables repetition. **Stop** cancels the scan, ETV lookups, and repeat timer until **Scan now** is selected. Scanned pages appear as they arrive. A new scan replaces the previous results as pages arrive; this is not a historical feed, and changes to Amazon's listings during a scan can cause skipped items or duplicates. On errors, automatic scanning pauses and any completed pages remain visible with an incomplete-results warning.

Scan progress reports the current scope and page and total pages completed. The next-refresh time is shown once the scan finishes; it is an estimate based on the selected interval or active fast-refresh mode, and can change if settings change or a scan is stopped.

The first successful scan establishes a baseline for each queue; items first seen in later completed scans are marked **New arrival** for the lifetime of the viewer tab. A previously seen ASIN is not counted again if it disappears and returns. Filtering does not affect discovery counts. Items that move into the scanned pages from deeper results can be counted as arrivals even if Amazon listed them earlier. Changing the number of Additional Items pages establishes a fresh baseline on the next completed scan so newly included pages are not mistaken for drops; existing highlights remain. Failed or cancelled scans do not update discovery counts.

When a completed scan finds more than five new ASINs, the viewer temporarily waits 30 seconds between scans. It returns to the selected interval after three consecutive completed scans with five or fewer new ASINs; another larger drop resets that counter. **Off** disables automatic scanning even when drops are detected. The 30-second wait begins only after the scan completes, so the time between page-one checks also includes scanning time. Scans are polling, not a live feed, and can miss short-lived items.

The viewer retrieves Amazon's estimated taxable value (ETV) from Vine item details, not the retail price. Values are looked up one item at a time, with a one-second pause between requests. A parent item requires an additional request to select the first variant Amazon supplies; its displayed ETV applies only to that variant, not necessarily every option. Missing or invalid values show as unavailable; hover over the label for the reason. Account, verification, rate-limit, and unexpected response errors pause automatic scanning.

Known $0 ETV items appear first in every sort mode when **Show $0 ETV items first** is checked; uncheck it to hide them. Items with unknown or pending ETV remain visible until their value is known. Nonzero items use the selected sort, with unknown values last in ETV sort modes. Values update as lookups finish and can move items between viewer pages.

ETV lookups begin as pages arrive and continue during repeat scans. Successful values and their recommendation identifiers are cached locally in Firefox for 30 minutes and reused across scans and browser restarts; they can be stale. Hidden-by-keyword items are not looked up until unhidden. Scanning many pages and fetching ETVs can generate substantial request volume.

**Use and contribute shared ETV estimates** is off by default. When enabled, the viewer sends Additional Items ASINs and whether each listing is a parent to the public Cloudflare cache, and contributes ETVs retrieved from Amazon. Cloudflare receives the requester's IP address. Amazon credentials, recommendation IDs and other queues are not sent. Values expire for lookup after 30 minutes and are labeled **Shared estimate**; expired entries can remain in the database until their slot is overwritten. Parent values represent one contributor's sampled variant. Anyone can submit values, so they may be incorrect, manipulated or different for your account; they can affect sorting and the $0 filter. Direct requests always retrieve fresh details from Amazon. Cache failures are shown in the viewer, which falls back to Amazon. Turning the setting off stops future cache calls and discards shared values in the viewer.

The cache uses a free Cloudflare Worker and D1 database. It limits requests per IP approximately at each Cloudflare location, bounds stored entries, and does not authenticate contributions. These controls do not prevent poisoning or distributed abuse. Free quotas are shared with other Workers and D1 databases in the account; exhausting them can interrupt other applications. Cloudflare can change its limits. The Worker implementation and schema are in `shared-cache/`. To deploy to another account, copy `shared-cache/wrangler.example.jsonc` to `shared-cache/wrangler.jsonc`, create a D1 database, run the schema, fill in the D1 and rate-limiter bindings, and deploy the Worker. Update the endpoint in `shared-cache.js` and permission in `manifest.json`; users need the updated extension. The local deployment configuration is not tracked by Git. Existing cached values need not be migrated.

Automation may be subject to Amazon's terms and rate limits. This tool does not bypass login, captchas, or throttling. Its selectors depend on Amazon's page structure and may need updating if Amazon changes it.

## Development

Run `node --test tests/*.test.js`. REA was used locally to inspect selected files from [VHelper's public source](https://github.com/crysallis/VineHelper); the viewer is independently implemented. Live behavior depends on an authenticated Vine account and must be checked in Firefox.

The static project website is in `docs/`. It can be previewed by opening `docs/index.html` and can be published with GitHub Pages from the `main` branch's `/docs` folder.

## Publishing

This project is not yet a published Firefox add-on. Before submission, choose a permanent add-on ID, verify the extension and request flow with a live Vine account, and prepare the listing and privacy disclosures, including the optional Cloudflare cache. Review Mozilla's current [add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) and submission requirements.

## License

No license has been selected yet. Public access to this repository does not grant permission to copy, modify, or redistribute the software beyond applicable law.
