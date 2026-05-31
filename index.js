const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

app.options("*", (req, res) => res.sendStatus(200));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "GearStack server running", version: "2.0" });
});

// ── Claude AI proxy ────────────────────────────────────────────────────────────
// POST /claude — forwards requests to Anthropic using the server-side API key.
// The frontend never touches the key. All three Claude functions route here.
app.post("/claude", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Railway variables." });
  }
  try {
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    // Web search tool requires an extra beta header
    if (req.body.tools?.some(t => t.type === "web_search_20250305")) {
      headers["anthropic-beta"] = "web-search-2025-03-05";
    }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error("Claude proxy error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── eBay Inventory API — Create / Schedule / Draft listing ────────────────────
// POST /ebay-list
// Body: { title, description, price, condition, imageUrls, sku, mode, scheduleTime }
// mode: "live" | "scheduled" | "draft"
// scheduleTime: ISO string (only used when mode === "scheduled")

app.post("/ebay-list", async (req, res) => {
  const userToken = process.env.EBAY_USER_TOKEN;
  if (!userToken) return res.status(500).json({ ok: false, error: "EBAY_USER_TOKEN not set in Railway variables." });

  const { title, description, price, condition = "USED_EXCELLENT", imageUrls = [], sku, mode = "live", scheduleTime } = req.body;

  if (!title || !description || !price) {
    return res.status(400).json({ ok: false, error: "title, description, and price are required." });
  }

  const env = process.env.EBAY_ENV || "production";
  const baseUrl = env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  const listingSku = sku || "GS-" + Date.now();

  try {
    // Step 1 — Create or replace inventory item
    const inventoryPayload = {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: condition,
      product: {
        title,
        description,
        imageUrls: imageUrls.length ? imageUrls : [],
        aspects: {}
      }
    };

    const invRes = await fetch(`${baseUrl}/sell/inventory/v1/inventory_item/${listingSku}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${userToken}`,
        "Content-Type": "application/json",
        "Content-Language": "en-US",
      },
      body: JSON.stringify(inventoryPayload),
    });

    if (!invRes.ok && invRes.status !== 204) {
      const err = await invRes.json().catch(() => ({}));
      throw new Error("Inventory item error: " + JSON.stringify(err.errors?.[0] || err));
    }

    // Step 2 — Create offer
    const offerPayload = {
      sku: listingSku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: 1,
      categoryId: "15032", // Film Cameras — broad default; make dynamic later
      listingDescription: description,
      pricingSummary: {
        price: { value: parseFloat(price).toFixed(2), currency: "USD" }
      },
      listingPolicies: {
        fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID || "",
        paymentPolicyId:     process.env.EBAY_PAYMENT_POLICY_ID     || "",
        returnPolicyId:      process.env.EBAY_RETURN_POLICY_ID      || "",
      },
      ...(mode === "scheduled" && scheduleTime ? { scheduledTime: scheduleTime } : {}),
    };

    // Check if offer already exists for this SKU
    const existingOffersRes = await fetch(`${baseUrl}/sell/inventory/v1/offer?sku=${listingSku}`, {
      headers: { "Authorization": `Bearer ${userToken}` }
    });
    const existingOffers = await existingOffersRes.json().catch(() => ({ offers: [] }));
    const existingOffer = existingOffers.offers?.[0];

    let offerId;
    if (existingOffer) {
      const updateRes = await fetch(`${baseUrl}/sell/inventory/v1/offer/${existingOffer.offerId}`, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${userToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(offerPayload),
      });
      if (!updateRes.ok) {
        const err = await updateRes.json().catch(() => ({}));
        throw new Error("Offer update error: " + JSON.stringify(err.errors?.[0] || err));
      }
      offerId = existingOffer.offerId;
    } else {
      const offerRes = await fetch(`${baseUrl}/sell/inventory/v1/offer`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${userToken}`, "Content-Type": "application/json", "Content-Language": "en-US" },
        body: JSON.stringify(offerPayload),
      });
      const offerData = await offerRes.json().catch(() => ({}));
      if (!offerRes.ok) throw new Error("Offer create error: " + JSON.stringify(offerData.errors?.[0] || offerData));
      offerId = offerData.offerId;
    }

    // Step 3 — Publish (or save as draft)
    if (mode === "draft") {
      return res.json({ ok: true, mode: "draft", offerId, sku: listingSku, message: "Saved as draft on eBay." });
    }

    const publishRes = await fetch(`${baseUrl}/sell/inventory/v1/offer/${offerId}/publish`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${userToken}`, "Content-Type": "application/json" },
    });
    const publishData = await publishRes.json().catch(() => ({}));
    if (!publishRes.ok) throw new Error("Publish error: " + JSON.stringify(publishData.errors?.[0] || publishData));

    res.json({
      ok: true,
      mode,
      offerId,
      listingId: publishData.listingId,
      sku: listingSku,
      message: mode === "scheduled" ? `Scheduled for ${scheduleTime}` : "Listed live on eBay.",
    });

  } catch (err) {
    console.error("eBay list error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── eBay Business Policies ────────────────────────────────────────────────────
app.get("/ebay-policies", async (req, res) => {
  const userToken = process.env.EBAY_USER_TOKEN;
  if (!userToken) return res.status(500).json({ ok: false, error: "EBAY_USER_TOKEN not set." });
  const env = process.env.EBAY_ENV || "production";
  const baseUrl = env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  try {
    const [fulfillment, payment, returns] = await Promise.all([
      fetch(`${baseUrl}/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US`, { headers: { Authorization: `Bearer ${userToken}` } }).then(r => r.json()),
      fetch(`${baseUrl}/sell/account/v1/payment_policy?marketplace_id=EBAY_US`,     { headers: { Authorization: `Bearer ${userToken}` } }).then(r => r.json()),
      fetch(`${baseUrl}/sell/account/v1/return_policy?marketplace_id=EBAY_US`,      { headers: { Authorization: `Bearer ${userToken}` } }).then(r => r.json()),
    ]);
    res.json({ ok: true, fulfillment, payment, returns });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── eBay OAuth ─────────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

app.get("/ebay-token", async (req, res) => {
  try {
    const token = await getEbayToken();
    res.json({ ok: true, token });
  } catch (err) {
    console.error("eBay token error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  const appId  = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const env    = process.env.EBAY_ENV || "production";

  if (!appId || !certId) {
    throw new Error("EBAY_APP_ID and EBAY_CERT_ID must be set in Railway environment variables.");
  }

  const credentials = Buffer.from(`${appId}:${certId}`).toString("base64");
  const tokenUrl = env === "sandbox"
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token";

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay token request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

// ── eBay Search proxy ──────────────────────────────────────────────────────────
app.get("/ebay-search", async (req, res) => {
  const { q, limit = "24", condition } = req.query;
  if (!q) return res.status(400).json({ ok: false, error: "Missing query" });

  try {
    const token = await getEbayToken();
    const params = new URLSearchParams({ q, limit });
    if (condition && condition !== "Any") params.append("filter", `conditionIds:{${condition}}`);

    const response = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.errors?.[0]?.message || `eBay API error ${response.status}`);
    }

    const data = await response.json();
    res.json({ ok: true, items: data.itemSummaries || [] });
  } catch (err) {
    console.error("eBay search error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── City to EstateSales.net region mapping ─────────────────────────────────────
const CITY_REGIONS = {
  "Seattle":       { state: "WA", region: "Seattle-Tacoma-Bellevue" },
  "Tacoma":        { state: "WA", region: "Seattle-Tacoma-Bellevue" },
  "Portland":      { state: "OR", region: "Portland" },
  "San Francisco": { state: "CA", region: "San-Francisco-Bay-Area" },
  "Oakland":       { state: "CA", region: "San-Francisco-Bay-Area" },
  "Sacramento":    { state: "CA", region: "Sacramento" },
  "Los Angeles":   { state: "CA", region: "Los-Angeles" },
  "San Diego":     { state: "CA", region: "San-Diego" },
};

function getCityRegion(cityLabel) {
  const cityName = cityLabel.split(",")[0].trim();
  return CITY_REGIONS[cityName] || { state: "WA", region: "Seattle-Tacoma-Bellevue" };
}

// ── Estate Sales search ────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  const { keywords = "camera", city = "Seattle, WA", miles = "50", page = "1" } = req.query;
  try {
    const region = getCityRegion(city);
    const url = `https://www.estatesales.net/${region.state}/${region.region}`;
    console.log("Fetching:", url);
    const html = await fetchPage(url);
    const sales = parseSaleListings(html, keywords);
    res.json({ ok: true, keywords, city, miles, page: parseInt(page), count: sales.length, sales });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/sale", async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes("estatesales.net")) {
    return res.status(400).json({ ok: false, error: "Invalid URL" });
  }
  try {
    const html = await fetchPage(url);
    const detail = parseSaleDetail(html);
    res.json({ ok: true, ...detail });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Connection": "keep-alive",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`EstateSales.net returned ${response.status}`);
  return response.text();
}

const CAMERA_SIGNALS = [
  "camera", "lens", "nikon", "canon", "pentax", "minolta", "olympus", "leica", "kodak",
  "film", "slr", "rangefinder", "photography", "darkroom", "enlarger", "fuji", "fujifilm",
  "vintage electronics", "stereo", "hifi", "hi-fi", "turntable", "receiver", "amplifier"
];

const SALE_URL_PATTERN = /^\/[A-Z]{2}\/[^/]+-\d{4,5}\/\d+\/?$/;

function isValidSaleUrl(href) {
  if (!href) return false;
  const path = href.startsWith("http") ? new URL(href).pathname : href;
  return SALE_URL_PATTERN.test(path);
}

function parseSaleListings(html, keywords) {
  const $ = cheerio.load(html);
  const sales = [];
  const seen = new Set();
  const keywordList = keywords.toLowerCase().split(/\s+/).filter(Boolean);

  $("nav, header, footer, [class*='nav'], [class*='header'], [class*='footer'], [class*='sidebar'], [class*='menu'], [class*='breadcrumb']").remove();

  $("a[href]").each((i, el) => {
    const href = $(el).attr("href") || "";
    if (!isValidSaleUrl(href)) return;

    const fullUrl = href.startsWith("http") ? href : `https://www.estatesales.net${href}`;
    if (seen.has(fullUrl)) return;
    seen.add(fullUrl);

    const $container = $(el).closest("article, [class*='sale'], [class*='listing'], [class*='card'], li, div").first();
    const $scope = $container.length ? $container : $(el).parent();
    const rawText = $scope.text().replace(/\s+/g, " ").trim();
    if (rawText.length < 25) return;

    const linkText = $(el).text().trim();
    const heading  = $scope.find("h1, h2, h3, h4, strong").first().text().trim();
    const title    = (heading.length > linkText.length ? heading : linkText) || rawText.slice(0, 80);

    const titleLow = title.toLowerCase();
    if (
      titleLow.includes("sign in") ||
      titleLow.includes("log in") ||
      titleLow.includes("register") ||
      titleLow.includes("favorites") ||
      titleLow.includes("today") ||
      titleLow.includes("tomorrow") ||
      titleLow.includes("15 days") ||
      titleLow.includes("search") ||
      titleLow.length < 5
    ) return;

    const location = $scope.find("[class*='address'], [class*='location'], [class*='city']").first().text().trim();
    const dates    = $scope.find("[class*='date'], time").first().text().trim();
    const company  = $scope.find("[class*='company'], [class*='organizer']").first().text().trim();
    const image    = $scope.find("img").first().attr("src") || $scope.find("img").first().attr("data-src") || null;

    const fullText    = rawText.toLowerCase();
    const signalWords = CAMERA_SIGNALS.filter(s => fullText.includes(s));
    const keywordHits = keywordList.filter(k => fullText.includes(k));

    sales.push({
      title:          title.slice(0, 120),
      description:    rawText.slice(0, 200),
      location:       location || "",
      dates:          dates || "",
      company:        company || "",
      url:            fullUrl,
      image:          image,
      signalWords,
      hasCamera:      signalWords.length > 0,
      relevanceScore: keywordHits.length * 10 + signalWords.length * 5,
    });
  });

  return sales
    .sort((a, b) => {
      if (a.hasCamera && !b.hasCamera) return -1;
      if (!a.hasCamera && b.hasCamera) return 1;
      return b.relevanceScore - a.relevanceScore;
    })
    .slice(0, 20);
}

function parseSaleDetail(html) {
  const $ = cheerio.load(html);
  const title       = $("h1").first().text().trim();
  const description = $("[class*='desc'], [class*='detail'], p").first().text().trim();
  const address     = $("[class*='address'], [itemprop='address']").text().trim();
  const dates       = $("[class*='date'], time").text().trim();
  const photos      = [];
  $("img").each((i, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    if (src && src.includes("estatesales") && !photos.includes(src)) photos.push(src);
  });
  return { title, description, address, dates, photos: photos.slice(0, 12) };
}

app.listen(PORT, () => {
  console.log(`GearStack server v2.0 running on port ${PORT}`);
});
