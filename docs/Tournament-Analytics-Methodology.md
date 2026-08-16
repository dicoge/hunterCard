## 牌組分群與卡片關聯分析方法

### 目的

本流程提供可重現、確定性的 tournament deck analytics：牌組向量、牌組相似度矩陣、透明分群，以及卡片共現關聯。當前真實資料只有 `cardsVerified:true` 的 2 副牌組，因此所有結果都是 N=2 的 exploratory pipeline proof，不是 meta 統計結論。

### 輸入與排除規則

- 讀取 `data/tournaments/YYYY-MM.json` 的 normalized tournament reports。
- 只納入 `cardsVerified:true` 的牌組。
- `cardsVerified:false` 或缺少完整卡表的牌組只列在 `excludedIncompleteDecks`，不補值、不推測、不參與任何定量分析。
- 目前 2026-08 真實樣本：`decklog:DUKHN`、`decklog:2H33J8`。
- 2026-07 的 3 副 featured decks 卡表未驗證，因此排除。

### Feature vector schema

每張卡的 feature key 固定為：

```text
zone|exact cardNumber|source-proven version
```

`oshi` / `main` / `yell` 三區不合併；同 cardNumber 的不同 **source-proven** version 不合併；不使用卡名、同號 fallback、跨版本 fallback 或價格 fallback。

#### Version 必須 source-proven（DIC-1042）

只有 source 明確證明「這是哪一個印刷版本」時，version 才會進入 feature identity。判定條件（strict）：

- `versionProven === true`，或
- `versionSource` 屬於 allowlist：`printingId`、`catalogPrinting`。

其餘一律使用 `NO_VERSION` 作為明確占位。

**Deck Log 的 `rare` 欄位是 rarity label（U / C / R / RR / S / SR / OSR / P / SY），不是印刷版本證明**，因此不得作為 identity。實際資料中 `hBP01-108` 在一副牌顯示 `U`、另一副顯示 `P`；若把 rarity 當成 version，同一張卡會被拆成兩個 feature，使共用數量、weighted Jaccard、clusters 及所有 association 全部失真。被丟棄的 label 不會消失，而是保留在該 feature 的 `unprovenVersionLabels`，並在 artifact `warnings` 中明確列出。

向量保留數量，例如 `main|hBP07-063|NO_VERSION: 4`。Feature dictionary 以 zone、cardNumber、version 穩定排序，`index` 為 artifact-local。

### Yell / basic resources 與 zone weights

Yell 是牌組結構的一部分，所以保留在向量與關聯輸出中，但預設權重較低：

```json
{
  "oshi": 1,
  "main": 1,
  "yell": 0.25
}
```

原因：yell 顏色能區分牌組，但 20 張同名資源若以主牌同權重計算，會過度主導相似度。權重可透過 analyzer config 調整；artifact 會記錄實際 config。

### Similarity matrix

使用 weighted Jaccard，適合 sparse count vectors：

```text
similarity(x, y) = sum_i min(w_i * x_i, w_i * y_i) / sum_i max(w_i * x_i, w_i * y_i)
```

輸出為 square symmetric matrix：

- `deckIds` 定義列／欄順序。
- diagonal 固定為 `1`。
- 數值以 deterministic rounding 輸出。

Weighted Jaccard 的理由：它直接比較稀疏數量向量的交集與聯集，能保留「共享幾張」與「不同幾張」的直覺，也不需要隨機初始化。

### Clustering

使用 deterministic agglomerative hierarchical clustering：

- 初始每副牌一群。
- 群間相似度使用 average linkage。
- 合併分數低於 threshold 時停止。
- threshold 預設 `0.55`。
- tie-break 使用成員索引 signature，確保輸入順序改變時仍穩定。
- cluster id 為 `cluster-001`, `cluster-002`, ...。

N=0 / N=1 / N=2 均誠實處理：可輸出空集合或 singleton clusters，但不做顯著性或 meta share 宣稱。

### Cluster summaries

每個 cluster 輸出：

- `sampleCount`
- `members`
- `representativeOshi`
- `representativeArchetype`
- `coreCards`：cluster 內所有牌組皆出現的 feature，**完整輸出、不截斷**；`coreCardCount` 為其總數。
- `differentiatingCards`：cluster 內 presence rate 減去 cluster 外 presence rate 最高的 feature，這是明示的 **ranked preview**：`differentiatingCardsPreviewLimit`（預設 12，可由 config `clusterSummary.differentiatingPreviewLimit` 調整）為輸出上限，`differentiatingCardsTotal` 為排序候選總數。

#### coreCards 不得截斷（DIC-1045）

`coreCards` 是定義（「cluster 內每副牌都有」），不是排行榜。原本的 `slice(0, 20)` 會在定義成立的情況下悄悄丟掉合格成員——2026-08 的 `decklog:DUKHN` singleton 有 23 個 core feature，卻只輸出 20 個，等於發佈了一個與其定義不符的集合。截斷已移除。真正屬於 ranking 的 `differentiatingCards` 仍可保留上限，但必須連同 limit 與 total 一起輸出，讀者才知道自己看到的是節錄。

### Card association

關聯使用 deck presence，不使用 raw duplicate copies：一張卡在同一副牌中出現 1 張或 4 張，對共現計數都只算該副牌 presence=1。

對每組 feature `(A, B)`：

```text
count(A,B) = 同時包含 A 與 B 的牌組數
support(A,B) = count(A,B) / sampleSize
confidence(A=>B) = count(A,B) / decksContaining(A)
lift(A,B) = support(A,B) / (support(A) * support(B))
```

Artifact 同時輸出 queryable sparse relation list 與 sparse matrix/index representation。預設 `minSupportCount=1`，因為目前 N=2；不輸出巨大 dense all-card matrix。

### 產物

Analyzer 寫入並 mirror：

```text
data/tournaments/analytics/index.json
data/tournaments/analytics/YYYY-MM.json
public/data/tournaments/analytics/index.json
public/data/tournaments/analytics/YYYY-MM.json
```

每個 month artifact 包含：`month`、input deck IDs、source report hash、generatedAt、algorithm/version/config、sampleSize、excludedIncompleteDecks、warnings、vectors/schema、similarity matrix、clusters、associations。

#### Month artifact 是獨立重算，不是全域過濾（DIC-1042）

每個 `YYYY-MM.json` 都是「只用該月牌組」重跑整條 pipeline 的結果：feature dictionary、similarity matrix、clustering、cluster representative / `coreCards` / presence / averageCount / `differentiatingCards`、association denominators 全部以該月 subset 重新計算。

先做全域分析再過濾 cluster members 是錯的：全域 cluster 可能跨月合併，過濾後只留下該月成員，卻沿用全域的 representative 與 core cards——月度 singleton 會報出別月的 archetype、別月才有的卡，以及大於 sampleSize 的 presence。因此 month artifact 的 feature `index` 是 artifact-local，不同月之間不可互相對照 index。

### 目前真實資料限制

- 2026-08 只有兩副官方公開且卡表完整驗證的 block champion decks。
- 2026-07 featured decks 因 `cardsVerified:false` 排除。
- 官方未公開完整 standings、參賽人數、其他名次牌組，因此不能稱為完整 meta。
- 任何 missing rank / participant data 仍是 unknown。

### 重現命令

```bash
npm run analyze:tournaments
```

測試命令：

```bash
npm run test:tournament-analytics
```
