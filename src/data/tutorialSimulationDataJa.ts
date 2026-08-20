import type { SimulationCardRef, SimulationPhase } from './tutorialSimulationData';

const laplusOshiCard: SimulationCardRef = {
  id: 'hbp04-005',
  name: 'ラプラス・ダークネス（推しホロメン）',
  imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10011.jpg',
};

const laplusHolomenCard: SimulationCardRef = {
  id: 'hbp04-055',
  name: 'ラプラス・ダークネス（ホロメン）',
  imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10112.jpg',
};

const simulationPhasesJa: SimulationPhase[] = [
  {
    id: 'setup',
    title: 'ゲームの準備',
    icon: '🎒',
    steps: [
      {
        phaseId: 'setup', stepNumber: 1, title: '推しホロメンを選ぶ',
        description: '推しホロメンカード「ラプラス・ダークネス」を推しホロメンポジションに置きます。',
        highlightZone: 'oshi', actionLabel: '推しホロメンを置く',
        explanation: '推しホロメンカードはデッキの中心です。デッキには1枚だけ置けます。ラプラスのライフは5です。',
        cardRef: laplusOshiCard,
      },
      {
        phaseId: 'setup', stepNumber: 2, title: 'デッキを用意する',
        description: '50枚のデッキをシャッフルしてデッキ置き場に置きます。',
        highlightZone: 'deck', actionLabel: 'デッキを置く',
        explanation: 'デッキはホロメンカードとサポートカードで構成します。同じカードナンバーは4枚までです。',
      },
      {
        phaseId: 'setup', stepNumber: 3, title: 'じゃんけんで先攻・後攻を決める',
        description: '相手とじゃんけんを行い、勝ったプレイヤーが先攻か後攻を選びます。',
        actionLabel: 'じゃんけん！',
        explanation: '先攻プレイヤーは最初のターンにパフォーマンスステップを飛ばし、サポートカードも使えません。',
      },
    ],
  },
  {
    id: 'reset', title: 'リセットステップ', icon: '🔄',
    steps: [{
      phaseId: 'reset', stepNumber: 1, title: 'アクティブ状態に戻す',
      description: 'レスト状態のホロメンをすべて縦向きのアクティブ状態にします。',
      highlightZone: 'center', actionLabel: 'ホロメンを起こす',
      explanation: '最初のターンはリセットステップを飛ばします。アクティブに戻ったホロメンは再び行動できます。',
    }],
  },
  {
    id: 'draw', title: 'ドローステップ', icon: '📚',
    steps: [{
      phaseId: 'draw', stepNumber: 1, title: 'カードを1枚引く',
      description: 'デッキの上からカードを1枚引いて手札に加えます。',
      highlightZone: 'deck', actionLabel: 'カードを引く',
      explanation: 'デッキが0枚でカードを引けない場合、そのプレイヤーは敗北します。',
    }],
  },
  {
    id: 'cheer', title: 'エールステップ', icon: '📣',
    steps: [{
      phaseId: 'cheer', stepNumber: 1, title: 'エールカードを公開する',
      description: 'エールデッキの上から1枚を公開し、ステージのホロメンに送ります。',
      highlightZone: 'cheerDeck', actionLabel: 'エールカードを公開',
      explanation: 'エールカードはホロメンのアーツを強化します。エールを重ねて強力なアーツを使いましょう。',
    }],
  },
  {
    id: 'main', title: 'メインステップ', icon: '⚡',
    steps: [
      {
        phaseId: 'main', stepNumber: 1, title: 'ホロメンを登場させる',
        description: '手札からDebutホロメンカード1枚を選び、裏向きでバックステージに置きます。',
        highlightZone: 'backstage', actionLabel: 'ホロメンを置く',
        explanation: 'ステージにはホロメンを6人まで置けます。1stホロメンと2ndホロメンは直接出せません。',
        cardRef: laplusHolomenCard,
      },
      {
        phaseId: 'main', stepNumber: 2, title: 'ブルームする',
        description: '手札の同名カードをステージのホロメンに重ね、Debutから1stへブルームします。',
        highlightZone: 'center', actionLabel: 'ブルーム',
        explanation: 'ブルーム後も状態、ダメージ、付いているカードを引き継ぎます。各ホロメンは1ターンに1回だけブルームできます。',
      },
      {
        phaseId: 'main', stepNumber: 3, title: 'サポートカードを使う',
        description: '手札からサポートカードを1枚使い、自分のホロメンを強化したり相手を妨害したりします。',
        highlightZone: 'center', actionLabel: 'サポートカードを使う',
        explanation: '通常、使ったサポートカードはアーカイブへ置きます。「LIMITED」のカードは1ターンに1枚だけ使えます。',
      },
      {
        phaseId: 'main', stepNumber: 4, title: '推しスキルを使う',
        description: 'ホロパワーのカードをアーカイブへ置き、ラプラスの推しスキルを使います。',
        highlightZone: 'energy', actionLabel: 'スキルを使う',
        explanation: 'ホロパワーを消費して強力な推しスキルを使えます。SP推しスキルはゲーム中に1回だけ使えます。',
        cardRef: laplusOshiCard,
      },
      {
        phaseId: 'main', stepNumber: 5, title: 'コラボする',
        description: 'デッキの上から1枚をホロパワーへ置き、アクティブ状態のバックホロメンをコラボポジションへ移動します。',
        highlightZone: 'collab', actionLabel: 'コラボ',
        explanation: 'コラボホロメンは次のリセットステップまで移動できません。レスト状態のホロメンはコラボできません。',
      },
      {
        phaseId: 'main', stepNumber: 6, title: 'バトンタッチする',
        description: 'センターホロメンのエールカードをアーカイブへ置き、アクティブ状態のバックホロメン1人と交代します。',
        highlightZone: 'backstage', actionLabel: 'バトンタッチ',
        explanation: '交代する2人はどちらもアクティブ状態である必要があります。バトンタッチは1ターンに1回だけです。',
      },
    ],
  },
  {
    id: 'performance', title: 'パフォーマンスステップ', icon: '🎭',
    steps: [
      {
        phaseId: 'performance', stepNumber: 1, title: '攻撃対象を選ぶ',
        description: '相手のセンターホロメンまたはコラボホロメンを攻撃対象に選びます。',
        highlightZone: 'center', actionLabel: '対象を選ぶ',
        explanation: '先攻プレイヤーは最初のターンにこのステップを飛ばします。レスト状態のホロメンはアーツを使えません。',
      },
      {
        phaseId: 'performance', stepNumber: 2, title: 'アーツを使う',
        description: 'センターホロメンまたはコラボホロメンのアーツで相手を攻撃します。',
        highlightZone: 'center', actionLabel: 'アーツを使う',
        explanation: '特攻の色が相手ホロメンの色と同じなら、追加ダメージを与えます。',
      },
      {
        phaseId: 'performance', stepNumber: 3, title: 'ダメージとダウンを確認する',
        description: '合計ダメージを計算します。相手ホロメンのHPが0になったらダウンし、アーカイブへ置いて相手のライフを1減らします。',
        highlightZone: 'life', actionLabel: '結果を確認',
        explanation: 'ライフが減ったプレイヤーは、ライフの上から1枚を公開してホロメンに送ります。ライフが0枚になると敗北です。',
      },
    ],
  },
  {
    id: 'end', title: 'エンドステップ', icon: '🏁',
    steps: [{
      phaseId: 'end', stepNumber: 1, title: 'ターンを終える',
      description: '現在のターンを終了します。「このターンの間」の効果が終わり、相手のターンになります。',
      actionLabel: 'ターン終了',
      explanation: 'センターホロメンがいなければ、バックホロメンをセンターポジションへ移動してから相手へターンを渡します。',
    }],
  },
];

export default simulationPhasesJa;
