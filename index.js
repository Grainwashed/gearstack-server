const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "GearStack Estate Sales server running", version: "1.1" });
});

app.get("/search", async (req, res) => {
  const { keywords = "camera", lat = "37.7749", lng = "-122.4194", miles = "50", page = "1" } = req.query;
  try {
    const url = `https://www.estatesales.net/search?q=${encodeURIComponent(keywords)}&lat=${lat}&lng=${lng}&miles=${miles}&page=${page}`;
    const html = await fetchPage(url);
    const sales = parseSaleListings(html, keywords);
    res.json({ ok: true, keywords, miles, page: parseInt(page), count: sales.length, sales });
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
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`EstateSales.net returned ${response.status}`);
  return response.text();
}

function parseSaleListings(html, keywords) {
  const $ = cheerio.load(html);
  const sales = [];
  const keywordList = keywords.toLowerCase().split(/\s+/);
  const cameraSignals = ["camera","lens","nikon","canon","pentax","minolta","olympus","leica","kodak","film","slr","rangefinder","photography","darkroom","enlarger","vintage electronics","stereo","equipment"];

  $(".sale-listing, .listing-card, [class*='sale-card'], [class*='listing']").each((i, el) => {
    try {
      const $el = $(el);
      const title = $el.find("h2, h3, .sale-title, [class*='title']").first().text().trim();
      const description = $el.find("p, .description, [class*='desc']").first().text().trim();
      const location = $el.find(".location, [class*='location'], [class*='city']").first().text().trim();
      const dates = $el.find(".dates, [class*='date'], time").first().text().trim();
      const link = $el.find("a").first().attr("href");
      const image = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src");
      const company = $el.find(".company, [class*='company'], [class*='organizer']").first().text().trim();
      if (!title && !description) return;
      const fullText = `${title} ${description}`.toLowerCase();
      const keywordHits = keywordList.filter(k => fullText.includes(k)).length;
      const signalHits = cameraSignals.filter(s => fullText.includes(s));
      const fullUrl = link ? (link.startsWith("http") ? link : `https://www.estatesales.net${link}`) : null;
      if (fullUrl || title) {
        sales.push({ title: title || "Estate Sale", description: description || "", location: location || "", dates: dates || "", company: company || "", url: fullUrl, image: image || null, relevanceScore: Math.round((keywordHits / keywordList.length) * 100), signalHits, hasCamera: signalHits.length > 0 });
      }
    } catch (e) {}
  });

  if (sales.length === 0) return parseFallback($, keywords);
  return sales.sort((a, b) => {
    if (a.hasCamera && !b.hasCamera) return -1;
    if (!a.hasCamera && b.hasCamera) return 1;
    return b.relevanceScore - a.relevanceScore;
  });
}

function parseFallback($, keywords) {
  const sales = [];
  const keywordList = keywords.toLowerCase().split(/\s+/);
  $("a[href*='/CA/'], a[href*='/OR/'], a[href*='/WA/'], a[href*='-estate-sale']").each((i, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    const text = $el.closest("div, article, li").text().trim();
    const title = $el.text().trim() || text.slice(0, 80);
    if (title.length > 5) {
      const fullText = text.toLowerCase();
      const keywordHits = keywordList.filter(k => fullText.includes(k)).length;
      sales.push({ title, description: text.slice(0, 200), location: "", dates: "", company: "", url: href?.startsWith("http") ? href : `https://www.estatesales.net${href}`, image: null, relevanceScore: Math.round((keywordHits / keywordList.length) * 100), signalHits: [], hasCamera: fullText.includes("camera") || fullText.includes("lens") });
    }
  });
  return sales.slice(0, 20);
}

function parseSaleDetail(html) {
  const $ = cheerio.load(html);
  const title = $("h1, .sale-title").first().text().trim();
  const description = $(".description, .sale-description, [class*='desc']").text().trim();
  const address = $(".address, [class*='address'], [itemprop='address']").text().trim();
  const dates = $(".dates, [class*='date'], time").text().trim();
  const photos = [];
  $("img[src*='estatesales'], img[data-src*='estatesales'], .photos img, .gallery img").each((i, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    if (src && !photos.includes(src)) photos.push(src);
  });
  const items = [];
  $("ul li, .items li, .item-list li").each((i, el) => {
    const text = $(el).text().trim();
    if (text.length > 2) items.push(text);
  });
  return { title, description, address, dates, photos: photos.slice(0, 12), items: items.slice(0, 50) };
}

app.listen(PORT, () => {
  console.log(`GearStack estate sales server running on port ${PORT}`);
});

