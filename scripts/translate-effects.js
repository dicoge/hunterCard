#!/usr/bin/env node
/**
 * scripts/translate-effects.js
 *
 * Reads data/effects-jp.json, translates every skill/effect string to
 * Traditional Chinese, and writes data/effects-zh.json (same structure).
 *
 * - Deduplicates strings before translating (many effects repeat across cards).
 * - Caches translations in data/_translation-cache.json so runs are resumable.
 * - Batches requests to the OpenRouter chat-completions endpoint.
 *
 * Term protection (P1 fix): reserved game terms (ホロメン, アーツ, エール, コラボ …)
 * are masked with sentinels before the model sees them and restored afterwards,
 * so the model can never translate them. This is deterministic regardless of
 * how the model behaves.
 *
 * Traditional-Chinese normalization (P2 fix): translated strings pass through an
 * unambiguous simplified→traditional map so stray simplified characters are
 * corrected. Only translated text is normalized — retained Japanese card names
 * are never touched.
 *
 * API key: providers[0].api_key from ~/.claude-code-router/config.json
 * (OpenRouter). Model: deepseek/deepseek-v4-flash (Claude Haiku is not exposed
 * on this key). Override with TRANSLATE_MODEL env var.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const IN_FILE = path.join(DATA_DIR, 'effects-jp.json');
const OUT_FILE = path.join(DATA_DIR, 'effects-zh.json');
const CACHE_FILE = path.join(DATA_DIR, '_translation-cache.json');

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.TRANSLATE_MODEL || 'deepseek/deepseek-v4-flash';
const BATCH_SIZE = 20;
const CONCURRENCY = 6;
const NL = '⏎'; // newline placeholder for line-based transport

// Reserved terms that MUST stay in their original Latin form. The product
// requirement (DIC-465) is that every zh field is fully Chinese with no
// Japanese kana, so katakana game terms are NO LONGER reserved — they are
// translated to canonical Chinese by GLOSSARY_ZH below. Only Latin-script
// abbreviations that have no Chinese equivalent stay verbatim.
const RESERVED_TERMS = [
  'LIMITED', 'Debut', 'Bloom', 'RUSH', 'Buzz',
].sort((a, b) => b.length - a.length);

// Canonical Japanese-game-term -> Traditional-Chinese map, applied
// deterministically to every finalized translation so the output stays
// consistent regardless of how the LLM renders a given term. Longest-first so
// compounds resolve before their atoms (推しホロメン before ホロメン).
const GLOSSARY_ZH = [
  ['サポート', '支援'], ['アイテム', '道具'],
  ['推しホロメン', '主推成員'], ['推しスキル', '主推技能'],
  ['センターホロメン', '中央成員'], ['コラボホロメン', '協力成員'],
  ['バックホロメン', '後方成員'], ['ホロメンダウン', '成員倒下'],
  ['ホロメンコラボ', '成員協力'], ['センターポジション', '中央位置'],
  ['ホロサマー', 'Holo夏日'], ['バトンタッチ', '換手'],
  ['ホロパワー', '能量'], ['アーカイブ', '檔案'], ['マスコット', '吉祥物'],
  ['ゲーマーズ', '遊戲人'], ['ポジション', '位置'], ['イベント', '事件'],
  ['スタッフ', '工作人員'], ['ブルーム', '綻放'], ['センター', '中央'],
  ['ホロメン', '成員'], ['アーツ', '招式'], ['エール', '應援'],
  ['コラボ', '協力'], ['ダウン', '倒下'], ['ギフト', '禮物'],
  ['ファン', '粉絲'], ['バック', '後方'], ['サマー', '夏日'],
  ['ラッシュ', '衝刺'], ['推し', '主推'], ['ツール', '工具'],
];

// Encoding-damaged source strings (mojibake in the scrape) mapped to their
// correct Chinese form. Applied verbatim before the term glossary.
const REPAIRS = [
  ['ホロ��ン', '成員'],
  ['七詩ムメ���', '七詩無名'],
  ['好味ー！', '好味～！'],
];

function canonicalizeTerms(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s.split('･').join('・');
  for (const [jp, zh] of REPAIRS) out = out.split(jp).join(zh);
  for (const [jp, zh] of GLOSSARY_ZH) out = out.split(jp).join(zh);
  return out.split('・').join('·');
}

const SYSTEM_PROMPT = `你是專業的桌遊翻譯，將 hololive OFFICIAL CARD GAME 的日文卡牌技能文字翻譯成繁體中文（台灣用語）。規則：
1. 【最重要】遊戲術語一律翻成下列固定的繁體中文，不可保留日文假名、不可音譯、不可寫成英文：
   ホロメン→成員、推しスキル→主推技能、SP推しスキル→SP主推技能、アーツ→招式、ホロパワー→能量、エール→應援、コラボ→協力、バトンタッチ→換手、ブルーム→綻放、センター→中央、バック→後方、ギフト→禮物、ダウン→倒下、サポート→支援、アイテム→道具、ツール→工具、マスコット→吉祥物、ファン→粉絲、イベント→事件、アーカイブ→檔案、ポジション→位置。
   只有純拉丁字母的縮寫保留原文，不要翻譯：Buzz、LIMITED、Debut、Bloom、RUSH。
   （整段譯文不可出現任何日文平假名或片假名。）
2. 文字中若出現形如 ⟦0⟧ ⟦1⟧ 的佔位符，請原樣保留、不要翻譯、不要改動、不要增減，位置與原文一致。
3. 一般遊戲詞彙照此翻譯：デッキ→牌組、手札→手牌、ステージ→場上、ライフ→生命、ダメージ→傷害、相手→對手、自分→自己、選ぶ→選擇、公開→展示、引く→抽。
4. 保留所有數字、+、-、括號與符號結構，例如 [ターンに1回]→[每回合1次]、[ゲームに1回]→[每場遊戲1次]。
5. 保留換行符號 ⏎，位置與原文一致。
6. 只輸出翻譯結果，不要加任何解釋、引號、標題或 Markdown 標記（例如 **翻譯**：）。
7. 必須使用繁體中文（台灣用語），絕對不可使用簡體字（例如「张」要寫成「張」、「个」要寫成「個」）。`;

// ---- Reserved-term protection ------------------------------------------------

// Sentinel format is pure ASCII alphanumeric (zZ<n>Zz). Punctuation-based
// tokens ([[n]], #n#, @@n@@) collide with game text ([每回合1次], #3期生, …) or
// get mangled by the model under batch load; alphanumeric runs are preserved
// verbatim far more reliably.
function makeToken(n) { return `zZ${n}Zz`; }
const TOKEN_RE = /zZ(\d+)Zz/g;
// Any residual sentinel fragment (well-formed or corrupted) — used to detect a
// translation the model mangled so we can retry it in single-string mode.
const TOKEN_ARTIFACT_RE = /zZ|Zz|⟦|⟧/;

function protectString(s) {
  const map = [];
  let out = s;
  for (const term of RESERVED_TERMS) {
    let idx;
    while ((idx = out.indexOf(term)) !== -1) {
      const token = makeToken(map.length);
      map.push(term);
      out = out.slice(0, idx) + token + out.slice(idx + term.length);
    }
  }
  return { masked: out, map };
}

function restoreString(s, map) {
  return s.replace(TOKEN_RE, (m, n) => {
    const i = parseInt(n, 10);
    return i >= 0 && i < map.length ? map[i] : m;
  });
}

// ---- Simplified → Traditional normalization ---------------------------------
// Only unambiguous 1:1 mappings are listed. Context-ambiguous simplified chars
// (后/裡/發/臺/準/沖/係… — traditional form depends on meaning) are deliberately
// omitted to avoid introducing wrong characters; the validation pass warns if
// any simplified character survives.
const S2T_PAIRS = '张張 个個 们們 这這 来來 国國 东東 车車 门門 问問 间間 应應 关關 无無 会會 过過 还還 进進 远遠 连連 运運 达達 选選 择擇 样樣 观觀 觉覺 让讓 记記 认認 识識 说說 读讀 译譯 语語 请請 课課 谁誰 护護 报報 额額 预預 顾顧 题題 风風 飞飛 鱼魚 鸟鳥 马馬 龙龍 岁歲 点點 热熱 爱愛 书書 专專 业業 丝絲 乐樂 习習 乡鄉 写寫 军軍 农農 决決 况況 净淨 减減 击擊 则則 刚剛 单單 双雙 变變 图圖 团團 网網 电電 时時 华華 数數 边邊 顺順 种種 称稱 积積 类類 红紅 级級 给給 继繼 结結 绝絕 统統 续續 维維 组組 细細 终終 经經 绿綠 线線 纸紙 约約 纪紀 总總 标標 树樹 极極 构構 检檢 权權 机機 条條 义義 举舉 买買 卖賣 争爭 产產 从從 价價 众眾 优優 传傳 伤傷 体體 战戰 号號 与與 为為 现現 场場 处處 备備 惊驚 态態 愿願 忆憶 拥擁 换換 损損 敌敵 断斷 旧舊 显顯 术術 杀殺 枪槍 楼樓 欢歡 汉漢 洁潔 济濟 满滿 灵靈 灾災 烟煙 独獨 环環 画畫 疗療 码碼 确確 礼禮 离離 种種 稳穩 穷窮 竖豎 笔筆 简簡 紧緊 罗羅 联聯 肠腸 脑腦 节節 苏蘇 药藥 获獲 营營 萝蘿 蓝藍 补補 装裝 见見 规規 觉覺 认認 讨討 训訓 议議 讯訊 讲講 许許 论論 设設 访訪 证證 评評 诉訴 词詞 译譯 试試 诗詩 诚誠 话話 询詢 该該 详詳 误誤 说說 请請 诸諸 读讀 课課 谁誰 调調 谈談 谋謀 谓謂 谢謝 谦謙 谨謹 谱譜 财財 资資 赏賞 赔賠 赞贊 赢贏 赵趙 趋趨 轨軌 转轉 轮輪 软軟 载載 较較 辆輛 迁遷 违違 迟遲 迹跡 适適 递遞 逻邏 遗遺 邓鄧 郑鄭 释釋 针針 钉釘 钓釣 钢鋼 钩鉤 铁鐵 铃鈴 铅鉛 铜銅 铝鋁 银銀 铺鋪 链鏈 销銷 锁鎖 锅鍋 锋鋒 错錯 锡錫 锤錘 锦錦 键鍵 镜鏡 长長 闪閃 闭閉 闯闖 闷悶 闹鬧 闻聞 阁閣 阅閱 队隊 阶階 阵陣 阳陽 阴陰 陆陸 陈陳 险險 隐隱 难難 雏雛 雾霧 页頁 顶頂 顷頃 项項 顺順 须須 顽頑 顾顧 顿頓 颁頒 预預 领領 颇頗 颈頸 频頻 颗顆 题題 颜顏 额額 颠顛 风風 飘飄 飞飛 饥飢 饭飯 饮飲 饰飾 饱飽 饲飼 饼餅 馆館 驱驅 驶駛 驻駐 驾駕 骂罵 骄驕 验驗 骤驟 髅髏 鱼魚 鲁魯 鲜鮮 鳄鰐 鸟鳥 鸡雞 鸣鳴 鸦鴉 鸭鴨 鸿鴻 鹅鵝 鹏鵬 鹰鷹 麦麥 黄黃 齐齊 齿齒 龄齡 龙龍 龟龜 阵陣 场場 团團 员員 围圍 圆圓 块塊 坏壞 坚堅 垒壘 墙牆 壶壺 处處 备備 复複 够夠 夹夾 奋奮 妆妝 娱娛 娄婁 孙孫 学學 宁寧 实實 宝寶 审審 宪憲 宫宮 宽寬 对對 寻尋 导導 尔爾 尘塵 尽盡 层層 属屬 岛島 峡峽 币幣 帅帥 师師 帮幫 带帶 帧幀 幂冪 广廣 庄莊 庆慶 废廢 开開 异異 弃棄 张張 弯彎 归歸 录錄 彻徹 径徑 忧憂 怀懷 怜憐 总總 恳懇 恶惡 恼惱 悬懸 惯慣 愤憤 懒懶 戏戲 扑撲 执執 扩擴 扫掃 扬揚 抚撫 抛拋 拟擬 择擇 挂掛 挠撓 挡擋 挣掙 捞撈 损損 换換 据據 掷擲 摄攝 摆擺 撑撐 击擊 攒攢 敌敵 斋齋 斗鬥 时時 昆昆 昙曇 晒曬 晓曉 暂暫 术術 机機 权權 杆桿 条條 来來 杨楊 极極 构構 枢樞 枣棗 枪槍 柜櫃 标標 栋棟 树樹 样樣 桥橋 检檢 楼樓 概概 榄欖 横橫 欧歐 欢歡 歼殲 殁歿 毁毀 毕畢 毙斃 汇匯 汉漢 沟溝 沦淪 沧滄 泞濘 泪淚 泼潑 泽澤 洁潔 浃浹 测測 浏瀏 济濟 浑渾 浓濃 涛濤 涝澇 润潤 涧澗 涨漲 渊淵 渐漸 渔漁 温溫 湾灣 溃潰 满滿 滚滾 滤濾 滨濱 滩灘 潜潛 潴瀦 灭滅 灯燈 灵靈 灾災 炉爐 点點 烦煩 烧燒 烫燙 热熱 焕煥 爱愛 牍牘 牵牽 犊犢 状狀 狈狽 狮獅 独獨 狭狹 狱獄 猎獵 猫貓 献獻 猪豬 环環 现現 玛瑪 珐琺 珑瓏 琼瓊 瑶瑤 璎瓔 瓯甌 电電 画畫 畅暢 疖癤 疗療 疟瘧 疡瘍 疮瘡 疯瘋 痒癢 痪瘓 痴癡 瘫癱 皑皚 盏盞 监監 盖蓋 盘盤 眍瞘 睁睜 瞒瞞 矫矯 矶磯 码碼 硕碩 硖硤 确確 碍礙 礼禮 祢禰 祸禍 秃禿 积積 称稱 秽穢 稆穭 稳穩 穑穡 穷窮 窃竊 窜竄 窝窩 竖豎 竞競 笔筆 笋筍 笼籠 筑築 筛篩 筹籌 签簽 简簡 箩籮 篓簍 类類 籴糴 粜糶 粝糲 粪糞 粮糧 紧緊 絷縶 纟糸 纠糾 纡紆 红紅 纣紂 纤纖 纥紇 约約 级級 纨紈 纩纊 纪紀 纫紉 纬緯 纭紜 纯純 纰紕 纱紗 纲綱 纳納 纵縱 纶綸 纷紛 纸紙 纹紋 纺紡 纽紐 线線 绀紺 绁紲 练練 组組 绅紳 细細 织織 终終 绊絆 绍紹 绎繹 经經 绐紿 绑綁 绒絨 结結 绕繞 绗絎 绘繪 给給 绚絢 络絡 绝絕 绞絞 统統 绠綆 绢絹 绣繡 绥綏 继繼 绩績 绪緒 绫綾 续續 绮綺 绯緋 绰綽 绳繩 维維 绵綿 绶綬 绷繃 绸綢 综綜 绽綻 绿綠 缀綴 缁緇 缂緙 缄緘 缅緬 缆纜 缈緲 缉緝 缍綞 缎緞 缓緩 缔締 缕縷 编編 缗緡 缘緣 缙縉 缚縛 缛縟 缜縝 缝縫 缟縞 缠纏 缢縊 缣縑 缤繽 缥縹 缦縵 缧縲 缨纓 缩縮 缪繆 缫繅 缬纈 缭繚 缮繕 缯繒 缰韁 缱繾 缲繰 缳繯 缴繳 缵纘 网網 罗羅 罚罰 罢罷 羁羈 义義 习習 翘翹 耢耮 耧耬 联聯 聂聶 聋聾 职職 聍聹 肃肅 肠腸 肤膚 肮骯 肾腎 肿腫 胀脹 胁脅 胆膽 胨腖 胧朧 胫脛 胶膠 脉脈 脍膾 脏臟 脐臍 脑腦 脓膿 脔臠 脸臉 腊臘 腭齶 腻膩 腾騰 膑臏 舆輿 舣艤 舰艦 舱艙 舻艫 艰艱 节節 芜蕪 苇葦 苈藶 苋莧 苌萇 苍蒼 苎苧 茎莖 茏蘢 茑蔦 荆荊 荐薦 荙薘 荚莢 荛蕘 荜蓽 荞蕎 荟薈 荠薺 荡蕩 荣榮 荤葷 荥滎 荦犖 荧熒 荩藎 荪蓀 荫蔭 荭葒 荮葤 药藥 莅蒞 莱萊 莲蓮 莳蒔 莴萵 莸蕕 莹瑩 莺鶯 萝蘿 萤螢 营營 萦縈 萧蕭 萨薩 葱蔥 蒇蕆 蒉蕢 蒋蔣 蒌蔞 蓝藍 蓟薊 蓠蘺 蓣蕷 蓥鎣 蓦驀 蔷薔 蔹蘞 蔺藺 蔼藹 蕲蘄 薮藪 藓蘚 蘖櫱 虏虜 虑慮 虚虛 虫蟲 虬虯 虮蟣 虽雖 虾蝦 虿蠆 蚀蝕 蚁蟻 蚂螞 蚕蠶 蚬蜆 蛊蠱 蛎蠣 蛏蟶 蛱蛺 蛲蟯 蛳螄 蛴蠐 蜕蛻 蜗蝸 蜡蠟 蝇蠅 蝈蟈 蝉蟬 蝌蝌 蝼螻 蝾蠑 螀螿 螨蟎 蟏蠨 衅釁 衔銜 补補 表錶 衬襯 衮袞 袄襖 袆褘 袜襪 袭襲 袯襏 装裝 裆襠 裢褳 裣襝 裤褲 裥襉 褛褸 褴襤 襕襴 见見 观觀 觃覎 规規 觅覓 视視 觇覘 览覽 觉覺 觊覬 觋覡 觌覿 觍覥 觎覦 觏覯 觐覲 觑覷 觞觴 触觸 觯觶 誉譽 誊謄 讠訁 计計 订訂 讣訃 认認 讥譏 讦訐 讧訌 讨討 让讓 讪訕 讫訖 训訓 议議 讯訊 记記 讱訒 讲講 讳諱 讴謳 讵詎 讶訝 讷訥 许許 讹訛 论論 讻訟 讼訟 讽諷 设設 访訪 诀訣 证證 诂詁 诃訶 评評 诅詛 识識 诇詗 诈詐 诉訴 诊診 诋詆 诌謅 词詞 诎詘 诏詔 译譯 诒詒 诓誆 诔誄 试試 诖詿 诗詩 诘詰 诙詼 诚誠 诛誅 诜詵 话話 诞誕 诟詬 诠詮 诡詭 询詢 诣詣 诤諍 该該 详詳 诧詫 诨諢 诩詡 诫誡 诬誣 语語 诮誚 误誤 诰誥 诱誘 诲誨 诳誑 说說 诵誦 诶誒 请請 诸諸 诹諏 诺諾 读讀 诼諑 诽誹 课課 诿諉 谀諛 谁誰 谂諗 调調 谄諂 谅諒 谆諄 谇誶 谈談 谊誼 谋謀 谌諶 谍諜 谎謊 谏諫 谐諧 谑謔 谒謁 谓謂 谔諤 谕諭 谖諼 谗讒 谘諮 谙諳 谚諺 谛諦 谜謎 谝諞 谞諝 谟謨 谠讜 谡謖 谢謝 谣謠 谤謗 谥謚 谦謙 谧謐 谨謹 谩謾 谪謫 谫譾 谬謬 谭譚 谮譖 谯譙 谰讕 谱譜 谲譎 谳讞 谴譴 谵譫 谶讖 谷谷 豮豶 贝貝 贞貞 负負 贠貟 贡貢 财財 责責 贤賢 败敗 账賬 货貨 质質 贩販 贪貪 贫貧 贬貶 购購 贮貯 贯貫 贰貳 贱賤 贲賁 贳貰 贴貼 贵貴 贶貺 贷貸 贸貿 费費 贺賀 贻貽 贼賊 贽贄 贾賈 贿賄 赀貲 赁賃 赂賂 赃贓 资資 赅賅 赆贐 赇賕 赈賑 赉賚 赊賒 赋賦 赌賭 赍賫 赎贖 赏賞 赐賜 赑贔 赒賙 赓賡 赔賠 赕賧 赖賴 赗賵 赘贅 赙賻 赚賺 赛賽 赜賾 赝贗 赞贊 赟贇 赠贈 赡贍 赢贏 赣贛 赤赤 赪赬 赵趙 赶趕 趋趨 趱趲 趸躉 跃躍 跄蹌 跶躂 跷蹺 跸蹕 跹躚 跻躋 踊踴 踌躊 踪蹤 踬躓 踯躑 蹑躡 蹒蹣 蹰躕 蹿躥 躏躪 躜躦 躯軀 车車 轧軋 轨軌 轩軒 轪軑 轫軔 转轉 轭軛 轮輪 软軟 轰轟 轱軲 轲軻 轳轤 轴軸 轵軹 轶軼 轷軤 轸軫 轹轢 轺軺 轻輕 轼軾 载載 轾輊 轿轎 辀輈 辁輇 辂輅 较較 辄輒 辅輔 辆輛 辇輦 辈輩 辉輝 辊輥 辋輞 辌輬 辍輟 辎輜 辏輳 辐輻 辑輯 输輸 辔轡 辕轅 辖轄 辗輾 辘轆 辙轍 辚轔 辞辭 辩辯 辫辮 边邊 辽遼 达達 迁遷 过過 迈邁 运運 还還 这這 进進 远遠 违違 连連 迟遲 迩邇 迳逕 迹跡 适適 选選 逊遜 递遞 逦邐 逻邏 遗遺 遥遙 邓鄧 邝鄺 邬鄔 邮郵 邹鄒 邺鄴 邻鄰 郏郟 郐鄶 郑鄭 郓鄆 郦酈 郧鄖 郸鄲 酂酇 酝醞 酦醱 酱醬 酽釅 酾釃 酿釀 释釋 鉴鑒 銮鑾 錾鏨 门門 闩閂 闪閃 闫閆 闬閈 闭閉 问問 闯闖 闰閏 闱闈 闲閒 闳閎 间間 闵閔 闶閌 闷悶 闸閘 闹鬧 闺閨 闻聞 闼闥 闽閩 闾閭 闿闓 阀閥 阁閣 阂閡 阃閫 阄鬮 阅閱 阆閬 阇闍 阈閾 阉閹 阊閶 阋鬩 阌閿 阍閽 阎閻 阏閼 阐闡 阑闌 阒闃 阓闠 阔闊 阕闋 阖闔 阗闐 阘闒 阙闕 阚闞 队隊 阳陽 阴陰 阵陣 阶階 际際 陆陸 陇隴 陈陳 陉陘 陕陝 陧隉 陨隕 险險 随隨 隐隱 隶隸 隽雋 难難 雏雛 雠讎 雳靂 雾霧 霁霽 霡霢 霭靄 靓靚 静靜 靥靨 鞑韃 鞒鞽 鞯韉 韦韋 韧韌 韨韍 韩韓 韪韙 韫韞 韬韜 韵韻 页頁 顶頂 顷頃 顸頇 项項 顺順 须須 顼頊 顽頑 顾顧 顿頓 颀頎 颁頒 颂頌 颃頏 预預 颅顱 领領 颇頗 颈頸 颉頡 颊頰 颋頲 颌頜 颍潁 颎熲 颏頦 颐頤 频頻 颒頮 颓頹 颔頷 颕頴 颖穎 颗顆 题題 颙顒 颚顎 颛顓 颜顏 额額 颞顳 颟顢 颠顛 颡顙 颢顥 颣纇 颤顫 颥顬 颦顰 颧顴 风風 飏颺 飐颭 飑颮 飒颯 飓颶 飔颸 飕颼 飗飀 飘飄 飙飆 飞飛 飨饗 餍饜 饤飣 饥飢 饦飥 饧餳 饨飩 饩餼 饪飪 饫飫 饬飭 饭飯 饮飲 饯餞 饰飾 饱飽 饲飼 饳飿 饴飴 饵餌 饶饒 饷餉 饸餄 饹餎 饺餃 饻餏 饼餅 饽餑 饾餖 饿餓 馀餘 馁餒 馂餕 馃餜 馄餛 馅餡 馆館 馇餷 馈饋 馉餶 馊餿 馋饞 馌饁 馍饃 馎餺 馏餾 馐饈 馑饉 馒饅 馓饊 馔饌 馕饢 马馬 驭馭 驮馱 驯馴 驰馳 驱驅 驲馹 驳駁 驴驢 驵駔 驶駛 驷駟 驸駙 驹駒 驺騶 驻駐 驼駝 驽駑 驾駕 驿驛 骀駘 骁驍 骂罵 骃駰 骄驕 骅驊 骆駱 骇駭 骈駢 骉驫 骊驪 骋騁 验驗 骍騂 骎駸 骏駿 骐騏 骑騎 骒騍 骓騅 骔騣 骕驌 骖驂 骗騙 骘騭 骙驦 骚騷 骛騖 骜驁 骝騮 骞騫 骟騸 骠驃 骡騾 骢驄 骣驏 骤驟 骥驥 骦驦 骧驤 髅髏 髋髖 髌髕 鬓鬢 魇魘 魉魎 魍魍 魑魑 鱼魚 鱿魷 鲀魨 鲁魯 鲂魴 鲄魺 鲅鮁 鲆鮃 鲇鮎 鲈鱸 鲉鮋 鲊鮓 鲋鮒 鲌鮊 鲍鮑 鲎鱟 鲏鮍 鲐鮐 鲑鮭 鲒鮚 鲓鮳 鲔鮪 鲕鮞 鲖鮦 鲗鰂 鲘鮜 鲙鱠 鲚鱭 鲛鮫 鲜鮮 鲝鮺 鲞鯗 鲟鱘 鲠鯁 鲡鱺 鲢鰱 鲣鰹 鲤鯉 鲥鰣 鲦鰷 鲧鯀 鲨鯊 鲩鯇 鲪鮶 鲫鯽 鲬鯒 鲭鯖 鲮鯪 鲯鯕 鲰鯫 鲱鯡 鲲鯤 鲳鯧 鲴鯝 鲵鯢 鲶鯰 鲷鯛 鲸鯨 鲹鰺 鲺鯴 鲻鯔 鲼鱝 鲽鰈 鲾鰏 鲿鱨 鳀鯷 鳁鰛 鳂鰃 鳃鰓 鳄鰐 鳅鰍 鳆鰒 鳇鰉 鳈鰁 鳉鱂 鳊鯿 鳋鰠 鳌鰲 鳍鰭 鳎鰨 鳏鰥 鳐鰩 鳑鰟 鳒鰜 鳓鰳 鳔鰾 鳕鱈 鳖鱉 鳗鰻 鳘鰵 鳙鱅 鳚鳚 鳛鰼 鳜鱖 鳝鱔 鳞鱗 鳟鱒 鳠鱯 鳡鱤 鳢鱧 鳣鱣 鸟鳥 鸠鳩 鸡雞 鸢鳶 鸣鳴 鸤鳲 鸥鷗 鸦鴉 鸧鶬 鸨鴇 鸩鴆 鸪鴣 鸫鶇 鸬鸕 鸭鴨 鸮鴞 鸯鴦 鸰鴒 鸱鴟 鸲鴝 鸳鴛 鸴鷽 鸵鴕 鸶鷥 鸷鷙 鸸鴯 鸹鴰 鸺鵂 鸻鴴 鸼鵃 鸽鴿 鸾鸞 鸿鴻 鹀鵐 鹁鵓 鹂鸝 鹃鵑 鹄鵠 鹅鵝 鹆鵒 鹇鷳 鹈鵜 鹉鵡 鹊鵲 鹋鶓 鹌鵪 鹍鵾 鹎鵯 鹏鵬 鹐鵮 鹑鶉 鹒鶊 鹓鵷 鹔鷫 鹕鶘 鹖鶡 鹗鶚 鹘鶻 鹙鶖 鹚鷀 鹛鶥 鹜鶩 鹝鷊 鹞鷂 鹟鶲 鹠鶹 鹡鶺 鹢鷁 鹣鶼 鹤鶴 鹥鷖 鹦鸚 鹧鷓 鹨鷚 鹩鷯 鹪鷦 鹫鷲 鹬鷸 鹭鷺 鹮䴉 鹯鸇 鹰鷹 鹱鸌 鹲鸏 鹳鸛 鹴鸘 鹾鹺 麦麥 麸麩 黄黃 黉黌 黡黶 黩黷 黪黲 黾黽 鼋黿 鼍鼉 鼗鞀 鼹鼴 齄齇 齐齊 齑齏 齿齒 龀齔 龁齕 龂齗 龃齟 龄齡 龅齙 龆齠 龇齜 龈齦 龉齬 龊齪 龋齲 龌齷 龙龍 龚龔 龛龕 龟龜';
const S2T_MAP = (() => {
  const m = {};
  for (const pair of S2T_PAIRS.split(/\s+/)) {
    if (pair.length === 2 && pair[0] !== pair[1]) m[pair[0]] = pair[1];
  }
  return m;
})();

function toTraditional(s) {
  let out = '';
  for (const ch of s) out += S2T_MAP[ch] || ch;
  return out;
}

const SIMPLIFIED_RE = new RegExp('[' + Object.keys(S2T_MAP).join('') + ']');

function getKey() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-code-router', 'config.json'), 'utf8'));
  const p = (cfg.Providers || cfg.providers)[0];
  return p.api_key;
}

async function chat(messages, retries = 4) {
  const KEY = getKey();
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const r = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0 }),
        signal: ctrl.signal,
      });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) throw new Error('empty response: ' + JSON.stringify(j).slice(0, 200));
      return content;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
}

// Strip a model's optional <think>…</think> preamble.
function cleanContent(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Strip stray markdown labels the model sometimes prepends (e.g. "**翻譯**：").
function stripPrefix(s) {
  return s.replace(/^\**\s*(翻譯|翻译|譯文|译文|Translation)\s*\**\s*[:：]?\s*/i, '').trim();
}

