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
  res.json({ status: "GearStack Estate Sales server running", version: "1.3" });
});

// City to EstateSales.net region mapping
const CITY_REGIONS = {
  "Seattle":       { state:"WA", region:"Seattle-Tacoma-Bellevue" },
  "Tacoma":        { state:"WA", region:"Seattle-Tacoma-Bellevue" },
  "Portland":      { state:"OR", region:"Portland" },
  "San Francisco": { state:"CA", region:"San-Francisco-Bay-Area" },
  "Oakland":       { state:"CA", region:"San-Francisco-Bay-Area" },
  "Sacramento":    { state:"CA", region:"Sacramento" },
  "Los Angeles":   { state:"CA", region:"Los-Angeles" },
  "San Diego":     { state:"CA", region:"San-Diego" },
};

function getCityRegion(cityLabel) {
  const cityName = cityLabel.split(",")[0].trim();
  return CITY_REGIONS[cityName] || { state:"WA", region:"Seattle-Tacoma-Bellevue" };
}

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
  "camera","lens","nikon","canon","pentax","minolta","olympus","leica","kodak",
  "film","slr","rangefinder","photography","darkroom","enlarger","fuji","fujifilm",
  "vintage electronics","stereo","hifi","hi-fi","turntable","receiver","amplifier"
];

function parseSaleListings(html, keywords) {
  const $ = cheerio.load(html);
  const sales = [];
  const keywordList = keywords.toLowerCase().split(/\s+/);

  // EstateSales.net uses sale listing cards — try multiple selectors
  const selectors = [
    ".sale-listing",
    ".listing",
    "article",
    "[class*='sale']",
    "[class*='listing']",
    ".row .col",
  ];

  let found = false;
  for (const sel of selectors) {
    const els = $(sel);
    if (els.length > 2) {
      els.each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        if (text.length < 20) return;

        const title = $el.find("h2, h3, h4, strong, b").first().text().trim() || text.slice(0, 80);
        const location = $el.find("[class*='address'], [class*='location'], [class*='city']").first().text().trim();
        const dates = $el.find("[class*='date'], time").first().text().trim();
        const company = $el.find("[class*='company'], [class*='organizer']").first().text().trim();
        const link = $el.find("a[href*='/']").first().attr("href");
        const image = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src");

        const fullText = text.toLowerCase();
        const signalHits = CAMERA_SIGNALS.filter(s => fullText.includes(s));
        const keywordHits = keywordList.filter(k => fullText.includes(k));
        const fullUrl = link ? (link.startsWith("http") ? link : `https://www.estatesales.net${link}`) : null;

        if (title && fullUrl) {
          sales.push({
            title: title.slice(0, 120),
            description: text.slice(0, 200),
            location: location || "",
            dates: dates || "",
            company: company || "",
            url: fullUrl,
            image: image || null,
            signalHits,
            hasCamera: signalHits.length > 0,
            relevanceScore: keywordHits.length * 10 + signalHits.length * 5,
          });
          found = true;
        }
      });
      if (found) break;
    }
  }

  // Fallback: grab all links that look like sale pages
  if (!found || sales.length === 0) {
    $("a[href]").each((i, el) => {
      const href = $(el).attr("href") || "";
      // EstateSales.net sale URLs look like /WA/City/zipcode/saleID
      if (!/\/[A-Z]{2}\//.test(href) && !href.match(/\/\d+$/)) return;
      const $parent = $(el).closest("div, article, li, section");
      const text = $parent.text().trim();
      if (text.length < 30) return;
      const title = $(el).text().trim() || text.slice(0, 80);
      const fullText = text.toLowerCase();
      const signalHits = CAMERA_SIGNALS.filter(s => fullText.includes(s));
      const fullUrl = href.startsWith("http") ? href : `https://www.estatesales.net${href}`;

      if (title.length > 5 && !sales.find(s => s.url === fullUrl)) {
        sales.push({
          title: title.slice(0, 120),
          description: text.slice(0, 200),
          location: "", dates: "", company: "",
          url: fullUrl, image: null,
          signalHits, hasCamera: signalHits.length > 0,
          relevanceScore: signalHits.length * 5,
        });
      }
    });
  }

  // Sort: camera signals first, then by relevance
  return sales
    .filter(s => s.url && s.title)
    .sort((a, b) => {
      if (a.hasCamera && !b.hasCamera) return -1;
      if (!a.hasCamera && b.hasCamera) return 1;
      return b.relevanceScore - a.relevanceScore;
    })
    .slice(0, 20);
}

function parseSaleDetail(html) {
  const $ = cheerio.load(html);
  const title = $("h1").first().text().trim();
  const description = $("[class*='desc'], [class*='detail'], p").first().text().trim();
  const address = $("[class*='address'], [itemprop='address']").text().trim();
  const dates = $("[class*='date'], time").text().trim();
  const photos = [];
  $("img").each((i, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    if (src && src.includes("estatesales") && !photos.includes(src)) photos.push(src);
  });
  return { title, description, address, dates, photos: photos.slice(0, 12) };
}

app.listen(PORT, () => {
  console.log(`GearStack estate sales server v1.3 running on port ${PORT}`);
});
