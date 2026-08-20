/**
 * hOCG 規則教學資料
 * 來源：巴哈姆特論壇 — 桜雪 (h503323)
 * 更新：2026 年 4 月 24 日
 */

import type { LanguageCode } from '../store/settingsStore';
import tutorialDataJa from './tutorialDataJa';

export interface TutorialImage {
  url: string;
  alt: string;
}

export interface TutorialPhase {
  title: string;
  description?: string;
  steps?: string[];
  notes?: string[];
  images?: TutorialImage[];
  conditions?: string[];
  canDo?: string[];
  cannotDo?: string[];
  subPhases?: TutorialPhase[];
}

export interface TutorialSection {
  id: string;
  title: string;
  icon: string;
  description?: string;
  images?: TutorialImage[];
  phases?: TutorialPhase[];
  items?: { label: string; description: string }[];
  content?: string[];
  notes?: string[];
  links?: { label: string; url: string }[];
}

const tutorialData: TutorialSection[] = [
  {
    id: 'intro',
    title: '遊戲簡介',
    icon: '📖',
    description: '這是一款以「共同創造、共同競爭」為概念的集換式卡牌遊戲。玩家們將化身粉絲，與主推以及其他 holo 成員一同打造屬於自己的舞台。一起為 holo 成員加油，並以「hololive 極限大賽」的頂點為目標！',
  },
  {
    id: 'cards',
    title: '卡牌介紹',
    icon: '🃏',
    description: 'hOCG 共有四種卡牌類型，讓我們用 Laplus Darkness（ラプラス・ダークネス）的卡片來認識它們！',
    phases: [
      {
        title: '主推卡【推しホロメンカード】',
        description: '每副牌組只能搭配 1 張。Laplus Darkness 作為主推時，生命值為 5，屬於紫色屬性。每一張主推卡都有各自的「主推技能」，以及每場比賽只能使用一次的「SP 主推技能」。',
        images: [
          { url: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10011.jpg', alt: '【Laplus Darkness】推しホロメン卡 hBP04-005 SEC' },
        ],
      },
      {
        title: 'holo 成員卡【ホロメンカード】',
        description: '收到玩家的吶喊可以展現各種表演。Laplus Darkness 有多種不同稀有度的成員卡，體力和能力各不相同。',
        images: [
          { url: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10112.jpg', alt: '【Laplus Darkness】ホロメン卡 hBP04-055 HP100' },
          { url: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10113.jpg', alt: '【Laplus Darkness】ホロメン卡 hBP04-056 HP160' },
          { url: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10116.jpg', alt: '【Laplus Darkness】ホロメン卡 hBP04-057 HP130' },
        ],
      },
      {
        title: '支援卡【サポートカード】',
        description: '在各種情況下為 holo 成員提供幫助。可以使用支援卡來強化 Laplus Darkness 或干擾對手！部分的卡牌有限制每個回合只能使用一張。',
      },
      {
        title: '吶喊卡【エールカード】',
        description: '發送給舞台上的 holo 成員。越熱情地吶喊，就可以使用越強力的藝能。為 Laplus Darkness 加油吧！',
      },
    ],
  },
  {
    id: 'field',
    title: '比賽場地',
    icon: '🏟️',
    description: '比賽場地分為 10 個區域，了解每個區域的功能是掌握遊戲的第一步。',
    images: [
      { url: 'https://truth.bahamut.com.tw/s01/202503/forum/60608/50bb74b21e4ce21b601764c993cc1a8f.JPG', alt: '比賽場地圖' },
    ],
    items: [
      { label: '① 舞台', description: '包含中心位置、聯動位置、舞台後方，舞台上只能有 6 位成員。' },
      { label: '② 主推位置', description: '放置主推卡，主推位置不屬於舞台的一部分。' },
      { label: '③ 中心位置', description: '放置 holo 成員卡，放置在這個位置被稱為「中心成員」。' },
      { label: '④ 聯動位置', description: '放置 holo 成員卡，放置在這個位置被稱為「聯動成員」。' },
      { label: '⑤ 舞台後方', description: '放置 holo 成員卡，放置在這個位置被稱為「後台成員」。' },
      { label: '⑥ 牌組', description: '由 holo 成員卡與支援卡組成的 50 張牌組，相同卡牌編號只能放 4 張。' },
      { label: '⑦ holo 能量區', description: '主推卡使用技能時要消耗的能量。' },
      { label: '⑧ 生命區', description: '玩家的生命值。' },
      { label: '⑨ 吶喊牌組', description: '由 20 張吶喊卡組成，相同卡牌編號沒有張數限制。' },
      { label: '⑩ 存檔區', description: '使用過的卡牌，或是體力歸 0 的 holo 成員以表側表示放置。' },
    ],
  },
  {
    id: 'preparation',
    title: '賽前準備',
    icon: '🎒',
    description: '比賽開始前，需要準備好以下物品並按照流程進行開局設置。',
    content: [
      '1 張主推卡',
      '一副牌組（50 張牌）',
      '一副吶喊牌組（20 張牌）',
      '傷害指示物，必要時也要準備骰子',
    ],
    phases: [
      {
        title: '開局流程',
        steps: [
          '將牌組、吶喊牌組洗牌後放到對應的位置。',
          '主推卡以表側表示放到「主推位置」。',
          '互相猜拳，贏的玩家可以選擇先攻或是後攻。',
          '從牌組抽 7 張牌。',
          '無論手牌如何，都有一次機會將所有手牌放回牌組重新洗牌，並抽出 7 張牌。',
          '手牌沒有 Debut 成員卡的場合：向對手公開手牌後，將所有手牌放回牌組重新洗牌，並重新抽出 7 張。重複 6 次後如果還是沒有 Debut 成員卡，該玩家判定為輸。',
          '手牌有 Debut 成員卡的場合，選擇 1 張以裡側表示放到「中心位置」。',
          '如果有重新抽牌的場合，依照重新抽牌的次數，將手中的牌依照喜歡的順序放回牌組下方。',
          '如果手牌還有其他 Debut 成員卡或是 Spot 成員卡，以裡側表示放到「舞台後方」。',
          '依照主推卡顯示的生命值，從吶喊牌組上方將對應數量的卡牌以裡側表示放到「生命區」。',
          '雙方玩家將 holo 成員卡翻開。',
          '先攻玩家的回合開始。',
        ],
        notes: [
          '手牌沒有 Debut 成員卡時可以多次重新抽牌，但重複 6 次後若仍沒有，則該玩家直接判輸。',
          '重新抽牌的次數會影響後續手牌放回牌組的順序。',
        ],
      },
    ],
  },
  {
    id: 'victory',
    title: '勝利條件',
    icon: '🏆',
    description: '達成以下任一條件即可獲得勝利：',
    content: [
      '✅ 對手的生命值變為 0。',
      '✅ 對手的舞台上沒有任何成員。',
      '✅ 對手的牌組剩餘 0 張，在抽牌階段無法抽牌。',
    ],
  },
  {
    id: 'states',
    title: '卡牌狀態',
    icon: '🔄',
    description: '成員卡在舞台上有兩種狀態：活動狀態與休息狀態。',
    images: [
      { url: 'https://truth.bahamut.com.tw/s01/202503/forum/60608/920137d17c1a57365c2114acba69d8f9.JPG', alt: '卡牌狀態圖' },
    ],
    phases: [
      {
        title: '活動狀態',
        description: '一般情況下，成員會以活動狀態（直置）出現在舞台上。可以正常使用藝能、進行聯動和交棒。',
      },
      {
        title: '休息狀態',
        description: '將成員橫置，稱之為「休息狀態」。可以在重置階段改為活動狀態。',
        cannotDo: [
          '使用藝能',
          '進行聯動',
          '交棒（中心成員與指定的後台成員都要是活動狀態才可以交棒）',
        ],
        canDo: [
          '進行綻放',
          '透過效果移動、替換',
        ],
      },
    ],
  },
  {
    id: 'flow',
    title: '比賽流程',
    icon: '⚡',
    description: '一個回合包含 6 個階段，每個階段都有特定的操作。',
    phases: [
      {
        title: '重置階段',
        description: '雙方最初的回合跳過此階段。',
        steps: [
          '將休息狀態的成員改為活動狀態。',
          '將聯動成員移動到舞台後方，並改為休息狀態。',
          '沒有中心成員的場合，將 1 位活動狀態的後台成員移動到中心位置。如果沒有活動狀態的成員，則將 1 位休息狀態的成員移動到中心位置。',
        ],
      },
      {
        title: '抽牌階段',
        description: '從牌組抽 1 張牌。',
        notes: [
          '牌組剩餘 0 張，在抽牌階段無法抽牌的場合，該玩家判定為輸。',
        ],
      },
      {
        title: '吶喊階段',
        description: '從吶喊牌組上方展示 1 張牌，發送給舞台上的成員。',
        notes: [
          '吶喊牌組剩餘 0 張的場合，直接進入主要階段。',
        ],
      },
      {
        title: '主要階段',
        description: '以下操作可以按任意順序執行：',
        steps: [],
        subPhases: [
          {
            title: '放置成員',
            description: '將手牌的 Debut 成員與 Spot 成員放到舞台後方，舞台上最多只能有 6 位成員。1st 成員與 2nd 成員不能直接放到舞台上。',
          },
          {
            title: '進行綻放',
            description: '從手牌將同名卡重疊進行綻放，等級依照順序：Debut → 1st → 2nd。每一位成員每個回合都可以綻放一次。綻放後的「狀態」「傷害」「吶喊卡」「支援卡」都會維持原狀。',
            conditions: [
              '雙方最初的回合',
              '成員放到舞台上的當回合',
              '成員綻放的當回合',
              '綻放等級下降',
              '傷害超過成員綻放後的 HP',
              'Debut → Debut',
            ],
          },
          {
            title: '使用支援卡',
            description: '可以使用任意數量的支援卡。一般情況下，使用後會放到存檔區，也有部分卡牌會附加在成員身上。',
            notes: [
              '一旦附加在成員身上，就不能隨意更換為其他成員。',
              '標示「LIMITED」的卡牌，每個回合只能使用一張。即使不同卡名也不能在同一個回合使用。',
              '先攻玩家最初的回合無法使用。',
            ],
          },
          {
            title: '使用主推的技能',
            description: '將對應數量的卡牌從 holo 能量區上方以表側表示放到存檔區，可以使用「主推技能」與「SP 主推技能」。',
          },
          {
            title: '進行聯動',
            description: '每個回合一次，將牌組上方的 1 張牌以裡側表示放到 holo 能量區，將活動狀態的後台成員移動到聯動位置。聯動成員直到自己下一個回合的重置階段才能移動。',
            notes: [
              '休息狀態的成員不能聯動。',
              '牌組剩餘 0 張，無法將卡牌放到 holo 能量區的場合不能聯動。',
              '沒有可以聯動的成員，不能從牌組將卡牌放到 holo 能量區。',
            ],
          },
          {
            title: '交棒',
            description: '將中心成員對應數量的吶喊卡放到存檔區，可以與 1 位後台成員進行替換。',
            notes: [
              '中心成員與指定的後台成員都要是活動狀態才可以交棒。',
              '無法將對應數量的吶喊卡放到存檔區的場合，不能交棒。',
              '除了效果或是支援卡外，每個回合只能交棒一次。',
            ],
          },
        ],
      },
      {
        title: '表演階段',
        description: '先攻玩家最初的回合跳過。決定中心成員與聯動成員各可以使用一次藝能。如果選擇不使用藝能，則直接進入結束階段。',
        notes: [
          '先攻玩家最初的回合不能使用藝能。',
          '休息狀態的成員不能使用藝能。',
        ],
        steps: [
          '選擇目標 — 選擇對手的中心成員或是聯動成員。',
          '使用藝能確認傷害：觸發藝能的效果。如果特攻的顏色與對手的成員相同，則增加該數值的傷害。',
        ],
        conditions: [
          '擊倒：如果成員的體力歸 0，稱為「擊倒」，將該成員與附加的所有卡牌放到存檔區。該玩家的生命值 -1。',
          '生命值減少：生命值減少的玩家，從生命區上方展示 1 張牌，發送給舞台上的成員。生命區沒有卡牌的瞬間，判定為輸。',
        ],
        subPhases: [
          {
            title: '擊倒時的處理方式',
            description: '當成員被擊倒時，按照以下順序處理（如果有多位成員被擊倒，每一位依序處理）：',
            steps: [
              '觸發「被擊倒時」與「擊倒時」的效果。',
              '將該成員與附加的所有卡牌放到存檔區。',
            ],
          },
          {
            title: '生命值減少的處理方式',
            description: '成員的擊倒處理完成後，從生命區上方展示 1 張牌，發送給舞台上的成員。如果有多位成員被擊倒，依照擊倒的次數重複執行。',
          },
        ],
      },
      {
        title: '結束階段',
        steps: [
          '標示「這個回合中」的效果會無效。',
          '自己沒有中心成員的場合，執行重置階段的③（將後台成員移動到中心位置）。',
          '如果自己的舞台上只有聯動成員，則將回合轉移給對手。',
        ],
      },
    ],
  },
  {
    id: 'references',
    title: '參考資料',
    icon: '🔗',
    links: [
      { label: 'hololive OFFICIAL CARD GAME 官方網站', url: 'https://hololive-official-cardgame.com/' },
      { label: 'hololive OCG 官方 X (Twitter)', url: 'https://x.com/hololive_OCG' },
      { label: 'hololive-cardgame.github.io 卡牌資料站', url: 'https://hololive-cardgame.github.io/cards/' },
    ],
  },
];

export function getTutorialData(language: LanguageCode): TutorialSection[] {
  return language === 'ja' ? tutorialDataJa : tutorialData;
}

export default tutorialData;