// Restore reserved terms + normalize to Traditional. `map` is the protection map
// for this specific string.
function finalize(translated, map) {
  return canonicalizeTerms(toTraditional(restoreString(translated, map)));
}

async function translateBatch(strings) {
  const protectedList = strings.map((s) => protectString(s));
  const numbered = protectedList.map((p, i) => `${i + 1}\t${p.masked.replace(/\n/g, NL)}`).join('\n');
  const user = `翻譯下列 ${strings.length} 行日文，逐行對應輸出，格式必須是「編號<TAB>譯文」，不可合併、省略或新增行：\n${numbered}`;
  const content = cleanContent(await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]));

  const out = new Array(strings.length).fill(null);
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*(\d+)[\t\.\)、:：]\s*(.*)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < strings.length && out[idx] === null) {
      const restored = m[2].replace(new RegExp(NL, 'g'), '\n').trim();
      out[idx] = finalize(stripPrefix(restored), protectedList[idx].map);
    }
  }
  return out;
}

async function translateOne(s) {
  const { masked, map } = protectString(s);
  const content = cleanContent(await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '翻譯成繁體中文，只輸出譯文：\n' + masked.replace(/\n/g, NL) },
  ]));
  const restored = content.replace(new RegExp(NL, 'g'), '\n').trim();
  return finalize(stripPrefix(restored), map);
}

