const puppeteer = require("puppeteer");
const https = require("https");
const fs = require("fs");
const path = require("path");

const SERIES = [
  { code: "hBP04" },
  { code: "hBP05" },
  { code: "hBP06" },
  { code: "hBP07" },
];

const COLOR_MAP = { "白": "white", "緑": "green", "赤": "red", "青": "blue", "紫": "purple", "黄": "yellow", "無": "colorless" };

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function parseCards(html) {
  const cards = [];
  const re = /<li class="object-fit-img[^"]*"><a href="\/cardlist\/\?id=(\d+)&(?:amp;)?expansion=([^&"]+)[^"]*"><img src="([^"]+)" alt="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const imgFile = m[3].split("/").pop();
    const cardNumMatch = imgFile.match(/^([^_]+)_/);
    const rarityMatch = imgFile.match(/_([^.]+)\./);
    cards.push({
      id: m[1],
      expansion: m[2],
      imageUrl: "https://hololive-official-cardgame.com" + m[3],
      name: m[4],
      cardNumber: cardNumMatch ? cardNumMatch[1] : "",
      rarity: rarityMatch ? rarityMatch[1] : "",
    });
  }
  return cards;
}

async function getAllCardIds(code) {
  const baseUrl = "https://hololive-official-cardgame.com";
  const firstHtml = await fetchHtml(baseUrl + "/cardlist/cardsearch/?expansion=" + code);
  const maxPageMatch = firstHtml.match(/var max_page = (\d+)/);
  const maxPage = maxPageMatch ? parseInt(maxPageMatch[1]) : 1;
  console.log("  max_page=" + maxPage);
  const cards = parseCards(firstHtml);
  for (let p = 2; p <= maxPage; p++) {
    const t = Date.now();
    const url = baseUrl + "/cardlist/cardsearch_ex?expansion=" + code + "&view=image&page=" + p + "&t=" + t;
    const html = await fetchHtml(url);
    const pageCards = parseCards(html);
    cards.push(...pageCards);
    await new Promise(r => setTimeout(r, 300));
  }
  return cards;
}

async function getCardDetail(page, cardId, code) {
  const url = "https://hololive-official-cardgame.com/cardlist/?id=" + cardId + "&expansion=" + code + "&view=image";
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector(".cardlist-Detail_Box_Inner", { timeout: 10000 }).catch(() => {});
  return await page.evaluate(() => {
    const box = document.querySelector(".cardlist-Detail_Box_Inner");
    if (!box) return null;
    const dts = Array.from(box.querySelectorAll("dl dt"));
    const fields = {};
    dts.forEach(dt => {
      const dd = dt.nextElementSibling;
      if (!dd) return;
      const key = dt.textContent.trim();
      const colorImg = dd.querySelector("img[alt]");
      fields[key] = colorImg ? colorImg.getAttribute("alt") : dd.textContent.trim();
    });
    const numEl = box.querySelector(".illustrator .number span");
    return {
      cardType: fields["カードタイプ"] || "",
      rarity: fields["レアリティ"] || "",
      color: fields["色"] || "",
      life: fields["LIFE"] || "",
      hp: fields["HP"] || "",
      // Bloom Level (Debut / 1st / 2nd / Buzz / Spot) — Holomen only (DIC-1141).
      bloomLevel: fields["Bloomレベル"] || fields["BloomLevel"] || "",
      cardNumber: numEl ? numEl.textContent.trim() : "",
    };
  });
}

async function main() {
  console.log("Starting scrape...");
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const outputDir = path.join(__dirname, "../data/official");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const allCards = [];

  for (const series of SERIES) {
    console.log("Scraping series: " + series.code);
    const basicCards = await getAllCardIds(series.code);
    console.log("  Found " + basicCards.length + " cards, fetching details...");
    const detailPage = await browser.newPage();
    detailPage.setDefaultTimeout(30000);
    const seriesCards = [];
    for (let i = 0; i < basicCards.length; i++) {
      const basic = basicCards[i];
      try {
        const detail = await getCardDetail(detailPage, basic.id, series.code);
        seriesCards.push({
          id: basic.id,
          cardNumber: detail ? detail.cardNumber || basic.cardNumber : basic.cardNumber,
          name: basic.name,
          expansion: series.code,
          cardType: detail ? detail.cardType : "",
          rarity: detail ? detail.rarity || basic.rarity : basic.rarity,
          color: detail ? (COLOR_MAP[detail.color] || detail.color) : "",
          life: detail ? detail.life : "",
          hp: detail ? detail.hp : "",
          bloomLevel: detail ? detail.bloomLevel : "",
          imageUrl: basic.imageUrl,
        });
        if ((i + 1) % 20 === 0) console.log("  Progress: " + (i + 1) + "/" + basicCards.length);
      } catch (e) {
        console.log("  skip card " + basic.id + ": " + e.message);
        seriesCards.push({ ...basic, expansion: series.code });
      }
    }
    await detailPage.close();
    allCards.push(...seriesCards);
    fs.writeFileSync(path.join(outputDir, series.code + ".json"), JSON.stringify(seriesCards, null, 2));
    console.log("  Done: " + series.code + " (" + seriesCards.length + " cards)");
  }

  fs.writeFileSync(path.join(outputDir, "all-new-cards.json"), JSON.stringify(allCards, null, 2));
  await browser.close();
  console.log("Total: " + allCards.length + " cards saved to " + outputDir);
}

main().catch(console.error);
