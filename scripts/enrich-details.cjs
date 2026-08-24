const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const outputDir = path.join(__dirname, "../data/official");
const progressFile = path.join(outputDir, "_progress.json");
const COLOR_MAP = { "白": "white", "緑": "green", "赤": "red", "青": "blue", "紫": "purple", "黄": "yellow", "無": "colorless" };

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(progressFile, "utf8")); } catch { return { done: {} }; }
}

async function getDetail(page, cardId, code) {
  const url = "https://hololive-official-cardgame.com/cardlist/?id=" + cardId + "&expansion=" + code + "&view=image";
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });
    await page.waitForSelector(".cardlist-Detail_Box_Inner", { timeout: 8000 }).catch(() => {});
    return await page.evaluate(() => {
      const box = document.querySelector(".cardlist-Detail_Box_Inner");
      if (!box) return null;
      const fields = {};
      Array.from(box.querySelectorAll("dl dt")).forEach(dt => {
        const dd = dt.nextElementSibling;
        if (!dd) return;
        const colorImg = dd.querySelector("img[alt]");
        fields[dt.textContent.trim()] = colorImg ? colorImg.getAttribute("alt") : dd.textContent.trim();
      });
      const numEl = box.querySelector(".illustrator .number span");
      return {
        cardType: fields["カードタイプ"] || "",
        rarity: fields["レアリティ"] || "",
        color: fields["色"] || "",
        life: fields["LIFE"] || "",
        arts: fields["アーツ"] || "",
        hp: fields["HP"] || "",
        // Bloom Level (Debut / 1st / 2nd / Buzz / Spot) — Holomen only.
        // Present on the same info dl as HP/color for member cards; empty for
        // Oshi/Support/Yell/Mascot (DIC-1141).
        bloomLevel: fields["Bloomレベル"] || fields["BloomLevel"] || "",
        cardNumber: numEl ? numEl.textContent.trim() : "",
      };
    });
  } catch(e) { return null; }
}

async function main() {
  const progress = loadProgress();
  const codes = ["hBP04", "hBP05", "hBP06", "hBP07"];
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(25000);

  for (const code of codes) {
    const dataFile = path.join(outputDir, code + ".json");
    const cards = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    let changed = false;
    console.log("Processing " + code + " (" + cards.length + " cards)");

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const key = code + "_" + card.id;
      if (progress.done[key]) continue;
      const detail = await getDetail(page, card.id, code);
      if (detail) {
        card.cardType = detail.cardType;
        if (detail.rarity) card.rarity = detail.rarity;
        card.color = COLOR_MAP[detail.color] || detail.color;
        card.life = detail.life;
        card.arts = detail.arts;
        card.hp = detail.hp;
        if (detail.bloomLevel) card.bloomLevel = detail.bloomLevel;
        if (detail.cardNumber) card.cardNumber = detail.cardNumber;
      }
      progress.done[key] = true;
      changed = true;
      if ((i + 1) % 10 === 0) {
        fs.writeFileSync(dataFile, JSON.stringify(cards, null, 2));
        fs.writeFileSync(progressFile, JSON.stringify(progress));
        console.log(code + " progress: " + (i+1) + "/" + cards.length);
      }
    }

    if (changed) {
      fs.writeFileSync(dataFile, JSON.stringify(cards, null, 2));
      fs.writeFileSync(progressFile, JSON.stringify(progress));
      console.log(code + " complete");
    }
  }

  const allCards = codes.flatMap(code => JSON.parse(fs.readFileSync(path.join(outputDir, code + ".json"), "utf8")));
  fs.writeFileSync(path.join(outputDir, "all-new-cards.json"), JSON.stringify(allCards, null, 2));
  await browser.close();
  console.log("All done. Total: " + allCards.length);
}

main().catch(e => { console.error(e.message); process.exit(1); });