function collectStrings(data) {
  const set = new Set();
  const add = (s) => { if (s && typeof s === 'string' && s.trim()) set.add(s); };
  for (const k in data) {
    const c = data[k];
    for (const sk of ['oshiSkill', 'spOshiSkill']) if (c[sk]) { add(c[sk].name); add(c[sk].effect); }
    if (c.arts) for (const a of c.arts) { add(a.name); add(a.effect); }
    if (c.keywords) for (const kw of c.keywords) { add(kw.label); add(kw.effect); }
    add(c.abilityText);
  }
  return Array.from(set);
}

function reconstruct(data, cache) {
  const tr = (s) => (s && cache[s]) ? cache[s] : s;
  // Card name/cardType are not part of the LLM translation cache, so translate
  // them here: name via the curated character-name map, cardType via the term
  // glossary. Both are canonicalized so no Japanese kana survives (DIC-465).
  let charNames = {};
  try { charNames = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'character-names-zh.json'), 'utf8')); } catch (e) {}
  const trName = (n) => canonicalizeTerms((n && charNames[n]) || n);
  const out = {};
  for (const k in data) {
    const c = data[k];
    const z = { cardNumber: c.cardNumber, name: trName(c.name), cardType: canonicalizeTerms(c.cardType), color: c.color };
    for (const sk of ['oshiSkill', 'spOshiSkill']) {
      if (c[sk]) z[sk] = { name: tr(c[sk].name), cost: c[sk].cost, effect: tr(c[sk].effect) };
    }
    if (c.arts) z.arts = c.arts.map((a) => ({ name: tr(a.name), cost: a.cost, damage: a.damage, effect: tr(a.effect) }));
    if (c.keywords) z.keywords = c.keywords.map((kw) => ({ label: tr(kw.label), effect: tr(kw.effect) }));
    if (c.abilityText) z.abilityText = tr(c.abilityText);
    out[k] = z;
  }
  return out;
}

