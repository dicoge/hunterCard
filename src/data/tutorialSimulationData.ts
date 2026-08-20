/**
 * 模擬實戰教學 — 互動式對局步驟資料
 * 引導初學者體驗 hOCG 一場簡化對局
 */
import type { SimPhase } from '../types';
import type { LanguageCode } from '../store/settingsStore';
import simulationPhasesJa from './tutorialSimulationDataJa';

export interface SimulationCardRef {
  id: string;
  name: string;
  imageUrl: string;
}

export interface SimulationStep {
  phaseId: SimPhase;
  stepNumber: number;
  title: string;
  description: string;
  highlightZone?: string;
  actionLabel?: string;
  explanation?: string;
  cardRef?: SimulationCardRef;
}

export interface SimulationPhase {
  id: string;
  title: string;
  icon: string;
  steps: SimulationStep[];
}

const laplusOshiCard: SimulationCardRef = {
  id: 'hbp04-005',
  name: 'Laplus Darkness（推し）',
  imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10011.jpg',
};

const laplusHolomenCard: SimulationCardRef = {
  id: 'hbp04-055',
  name: 'Laplus Darkness（ホロメン）',
  imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10112.jpg',
};

const simulationPhases: SimulationPhase[] = [
  {
    id: 'setup',
    title: '開場準備',
    icon: '🎒',
    steps: [
      {
        phaseId: 'setup',
        stepNumber: 1,
        title: '選擇主推',
        description: '將你的主推卡「Laplus Darkness」放到主推位置。',
        highlightZone: 'oshi',
        actionLabel: '放置主推卡',
        explanation: '主推卡是牌組的核心，每副牌組只能放 1 張。Laplus 的生命值為 5。',
        cardRef: laplusOshiCard,
      },
      {
        phaseId: 'setup',
        stepNumber: 2,
        title: '設置牌組',
        description: '將你的 50 張牌組洗牌後放到牌組區。',
        highlightZone: 'deck',
        actionLabel: '放置牌組',
        explanation: '牌組由 holo 成員卡與支援卡組成，相同卡牌編號最多放 4 張。',
      },
      {
        phaseId: 'setup',
        stepNumber: 3,
        title: '猜拳決定先後攻',
        description: '與對手猜拳，贏家可以選擇先攻或後攻。',
        actionLabel: '猜拳！',
        explanation: '先攻玩家最初的回合跳過表演階段，且不能使用支援卡。',
      },
    ],
  },
  {
    id: 'reset',
    title: '重置階段',
    icon: '🔄',
    steps: [
      {
        phaseId: 'reset',
        stepNumber: 1,
        title: '回復活動狀態',
        description: '將所有休息狀態的成員轉為活動狀態（直置）。',
        highlightZone: 'center',
        actionLabel: '回復成員',
        explanation: '第一回合跳過重置階段。重置後，休息的成員就可以再次行動了！',
      },
    ],
  },
  {
    id: 'draw',
    title: '抽牌階段',
    icon: '📚',
    steps: [
      {
        phaseId: 'draw',
        stepNumber: 1,
        title: '抽 1 張牌',
        description: '從牌組上方抽 1 張牌加入手牌。',
        highlightZone: 'deck',
        actionLabel: '抽牌',
        explanation: '如果牌組剩 0 張無法抽牌，該玩家直接判輸。',
      },
    ],
  },
  {
    id: 'cheer',
    title: '吶喊階段',
    icon: '📣',
    steps: [
      {
        phaseId: 'cheer',
        stepNumber: 1,
        title: '展示吶喊卡',
        description: '從吶喊牌組上方展示 1 張牌，發送給舞台上的成員。',
        highlightZone: 'cheerDeck',
        actionLabel: '展示吶喊卡',
        explanation: '吶喊卡可以用來強化成員的藝能，越熱情的吶喊效果越強！',
      },
    ],
  },
  {
    id: 'main',
    title: '主要階段',
    icon: '⚡',
    steps: [
      {
        phaseId: 'main',
        stepNumber: 1,
        title: '放置成員',
        description: '從手牌選擇 1 張 Debut 成員卡，以裡側表示放到舞台後方。',
        highlightZone: 'backstage',
        actionLabel: '放置成員',
        explanation: '舞台上最多只能有 6 位成員。1st 與 2nd 成員不能直接放到舞台上。',
        cardRef: laplusHolomenCard,
      },
      {
        phaseId: 'main',
        stepNumber: 2,
        title: '進行綻放',
        description: '從手牌將同名的 Debut 卡重疊在舞台上的成員上進行綻放，升級為 1st 成員。',
        highlightZone: 'center',
        actionLabel: '綻放升級',
        explanation: '綻放後，該成員的狀態、傷害、附加卡都會維持不變。每位成員每回合只能綻放一次。',
      },
      {
        phaseId: 'main',
        stepNumber: 3,
        title: '使用支援卡',
        description: '從手牌使用 1 張支援卡來強化你的成員或干擾對手。',
        highlightZone: 'center',
        actionLabel: '使用支援卡',
        explanation: '支援卡使用後通常會放到存檔區。標示「LIMITED」的卡牌每回合只能使用一張。',
      },
      {
        phaseId: 'main',
        stepNumber: 4,
        title: '使用主推技能',
        description: '將 holo 能量區的卡牌放到存檔區，發動 Laplus 的主推技能！',
        highlightZone: 'energy',
        actionLabel: '發動技能',
        explanation: '消耗能量可以發動強大的主推技能。SP 主推技能每場比賽只能使用一次。',
        cardRef: laplusOshiCard,
      },
      {
        phaseId: 'main',
        stepNumber: 5,
        title: '進行聯動',
        description: '將牌組上方的 1 張牌放到 holo 能量區，並將活動狀態的後台成員移動到聯動位置。',
        highlightZone: 'collab',
        actionLabel: '聯動',
        explanation: '聯動成員直到下一個重置階段才能移動。休息狀態的成員不能聯動。',
      },
      {
        phaseId: 'main',
        stepNumber: 6,
        title: '交棒',
        description: '將中心成員的吶喊卡放到存檔區，與 1 位活動狀態的後台成員交換位置。',
        highlightZone: 'backstage',
        actionLabel: '交棒',
        explanation: '中心成員與指定的後台成員都要是活動狀態才能交棒。每回合只能交棒一次。',
      },
    ],
  },
  {
    id: 'performance',
    title: '表演階段',
    icon: '🎭',
    steps: [
      {
        phaseId: 'performance',
        stepNumber: 1,
        title: '選擇攻擊目標',
        description: '選擇對手的中心成員或聯動成員作為攻擊目標。',
        highlightZone: 'center',
        actionLabel: '選擇目標',
        explanation: '先攻玩家最初的回合跳過表演階段。休息狀態的成員不能使用藝能。',
      },
      {
        phaseId: 'performance',
        stepNumber: 2,
        title: '使用藝能',
        description: '使用中心成員或聯動成員的藝能攻擊目標成員！',
        highlightZone: 'center',
        actionLabel: '發動藝能',
        explanation: '如果特攻的顏色與對手成員相同，會增加額外傷害。',
      },
      {
        phaseId: 'performance',
        stepNumber: 3,
        title: '確認傷害與擊倒',
        description: '計算傷害總量。如果目標成員體力歸 0，該成員被擊倒並放到存檔區，對手生命值 -1。',
        highlightZone: 'life',
        actionLabel: '確認結果',
        explanation: '生命值減少的玩家，從生命區上方展示 1 張牌發送給成員。生命區沒牌時即判輸。',
      },
    ],
  },
  {
    id: 'end',
    title: '結束階段',
    icon: '🏁',
    steps: [
      {
        phaseId: 'end',
        stepNumber: 1,
        title: '回合結束',
        description: '結束當前回合。「這個回合中」的效果失效，換對手的回合開始。',
        actionLabel: '結束回合',
        explanation: '如果舞台上沒有中心成員，需要將後台成員移動到中心位置。然後將回合轉移給對手。',
      },
    ],
  },
];

export function getSimulationPhases(language: LanguageCode): SimulationPhase[] {
  return language === 'ja' ? simulationPhasesJa : simulationPhases;
}

export default simulationPhases;