// Post-translation validation: flag any surviving Japanese kana, simplified
// characters, unrestored protection tokens, or English term leaks. Returns true
// when everything is clean.
function validate(cache) {
  const entries = Object.entries(cache);
  // No Japanese kana may survive in a translated field (DIC-465). Interpunct
  // U+30FB and halfwidth U+FF65 are normalized to · in finalize(), so they are
  // excluded here to avoid false positives on foreign names.
  const KANA_RE = /[぀-ゟァ-ヺー-ヿ]/u;
  let clean = true;
  const kanaLeaks = entries.filter(([, zh]) => KANA_RE.test(zh));
  if (kanaLeaks.length) {
    clean = false;
    console.log(`  [validate] Japanese kana remain in ${kanaLeaks.length} string(s):`);
    for (const [, zh] of kanaLeaks.slice(0, 10)) console.log(`    ${JSON.stringify(zh).slice(0, 120)}`);
  }

  const artifacts = entries.filter(([, zh]) => TOKEN_ARTIFACT_RE.test(zh)).length;
  if (artifacts) { clean = false; console.log(`  [validate] token artifacts in ${artifacts} string(s)`); }

  const englishLeaks = entries.filter(([, zh]) => /holomen|\barts\b|collaboration/i.test(zh)).length;
  if (englishLeaks) { clean = false; console.log(`  [validate] english term leaks in ${englishLeaks} string(s)`); }

  const simp = new Set();
  for (const [, zh] of entries) for (const ch of zh) if (S2T_MAP[ch]) simp.add(ch);
  if (simp.size) { clean = false; console.log(`  [validate] simplified chars remain: ${[...simp].join('')}`); }

  if (clean) console.log('  [validate] OK — no kana, no artifacts, no simplified chars');
  return clean;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) {}

  const all = collectStrings(data);
  const todo = all.filter((s) => !(s in cache));
  console.log(`Unique strings: ${all.length} | cached: ${all.length - todo.length} | to translate: ${todo.length}`);

  // Split into batches, process CONCURRENCY batches in parallel.
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));

  let done = 0;
  async function runBatch(batch) {
    let results;
    try { results = await translateBatch(batch); }
    catch (err) { results = new Array(batch.length).fill(null); }
    const missing = results.filter((r) => !r).length;
    if (missing >= batch.length / 2) { try { results = await translateBatch(batch); } catch (e) {} }
    for (let j = 0; j < batch.length; j++) {
      // Retry in single-string mode when the batch produced nothing or the model
      // mangled the protection tokens (leftover sentinel fragments).
      if (!results[j] || TOKEN_ARTIFACT_RE.test(results[j])) {
        try {
          const single = await translateOne(batch[j]);
          if (single && !TOKEN_ARTIFACT_RE.test(single)) results[j] = single;
          else if (!results[j]) results[j] = single;
        }
        catch (e) { console.log(`\n  single failed: ${batch[j].slice(0, 16)}… ${e.message}`); }
      }
      if (results[j]) cache[batch[j]] = results[j];
    }
    done += batch.length;
  }

  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const idx = next++;
      await runBatch(batches[idx]);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
      process.stdout.write(`\r  translated ${Math.min(done, todo.length)}/${todo.length}   `);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log('');

  const untranslated = all.filter((s) => !(s in cache));
  if (untranslated.length) console.log(`WARN: ${untranslated.length} strings still untranslated`);

  console.log('Validating translations…');
  if (!validate(cache)) {
    console.error('[translate] ❌ Validation failed — aborting output write');
    process.exit(1);
  }

  const zh = reconstruct(data, cache);
  fs.writeFileSync(OUT_FILE, JSON.stringify(zh, null, 2), 'utf8');
  console.log(`Wrote ${OUT_FILE} (${Object.keys(zh).length} cards, ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB)`);
}

export { protectString, restoreString, toTraditional, finalize, S2T_MAP, validate };

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
