import { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ------------------------------------------------------------
   セーブ用ストレージ
   通常のブラウザ(GitHub Pages等)では localStorage を使う。
   Artifact プレビュー環境では window.storage が使えるのでそちらを優先。
   どちらも get→{value} / set(key,value) の形にそろえて呼べる。
   ------------------------------------------------------------ */
const storage = {
  async get(key) {
    if (typeof window !== "undefined" && window.storage?.get) {
      try { return await window.storage.get(key); } catch { /* fallthrough */ }
    }
    try {
      const value = localStorage.getItem(key);
      return value == null ? null : { value };
    } catch { return null; }
  },
  async set(key, value) {
    if (typeof window !== "undefined" && window.storage?.set) {
      try { return await window.storage.set(key, value); } catch { /* fallthrough */ }
    }
    try { localStorage.setItem(key, value); } catch { /* 容量超過等は黙って無視 */ }
  },
};

/* ------------------------------------------------------------
   新規セーブキーの器(§1.3 / PR #3・#4 が実データを入れる)
   いずれも上の storage 抽象化レイヤ経由。キーは seaglass- 接頭辞で統一。
   読み込み時、未定義フィールドはデフォルトで補完する(後方互換 §5)。
   ・時化のあとの漂着 … 浜ごと: seaglass-washups-<beachId>
   ・稀に流れ着く小瓶 … 全体で1つ: seaglass-bottles
   ------------------------------------------------------------ */
const WASHUPS_KEY = (beachId) => `seaglass-washups-${beachId}`;
const BOTTLES_KEY = "seaglass-bottles";

function defaultWashups() { return { lastCheckedDate: null, items: [] }; }
function defaultBottles() {
  return { surfaceTriggered: 0, coreTriggered: 0, armed: [], collected: [], storyComplete: false };
}

async function loadWashups(beachId) {
  try {
    const r = await storage.get(WASHUPS_KEY(beachId));
    if (r?.value) return { ...defaultWashups(), ...JSON.parse(r.value) };
  } catch { /* 初回は未保存 */ }
  return defaultWashups();
}
async function saveWashups(beachId, data) {
  try { await storage.set(WASHUPS_KEY(beachId), JSON.stringify(data)); } catch { /* 容量超過等は無視 */ }
}
async function loadBottles() {
  try {
    const r = await storage.get(BOTTLES_KEY);
    if (r?.value) return { ...defaultBottles(), ...JSON.parse(r.value) };
  } catch { /* 初回は未保存 */ }
  return defaultBottles();
}
async function saveBottles(data) {
  try { await storage.set(BOTTLES_KEY, JSON.stringify(data)); } catch { /* 容量超過等は無視 */ }
}

/* 潮間帯の個体(§2.4)。浜ごと・その日ぶんを決定論生成して持ち越す。
   位置は相対座標 rx,ry(0..1)で保存 → 画面サイズ非依存・形も位置もリセットしない。 */
const TIDEPOOL_KEY = (beachId) => `seaglass-tidepool-${beachId}`;
function defaultTidePool() { return { day: null, items: [] }; }
/* その日・その浜の潮間帯個体を dateSeed から確定生成(同時露出上限3) */
function generateTidePool(dk, beach) {
  const rng = dateSeed(dk, beach.id, "tide");
  const count = 1 + Math.floor(rng() * 3);   // 1..3
  const items = [];
  for (let i = 0; i < count; i++) {
    const id = rollItem(null, beach, rng);   // 天気非依存で決定論を保つ
    const seed = (rng() * 1e9) | 0;
    items.push({ id, seed, rx: rng(), ry: rng() });
  }
  return { day: dk, items };
}
async function loadTidePool(beach, dk) {
  try {
    const r = await storage.get(TIDEPOOL_KEY(beach.id));
    if (r?.value) {
      const s = { ...defaultTidePool(), ...JSON.parse(r.value) };
      if (s.day === dk) return s;   // 当日分は採取状態ごと引き継ぐ
    }
  } catch { /* 初回は未保存 */ }
  return generateTidePool(dk, beach);   // 翌日リセット:未採取分は海が引き取り、新しい今日の個体を出す
}
async function saveTidePool(beach, data) {
  try { await storage.set(TIDEPOOL_KEY(beach.id), JSON.stringify(data)); } catch { /* 容量超過等は無視 */ }
}

/* ---------- 時化のあとの漂着(§3) ----------
   前日の現実の天気が荒れていたら、翌朝の汀線に流木やレア色ガラスが打ち上がる。
   その日・その浜につき一度だけ確定する朝のイベント(dateSeed で決定論・リロードで不変)。 */
const STORM_GUST_KMH = 55;       // これ以上の最大瞬間風速(km/h)で時化寄り(要調整)
const STORM_PRECIP_MM = 10;      // 前日降水合計の目安(mm)
const STORM_THRESHOLD = 0.4;     // isStorm の閾値
const STORM_GLASS = ["glass_red"];   // 時化限定のレア色(§4 の CORE_COLORS と一致)

/* 前日(未明含む)の荒れ具合を過去hourlyから 0..1 に合成。マリンは使わず風＋降水で近似。
   取得できなければ null を返し、呼び出し側で体験モード用の擬似値にフォールバックする。 */
async function fetchStormIntensity(beach, todayDk) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${beach.lat}&longitude=${beach.lon}&hourly=wind_gusts_10m,precipitation&past_days=1&forecast_days=1`;
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    const time = data?.hourly?.time || [];
    const gust = data?.hourly?.wind_gusts_10m || [];
    const precip = data?.hourly?.precipitation || [];
    let maxGust = 0, sumPrecip = 0, n = 0;
    for (let i = 0; i < time.length; i++) {
      if (time[i].slice(0, 10) >= todayDk) continue;   // 前日ぶんだけ(当日は除く)
      maxGust = Math.max(maxGust, gust[i] ?? 0);
      sumPrecip += precip[i] ?? 0;
      n++;
    }
    if (n === 0) return null;
    const gustPart = Math.min(1, maxGust / (STORM_GUST_KMH * 1.6));
    const precipPart = Math.min(1, sumPrecip / (STORM_PRECIP_MM * 2));
    return Math.min(1, 0.6 * gustPart + 0.4 * precipPart);
  } catch { return null; }
}
/* その日の漂着を決定論生成(朝の一度きり)。個数は intensity に比例し小さく上限(1..5) */
function generateWashups(dk, beach, intensity) {
  if (intensity < STORM_THRESHOLD) return [];
  const rng = dateSeed(dk, beach.id, "storm");
  const count = Math.max(1, Math.min(5, Math.round(intensity * 4)));
  const items = [];
  for (let i = 0; i < count; i++) {
    const isGlass = rng() < 0.35;   // 流木が主、レア色ガラスはときどき
    const id = isGlass ? STORM_GLASS[Math.floor(rng() * STORM_GLASS.length)] : "driftwood";
    items.push({ id, seed: (rng() * 1e9) | 0, rx: rng(), ry: rng(), appearedDate: dk });
  }
  return items;
}
/* 未採取のまま翌々日を迎えた個体を潮が引き取る(打ち上がった日と翌日いっぱいは残す) */
function cleanWashups(items, todayDk) {
  const today = dateKeyToMs(todayDk);
  return items.filter(it => Math.round((today - dateKeyToMs(it.appearedDate)) / 86400000) <= 1);
}

/* ---------- 稀に流れ着く小瓶(§4) ----------
   シーグラスの累計収集数がしきい値に達するごとに、断片を持つ小瓶が次の朝ひとつ流れ着く。
   二系統:通常色=日常の層 / レア色(赤)=核心の層。両方を集めきると物語の全容が解ける。
   断片テキストは docs/bottle-narrative.md の書き下ろし(完全オリジナル)。 */
const SURFACE_COLORS = ["glass_green", "glass_white", "glass_brown", "glass_aqua", "glass_blue"];
const CORE_COLORS = STORM_GLASS;   // レア色=赤。機能②の時化限定色と一致(§4.2)
const SURFACE_COUNT = 5;           // 通常色を累計この数集めるごとに「日常」断片1つ
const CORE_COUNT = 3;              // レア色を累計この数集めるごとに「核心」断片1つ
const BOTTLE_MESSAGES = {
  surface: [
    { id: "s01", order: 1,  text: "今日も渚へ下りる。理由は、まだうまく言えない" },
    { id: "s02", order: 3,  text: "拾うより先に、波の音を数える癖がついた" },
    { id: "s03", order: 4,  text: "硝子は、割れてからの時間のほうがずっと長い" },
    { id: "s04", order: 6,  text: "同じ場所へ二度は打ち上がらない。それでもわたしは、同じ渚へ通う" },
    { id: "s05", order: 7,  text: "風のない朝は少し物足りない。荒れたあとの浜が、いちばん多くを返す" },
    { id: "s06", order: 8,  text: "ポケットの中で拾ったものが鳴る。それだけで足りる日もある" },
    { id: "s07", order: 10, text: "季節が一度めぐった。渚はわたしを覚えていない。忘れてもいない" },
    { id: "s08", order: 11, text: "濡れた砂に膝をつく。その冷たさが、生きているほうの合図になる" },
    { id: "s09", order: 13, text: "いつからか、両手を空けて歩く癖がついた。何かを受け取るために" },
    { id: "s10", order: 14, text: "帰りぎわ、瓶の口を潮へ向ける。返すことも、待つことのうちだと知った" },
  ],
  core: [
    { id: "c01", order: 2,  text: "海はいつか全部を返す、とあなたは言った。かたちを変えて、と" },
    { id: "c02", order: 5,  text: "瓶に手紙を入れて流すのは、あなたが教えてくれた遊び。いくつかは、いつか返ると信じて" },
    { id: "c03", order: 9,  text: "あなたが生涯さがしていたのは、赤。この渚でいちばん稀な色。とうとう見つからないまま、あなたは行った" },
    { id: "c04", order: 12, text: "割れたものばかり、わたしは拾い集めている。あなたの分まで、と言えばうそになる。ただ、同じ場所を見ていたいだけ" },
    { id: "c05", order: 15, text: "今朝、波の音がこう言った気がした。もう、探さなくていい。手のひらには、いつのまにか赤がひとつ。返されていたのは、わたしのほうだった" },
  ],
};
/* 対象色群の累計収集数を既存の収集データから導出(専用カウンタは持たない・非消費) */
function bottleColorCount(collection, colors) {
  return colors.reduce((s, c) => s + entryCount(collection[c]), 0);
}
/* その色をいちばん最近拾った浜(小瓶が流れ着く先 foundBeach) */
function lastFindBeach(finds, colors) {
  for (let i = finds.length - 1; i >= 0; i--) if (colors.includes(finds[i].id)) return finds[i].beachId;
  return null;
}
/* そのプールの次の未取得断片(順送り) */
function nextFragment(pool, collected) {
  const got = new Set(collected.filter(c => c.pool === pool).map(c => c.id));
  return BOTTLE_MESSAGES[pool].find(f => !got.has(f.id));
}
/* 両プールを集めきったか(全容が解ける) */
function isStoryComplete(collected) {
  const s = collected.filter(c => c.pool === "surface").length;
  const c = collected.filter(c => c.pool === "core").length;
  return s >= BOTTLE_MESSAGES.surface.length && c >= BOTTLE_MESSAGES.core.length;
}
/* この浜で今朝ひらく小瓶を1本選ぶ(前夜までにアーム済み・同時到達は核心優先) */
function pickPresentBottle(bottles, beachId, todayDk) {
  const due = bottles.armed.filter(a => a.armedDate < todayDk && a.foundBeach === beachId);
  due.sort((x, y) => (x.pool === y.pool ? 0 : x.pool === "core" ? -1 : 1));
  return due[0] || null;
}

/* ============================================================
   シーグラス — 浜辺を歩いて、海からの贈りものを探すゲーム
   ・実況天気(Open-Meteo)と連動。取得できない環境では体験モードに切替
   ・波が引いた後にだけ、新しい漂着物が現れる
   ============================================================ */

/* ---------- 海岸データ ---------- */
/* 名前は架空。座標は気候の多様性のためだけに使い、画面には出さない。
   stones は「その海のあたりの地層からとれる石」を思わせる打ち上げ表。
   実在の地名は出さず、石そのものの名前(鉱物・岩石名)だけで土地の性格をにじませる。 */
const BEACHES = [
  { id: "glass", name: "硝子の浜", region: "東の海", lat: 35.312, lon: 139.545, note: "波が引くたび、砂のなかで何かが小さく光る",
    stones: [["maru_ishi", 40], ["akadama", 34], ["shima_ishi", 26]] },
  { id: "northwind", name: "北風の岬", region: "北の海", lat: 40.52, lon: 141.625, note: "荒れた翌朝ほど、遠くからの贈りものが届く",
    stones: [["maru_ishi", 34], ["meno", 30], ["nishiki", 22], ["shima_ishi", 14]] },
  { id: "crescent", name: "三日月の入り江", region: "西の海", lat: 36.877, lon: 136.77, note: "湾の形に沿って、漂着物が一列に並ぶ",
    stones: [["maru_ishi", 40], ["keikaboku", 30], ["shima_ishi", 22], ["hisui", 8]] },
  { id: "shirasu", name: "白い砂洲", region: "南の海", lat: 33.679, lon: 135.336, note: "まぶしい砂の上では、桜貝も見つけやすい",
    stones: [["maru_ishi", 30], ["kuroishi", 30], ["aoishi", 26], ["shiro_ishi", 14]] },
  { id: "harugasumi", name: "遥かの島の浜", region: "はるか南の海", lat: 26.648, lon: 127.893, note: "透きとおる遠浅に、名前を知らない貝が眠る",
    stones: [["sangoishi", 44], ["maru_ishi", 30], ["shiro_ishi", 26]] },
];
/* 浜が特定できないときの、無難な石の表(後方互換用) */
const DEFAULT_STONES = [["maru_ishi", 50], ["shima_ishi", 30], ["shiro_ishi", 20]];

/* ---------- 漂着物カタログ ---------- */
const CATALOG = [
  { id: "maru_ishi", cat: "石", name: "丸い石", rarity: 1, poem: "波に磨かれて、角がとれた。手のひらに、ちょうどいい重さ。", stone: { c0: "#a49a8b", c1: "#6e675c", style: "speck", line: "rgba(235,228,215,0.4)" } },
  { id: "shima_ishi", cat: "石", name: "縞模様の石", rarity: 2, poem: "幾千年の地層が、一本の縞になった。", stone: { c0: "#a49a8b", c1: "#6e675c", style: "band", line: "rgba(240,235,222,0.75)" } },
  { id: "shiro_ishi", cat: "石", name: "白い石", rarity: 2, poem: "月のかけらのように、砂の上で光っていた。", stone: { c0: "#f4efe3", c1: "#cfc7b4", style: "speck", line: "rgba(190,182,165,0.5)" } },
  /* --- その土地の地層からとれる石 --- */
  { id: "akadama", cat: "石", name: "赤玉石", rarity: 3, poem: "夕焼けをひとかけら、そのまま閉じこめたような紅。", stone: { c0: "#c96a55", c1: "#8f3d31", style: "speck", line: "rgba(255,225,205,0.35)" } },
  { id: "meno", cat: "石", name: "瑪瑙", rarity: 2, poem: "光にかざすと、薄い層がいくつも透けて見える。", stone: { c0: "#e6dccb", c1: "#b9a789", style: "agate", bands: ["rgba(255,255,255,0.55)", "rgba(210,190,160,0.45)", "rgba(190,170,140,0.4)"] } },
  { id: "nishiki", cat: "石", name: "錦石", rarity: 3, poem: "小さな石のなかに、いくつもの色が織りこまれている。", stone: { c0: "#d9a86e", c1: "#9c6b3f", style: "agate", bands: ["rgba(255,245,225,0.5)", "rgba(210,120,80,0.42)", "rgba(180,150,90,0.45)", "rgba(150,90,70,0.4)"] } },
  { id: "keikaboku", cat: "石", name: "珪化木", rarity: 3, poem: "石になっても、木だったころの年輪を忘れずにいる。", stone: { c0: "#b79a6f", c1: "#6f5638", style: "grain", line: "rgba(70,54,36,0.5)" } },
  { id: "hisui", cat: "石", name: "翡翠", rarity: 5, poem: "海が長い時間をかけて磨いた、深い緑。出会えたら、しずかな幸運。", stone: { c0: "#9fc9a8", c1: "#4f7d5e", style: "jade" } },
  { id: "kuroishi", cat: "石", name: "黒石", rarity: 2, poem: "濡れた背に光を映して、墨よりも深く艶めく。", stone: { c0: "#4a4a48", c1: "#1b1b1d", style: "gloss" } },
  { id: "aoishi", cat: "石", name: "青石", rarity: 2, poem: "山の奥から川を下り、海までたどりついた青みの石。", stone: { c0: "#7d918a", c1: "#47564f", style: "schist", line: "rgba(212,222,214,0.5)" } },
  { id: "sangoishi", cat: "石", name: "珊瑚石", rarity: 2, poem: "かつて生きていた海の骨。細かな穴に、光と潮が通う。", stone: { c0: "#f0e9dd", c1: "#d3c3ab", style: "porous", line: "rgba(150,135,110,0.4)" } },
  { id: "futamaigai", cat: "貝殻", name: "二枚貝", rarity: 1, poem: "開いたまま砂に眠る、小さな扇。" },
  { id: "makigai", cat: "貝殻", name: "巻き貝", rarity: 2, poem: "耳をあてると、遠い沖の音がする。" },
  { id: "sakuragai", cat: "貝殻", name: "桜貝", rarity: 3, poem: "花びらと見まちがえるほど、薄く、淡く。" },
  { id: "glass_green", cat: "シーグラス", name: "緑のシーグラス", rarity: 2, glass: "#8fc4a2", poem: "昔だれかが飲んだ、ラムネの瓶かもしれない。" },
  { id: "glass_white", cat: "シーグラス", name: "白のシーグラス", rarity: 2, glass: "#dfe8e2", poem: "曇りガラスの向こうに、空が透ける。" },
  { id: "glass_brown", cat: "シーグラス", name: "茶色のシーグラス", rarity: 3, glass: "#b98d5e", poem: "琥珀のような、あたたかい色。" },
  { id: "glass_aqua", cat: "シーグラス", name: "水色のシーグラス", rarity: 3, glass: "#9cc9d4", poem: "浅瀬の色を、そのまま閉じこめた。" },
  { id: "glass_blue", cat: "シーグラス", name: "青いシーグラス", rarity: 4, glass: "#5b7fb3", poem: "深い海の色。出会えたら幸運のしるし。" },
  /* 赤は「この渚でいちばん稀な色」。時化のあとにだけ打ち上がる(通常スポーンには出さない) */
  { id: "glass_red", cat: "シーグラス", name: "赤いシーグラス", rarity: 5, glass: "#c46a6a", storm: true, poem: "千個にひとつの、いちばんの宝もの。" },
  { id: "touhen", cat: "陶片", name: "陶片", rarity: 4, poem: "藍の絵付けが残るかけら。どんな器だったのだろう。" },
  /* 流木:時化限定の収集物。大きめで、seed ごとに木肌と形が異なる */
  { id: "driftwood", cat: "流木", name: "流木", rarity: 3, storm: true, poem: "遠い岸で朽ちて、長い旅のすえにここへ。潮の匂いが、まだ残っている。" },
];
const CAT_ORDER = ["石", "貝殻", "シーグラス", "流木", "陶片"];

/* コレクションの値は数値(旧)またはオブジェクト(新)。両方から個数を取り出す */
function entryCount(v) { return typeof v === "number" ? v : v?.count || 0; }
function entrySeed(v) { return typeof v === "object" ? v?.seed : undefined; }

/* ---------- 打ち上げのペース ---------- */
const HOUR_MS = 60 * 60 * 1000;
const WASH_INTERVAL = HOUR_MS;   // およそ1時間に1個
const DAILY_CAP = 24;            // 1日に打ち上がる上限
const MAX_ON_SHORE = 12;         // 浜に同時に存在できる最大
const FIRST_VISIT = 5;           // はじめて訪れたとき、すでにある数
/* ---------- 共有基盤:日付・決定論シード・月齢(§1 共通土台) ----------
   日境界はローカル 0:00 に統一。潮・漂着・小瓶の"今日"判定と、
   既存の1日上限リセットは、すべてこの dateKey 1本を参照する(二重定義しない)。 */

/* 日付キー:ローカル暦の ISO 'YYYY-MM-DD'(ゼロ埋め)。ローカル 0:00 が日境界 */
const dateKey = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
/* dateKey → ローカル深夜0時のミリ秒(日数差の計算に使う) */
const dateKeyToMs = (dk) => new Date(`${dk}T00:00:00`).getTime();

/* 文字列 → 32bit シード(xmur3 相当)。dateSeed のハッシュに使う */
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/* 決定論シード:同じ日・同じ浜・同じ用途なら、何度呼んでも同一系列を返す。
   用途別 salt 例 — 潮 'tide' / 漂着 'storm' / 小瓶 'bottle'。既存 mulberry を再利用。
   再描画やリロードで"今日の状態"が揺れないための土台(§1.1)。 */
function dateSeed(dk, beachId, salt) {
  return mulberry(hashString(`${dk}:${beachId}:${salt}`));
}

/* 月齢:新月からの経過日数(0..SYNODIC)。座標も数値も UI には出さない(§1.4)。
   潮位モデル(PR #2)と、将来の満月機能が参照する唯一の実装。既存の月齢計算は無かったため新設。 */
const SYNODIC = 29.530588853;                         // 朔望月(日)
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14);  // 2000-01-06 18:14 UTC の新月を基準
function lunarAge(t = Date.now()) {
  const days = (t - NEW_MOON_EPOCH) / 86400000;
  return ((days % SYNODIC) + SYNODIC) % SYNODIC;
}

/* ---------- 潮の満ち引き(§2 潮位モデル) ----------
   月齢のみから決定論的に近似する(航海用途ではない感覚重視の近似)。
   tideLevel ∈ [−1(最干) .. +1(最満)]。座標は内部利用のみ・UIには一切出さない。 */
const T_TIDE = 12.42;                 // 半日周潮(M2)の周期(時間)
const TIDE_RANGE = 0.08;              // 汀線が上下する画面比(高さH基準の片振幅)
const frac = (x) => x - Math.floor(x);
function computeTide(now, beach) {
  const hours = now / HOUR_MS;
  const beachLagH = -(beach?.lon ?? 0) / 15;               // 経度から時差様のラグ(内部利用のみ)
  const phase = frac((hours - beachLagH) / T_TIDE);        // 0..1。T_TIDE≠12h ゆえ毎日約50分ずれる
  const baseHeight = Math.cos(2 * Math.PI * phase);        // +1 満潮 / −1 干潮
  const springFactor = Math.abs(Math.cos(2 * Math.PI * lunarAge(now) / SYNODIC)); // 新月・満月で大
  const amplitude = 0.55 + 0.45 * springFactor;            // 0.55..1.0(大潮/小潮)
  return amplitude * baseHeight;
}

/* 保存された渚の状態を、経過時間ぶんだけ進める(浜を離れている間も貝は溜まる) */
function advanceShore(stored, now, weather, beach) {
  let items = stored?.items ? [...stored.items] : null;
  let lastWash = stored?.lastWash ?? now;
  let day = stored?.day ?? dateKey(now);
  let dayCount = stored?.dayCount ?? 0;

  if (items === null) {
    /* 初回訪問:すでにいくつか打ち上がっている(上限には数えない) */
    items = [];
    for (let i = 0; i < FIRST_VISIT; i++) items.push(newShoreItem(weather, beach));
    return { items, lastWash: now, day: dateKey(now), dayCount: 0 };
  }
  if (day !== dateKey(now)) { day = dateKey(now); dayCount = 0; }   // 日が変われば(ローカル0:00)上限リセット

  const fullHours = Math.floor((now - lastWash) / WASH_INTERVAL);
  let n = Math.max(0, Math.min(fullHours, DAILY_CAP - dayCount, MAX_ON_SHORE - items.length));
  for (let i = 0; i < n; i++) items.push(newShoreItem(weather, beach));
  if (n > 0) dayCount += n;
  /* 満杯・上限で溜めきれなかったぶんは繰り越さず、時計を今に合わせる */
  lastWash = (n === fullHours) ? lastWash + fullHours * WASH_INTERVAL : now;
  return { items, lastWash, day, dayCount };
}
function newShoreItem(weather, beach) {
  return { id: rollItem(weather, beach), seed: (Math.random() * 1e9) | 0 };
}

/* ---------- 天気 ---------- */
const WEATHER_KINDS = {
  clear: { label: "晴れ", icon: "○" },
  cloudy: { label: "曇り", icon: "☁" },
  rain: { label: "雨", icon: "☂" },
  snow: { label: "雪", icon: "❄" },
};
function codeToKind(code) {
  if (code <= 1) return "clear";
  if (code <= 48) return "cloudy";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 51) return "rain";
  return "cloudy";
}
/* 荒れた海の後はシーグラスが見つかりやすい */
function isBonus(w) {
  return w && (w.kind === "rain" || w.kind === "snow" || (w.wind ?? 0) >= 25);
}
function pickWeighted(pairs, rnd = Math.random) {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[0][0];
}
/* rnd を渡すと決定論的に引ける(潮間帯の個体生成で使用)。省略時は従来どおり Math.random */
function rollItem(weather, beach, rnd = Math.random) {
  const bonus = isBonus(weather);
  const cat = pickWeighted([
    ["石", bonus ? 28 : 40], ["貝殻", bonus ? 26 : 34],
    ["シーグラス", bonus ? 40 : 22], ["陶片", bonus ? 6 : 4],
  ], rnd);
  /* 石は「その浜の地層」に応じた表から。浜が未指定なら無難な既定表を使う */
  if (cat === "石") return pickWeighted(beach?.stones || DEFAULT_STONES, rnd);
  if (cat === "貝殻") return pickWeighted([["futamaigai", 50], ["makigai", 35], ["sakuragai", 15]], rnd);
  if (cat === "陶片") return "touhen";
  /* 赤(glass_red)は通常スポーンに出さない。時化の漂着(§3)でのみ入手できる */
  return pickWeighted([["glass_green", 34], ["glass_white", 26], ["glass_brown", 18], ["glass_aqua", 13], ["glass_blue", 9]], rnd);
}

/* ---------- 色ユーティリティ ---------- */
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`;
}
/* 時刻 × 天気 → 空と海のパレット */
function scenePalette(hour, kind) {
  let sky1, sky2, sea1, sea2, light;
  if (hour < 5 || hour >= 20) { sky1 = "#1d2c3a"; sky2 = "#2c4250"; sea1 = "#22414c"; sea2 = "#14262e"; light = 0.35; }
  else if (hour < 8) { sky1 = "#e9c39c"; sky2 = "#bcd0cd"; sea1 = "#7cabab"; sea2 = "#3d6f77"; light = 0.85; }
  else if (hour < 17) { sky1 = "#a8dbe6"; sky2 = "#e3f0ec"; sea1 = "#63a9ad"; sea2 = "#2f7078"; light = 1; }
  else { sky1 = "#eeb98d"; sky2 = "#ccd0c8"; sea1 = "#7da4a1"; sea2 = "#3c6a6d"; light = 0.8; }
  const gray = kind === "clear" ? 0 : kind === "cloudy" ? 0.45 : 0.62;
  const g1 = "#9aa4a6", g2 = "#c6ccc9", gs1 = "#6f8d8f", gs2 = "#3a5457";
  return {
    sky1: mix(sky1, g1, gray), sky2: mix(sky2, g2, gray),
    sea1: mix(sea1, gs1, gray), sea2: mix(sea2, gs2, gray),
    light: light * (1 - gray * 0.4), kind, hour,
  };
}

/* ---------- 漂着物の描画(浜と図鑑で共用) ---------- */
function drawItem(ctx, id, seed, s) {
  const def = CATALOG.find(d => d.id === id);
  const rnd = mulberry(seed);
  ctx.save();
  ctx.rotate((rnd() - 0.5) * 0.9);
  /* 影 */
  ctx.save();
  ctx.translate(1.5 * s, 2.2 * s);
  ctx.fillStyle = "rgba(70,60,45,0.22)";
  ctx.beginPath(); ctx.ellipse(0, 0, 11 * s, 6.5 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  if (def.cat === "石") {
    /* 石の色・肌合いはカタログの stone 設定から。土地ごとの石を一つの描画で扱う */
    const st = def.stone || { c0: "#a49a8b", c1: "#6e675c", style: "speck" };
    const g = ctx.createRadialGradient(-3 * s, -4 * s, 1, 0, 0, 13 * s);
    g.addColorStop(0, st.c0); g.addColorStop(1, st.c1);
    ctx.fillStyle = g;
    /* seedから生まれる、二つとない小石の輪郭 */
    const pebble = pebblePoints(rnd, 10.5 * s);
    poly(ctx, pebble, 4 * s); ctx.fill();
    /* 肌合いは石の輪郭の内側だけに */
    ctx.save();
    poly(ctx, pebble, 4 * s); ctx.clip();
    drawStoneTexture(ctx, st, rnd, s);
    ctx.restore();
  } else if (def.cat === "貝殻") {
    if (id === "makigai") {
      const g = ctx.createLinearGradient(-8 * s, -8 * s, 8 * s, 8 * s);
      g.addColorStop(0, "#e8d9c4"); g.addColorStop(1, "#b99c7f");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-9 * s, 6 * s);
      ctx.quadraticCurveTo(-2 * s, 10 * s, 6 * s, 6 * s);
      ctx.quadraticCurveTo(12 * s, 2 * s, 7 * s, -5 * s);
      ctx.quadraticCurveTo(2 * s, -10 * s, -3 * s, -5 * s);
      ctx.quadraticCurveTo(-8 * s, -1 * s, -9 * s, 6 * s);
      ctx.fill();
      ctx.strokeStyle = "rgba(130,102,76,0.6)"; ctx.lineWidth = 0.9 * s;
      ctx.beginPath();
      let a = 0, r = 7.5 * s;
      ctx.moveTo(2 * s + r, -1 * s);
      for (let i = 0; i < 42; i++) { a += 0.24; r *= 0.955; ctx.lineTo(2 * s + Math.cos(a) * r, -1 * s + Math.sin(a) * r * 0.8); }
      ctx.stroke();
    } else {
      const pink = id === "sakuragai";
      const g = ctx.createLinearGradient(0, -9 * s, 0, 8 * s);
      g.addColorStop(0, pink ? "#f3cdd2" : "#efe3ce");
      g.addColorStop(1, pink ? "#e5a7b1" : "#cbb392");
      ctx.fillStyle = pink ? "rgba(238,180,190,0.92)" : g;
      ctx.beginPath();
      ctx.moveTo(0, 8 * s);
      ctx.quadraticCurveTo(-12 * s, 4 * s, -9 * s, -4 * s);
      ctx.quadraticCurveTo(-5 * s, -10 * s, 0, -9.5 * s);
      ctx.quadraticCurveTo(5 * s, -10 * s, 9 * s, -4 * s);
      ctx.quadraticCurveTo(12 * s, 4 * s, 0, 8 * s);
      ctx.fill();
      ctx.strokeStyle = pink ? "rgba(200,120,135,0.55)" : "rgba(150,120,85,0.5)";
      ctx.lineWidth = 0.8 * s;
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath(); ctx.moveTo(0, 7.5 * s);
        ctx.quadraticCurveTo(i * 2.4 * s, 0, i * 2.9 * s, -8 * s);
        ctx.stroke();
      }
    }
  } else if (id === "touhen") {
    ctx.fillStyle = "#f1ede2";
    const pts = shardPoints(rnd, 10 * s);
    poly(ctx, pts); ctx.fill();
    ctx.save(); poly(ctx, pts); ctx.clip();
    ctx.strokeStyle = "rgba(58,88,140,0.8)"; ctx.lineWidth = 1.3 * s;
    ctx.beginPath(); ctx.moveTo(-10 * s, 2 * s); ctx.quadraticCurveTo(0, -6 * s, 10 * s, 1 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-9 * s, 6 * s); ctx.quadraticCurveTo(0, 0, 9 * s, 5 * s); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = "rgba(120,115,100,0.5)"; ctx.lineWidth = 0.7 * s; poly(ctx, pts); ctx.stroke();
  } else if (id === "driftwood") {
    /* 流木:横に長い、潮に洗われた枝。seed で反り・木肌が一点ずつ変わる */
    const len = 11 * s, th = (4 + rnd() * 1.6) * s;    // 長さと太さ(石より大きめ)
    const bend = (rnd() - 0.5) * 4.5 * s;                // ゆるやかな反り
    const g = ctx.createLinearGradient(0, -th, 0, th);
    g.addColorStop(0, "#a8977c"); g.addColorStop(0.5, "#8a795f"); g.addColorStop(1, "#6f5f49");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.quadraticCurveTo(-len * 0.5, -th + bend, 0, -th * 0.85);
    ctx.quadraticCurveTo(len * 0.6, -th * 0.7 + bend, len, -th * 0.4);
    ctx.quadraticCurveTo(len + th, 0, len, th * 0.4);
    ctx.quadraticCurveTo(len * 0.6, th * 0.7 + bend, 0, th * 0.85);
    ctx.quadraticCurveTo(-len * 0.5, th + bend, -len, 0);
    ctx.closePath(); ctx.fill();
    /* 木目と、洗われて色の抜けた木口 */
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.quadraticCurveTo(-len * 0.5, -th + bend, 0, -th * 0.85);
    ctx.quadraticCurveTo(len * 0.6, -th * 0.7 + bend, len, -th * 0.4);
    ctx.quadraticCurveTo(len + th, 0, len, th * 0.4);
    ctx.quadraticCurveTo(len * 0.6, th * 0.7 + bend, 0, th * 0.85);
    ctx.quadraticCurveTo(-len * 0.5, th + bend, -len, 0);
    ctx.closePath(); ctx.clip();
    ctx.strokeStyle = "rgba(60,48,34,0.4)"; ctx.lineWidth = 0.7 * s;
    for (let i = 0; i < 3; i++) {
      const oy = (-2 + i * 2 + (rnd() - 0.5)) * s;
      ctx.beginPath(); ctx.moveTo(-len, oy);
      ctx.quadraticCurveTo(0, oy + bend * 0.4, len, oy * 0.6); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(240,232,218,0.5)"; ctx.lineWidth = 1.1 * s;
    ctx.beginPath(); ctx.ellipse(len, 0, th * 0.5, th * 0.7, 0, -Math.PI / 2, Math.PI / 2); ctx.stroke();
    ctx.restore();
  } else {
    /* シーグラス:すりガラスの質感と、稀少色のほのかな光 */
    const c = def.glass;
    const pts = shardPoints(rnd, 9.5 * s, true);
    if (def.rarity >= 4) { ctx.shadowColor = c; ctx.shadowBlur = 14 * s; }
    ctx.fillStyle = c;
    poly(ctx, pts, 3 * s); ctx.fill();
    ctx.shadowBlur = 0;
    const g = ctx.createRadialGradient(-2 * s, -2.5 * s, 1, 0, 0, 10 * s);
    g.addColorStop(0, "rgba(255,255,255,0.65)"); g.addColorStop(1, "rgba(255,255,255,0.05)");
    ctx.fillStyle = g;
    poly(ctx, pts, 3 * s); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 0.8 * s;
    poly(ctx, pts, 3 * s); ctx.stroke();
  }
  ctx.restore();
}
/* 小瓶(§4)。汀線に横たわる手紙入りのガラス瓶。pool で硝子の色みが変わる。
   日常=淡い海の色 / 核心=赤み。seed で傾き・中の紙が一点ずつ変わる。 */
function drawBottle(ctx, seed, pool, s) {
  const rnd = mulberry(seed);
  ctx.save();
  ctx.rotate((rnd() - 0.5) * 0.5 - 0.12);   // 少し傾いて横たわる
  /* 影 */
  ctx.save();
  ctx.translate(1.5 * s, 2.6 * s);
  ctx.fillStyle = "rgba(70,60,45,0.22)";
  ctx.beginPath(); ctx.ellipse(0, 0, 13 * s, 5 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  const glass = pool === "core" ? "rgba(196,106,106,0.5)" : "rgba(150,196,178,0.48)";
  const rim = pool === "core" ? "rgba(230,165,155,0.9)" : "rgba(210,235,225,0.9)";
  /* 胴〜首〜口 */
  ctx.beginPath();
  ctx.moveTo(-11 * s, -5 * s);
  ctx.lineTo(6 * s, -5 * s);
  ctx.lineTo(9 * s, -3 * s);
  ctx.lineTo(12.5 * s, -2.6 * s);
  ctx.lineTo(12.5 * s, 2.6 * s);
  ctx.lineTo(9 * s, 3 * s);
  ctx.lineTo(6 * s, 5 * s);
  ctx.lineTo(-11 * s, 5 * s);
  ctx.quadraticCurveTo(-14.5 * s, 0, -11 * s, -5 * s);
  ctx.closePath();
  ctx.fillStyle = glass; ctx.fill();
  /* 中の、丸めた手紙 */
  ctx.fillStyle = "rgba(245,238,220,0.85)";
  ctx.beginPath(); ctx.ellipse(-3 * s, 0, 4.6 * s, 2.6 * s, 0.2, 0, Math.PI * 2); ctx.fill();
  /* 縁とハイライト */
  ctx.strokeStyle = rim; ctx.lineWidth = 0.9 * s;
  ctx.beginPath();
  ctx.moveTo(-11 * s, -5 * s); ctx.lineTo(6 * s, -5 * s); ctx.lineTo(9 * s, -3 * s); ctx.lineTo(12.5 * s, -2.6 * s);
  ctx.lineTo(12.5 * s, 2.6 * s); ctx.lineTo(9 * s, 3 * s); ctx.lineTo(6 * s, 5 * s); ctx.lineTo(-11 * s, 5 * s);
  ctx.quadraticCurveTo(-14.5 * s, 0, -11 * s, -5 * s); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 0.8 * s;
  ctx.beginPath(); ctx.moveTo(-9 * s, -3.2 * s); ctx.lineTo(4 * s, -3.2 * s); ctx.stroke();
  /* コルク */
  ctx.fillStyle = "rgba(168,128,88,0.92)";
  ctx.fillRect(12.5 * s, -2.4 * s, 2.6 * s, 4.8 * s);
  ctx.restore();
}
/* 石の肌合い。輪郭でクリップされた内側に描く前提 */
function drawStoneTexture(ctx, st, rnd, s) {
  const style = st.style;
  if (style === "band" || style === "schist") {
    /* 地層のような、ゆるやかな縞 */
    ctx.strokeStyle = st.line || "rgba(240,235,222,0.7)";
    ctx.lineWidth = (style === "schist" ? 1.0 : 1.6) * s;
    const bands = 2 + Math.floor(rnd() * 3);
    const tilt = (rnd() - 0.5) * 6 * s;
    for (let b = 0; b < bands; b++) {
      const off = (-6 + b * (12 / bands) + rnd() * 2) * s;
      ctx.beginPath();
      ctx.moveTo(-14 * s, off);
      ctx.quadraticCurveTo(0, off - 2 * s + tilt, 14 * s, off);
      ctx.stroke();
    }
  } else if (style === "agate") {
    /* 瑪瑙・錦石:透ける層が幾重にも重なる同心の縞 */
    const cx = (rnd() - 0.5) * 4 * s, cy = (rnd() - 0.5) * 3 * s;
    const rot = (rnd() - 0.5) * 0.8;
    const cols = st.bands || ["rgba(255,255,255,0.5)", "rgba(190,170,140,0.4)"];
    const rings = 3 + Math.floor(rnd() * 3);
    for (let i = rings; i >= 1; i--) {
      ctx.fillStyle = cols[i % cols.length];
      ctx.beginPath();
      ctx.ellipse(cx, cy, (2 + i * 2.2) * s, (1.6 + i * 1.8) * s, rot, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (style === "grain") {
    /* 珪化木:年輪を思わせる、長く流れる木目 */
    ctx.strokeStyle = st.line || "rgba(70,54,36,0.5)";
    ctx.lineWidth = 0.8 * s;
    const lines = 4 + Math.floor(rnd() * 3);
    for (let i = 0; i < lines; i++) {
      const off = (-9 + i * (18 / lines)) * s;
      ctx.beginPath();
      ctx.moveTo(-14 * s, off + (rnd() - 0.5) * 1.5 * s);
      ctx.quadraticCurveTo(0, off + (rnd() - 0.5) * 2 * s, 14 * s, off + (rnd() - 0.5) * 1.5 * s);
      ctx.stroke();
    }
  } else if (style === "gloss") {
    /* 黒石:濡れたような艶。ひとすじの明るい照り返し */
    const hg = ctx.createLinearGradient(-6 * s, -8 * s, 4 * s, 4 * s);
    hg.addColorStop(0, "rgba(255,255,255,0.5)");
    hg.addColorStop(0.4, "rgba(255,255,255,0.08)");
    hg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.ellipse(-3 * s, -4 * s, 6 * s, 3.4 * s, -0.5, 0, Math.PI * 2); ctx.fill();
  } else if (style === "porous") {
    /* 珊瑚石:潮の通う細かな穴 */
    ctx.fillStyle = st.line || "rgba(150,135,110,0.4)";
    const holes = 7 + Math.floor(rnd() * 6);
    for (let i = 0; i < holes; i++) {
      ctx.beginPath();
      ctx.arc((rnd() - 0.5) * 16 * s, (rnd() - 0.5) * 11 * s, (0.6 + rnd() * 1.2) * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (style === "jade") {
    /* 翡翠:透明感のあるつや。淡い斑がゆらぐ */
    const jg = ctx.createRadialGradient(-3 * s, -4 * s, 1, 0, 0, 12 * s);
    jg.addColorStop(0, "rgba(255,255,255,0.55)");
    jg.addColorStop(0.5, "rgba(255,255,255,0.08)");
    jg.addColorStop(1, "rgba(120,180,140,0.15)");
    ctx.fillStyle = jg;
    ctx.beginPath(); ctx.ellipse(0, 0, 12 * s, 8 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse((rnd() - 0.5) * 10 * s, (rnd() - 0.5) * 7 * s, (1 + rnd() * 2) * s, (0.8 + rnd()) * s, rnd(), 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    /* speck:海砂に磨かれた石の、こまかな斑点 */
    ctx.fillStyle = st.line || "rgba(235,228,215,0.4)";
    const specks = 4 + Math.floor(rnd() * 5);
    for (let i = 0; i < specks; i++) {
      ctx.beginPath();
      ctx.arc((rnd() - 0.5) * 16 * s, (rnd() - 0.5) * 11 * s, (0.4 + rnd() * 0.7) * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
function poly(ctx, pts, round = 0) {
  ctx.beginPath();
  if (!round) { pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); return; }
  const n = pts.length;
  for (let i = 0; i <= n; i++) {
    const p = pts[i % n], q = pts[(i + 1) % n];
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    if (i === 0) ctx.moveTo(mx, my); else ctx.quadraticCurveTo(p[0], p[1], mx, my);
  }
  ctx.closePath();
}
function shardPoints(rnd, r, smooth = false) {
  /* 頂点数も揺らして、輪郭そのものを一点ものにする */
  const n = (smooth ? 5 : 4) + Math.floor(rnd() * 3);
  const squash = 0.72 + rnd() * 0.26;   // 縦横比の個体差
  const rot = rnd() * Math.PI;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rot + (rnd() - 0.5) * 0.7;
    const rr = r * (0.6 + rnd() * 0.5);
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr * squash]);
  }
  return pts;
}
function pebblePoints(rnd, r) {
  /* なめらかで丸みのある、海で磨かれた石の輪郭 */
  const n = 7 + Math.floor(rnd() * 4);
  const squash = 0.62 + rnd() * 0.28;
  const rot = rnd() * Math.PI;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rot;
    const rr = r * (0.82 + rnd() * 0.24);   // ゆるやかな凹凸
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr * squash]);
  }
  return pts;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 図鑑用ミニキャンバス ---------- */
function ItemThumb({ id, seed, size = 64, scale = 2.4 }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr; cv.height = size * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.translate(size / 2, size / 2);
    const s = seed ?? (7 + id.length * 31);
    drawItem(ctx, id, s, scale);
  }, [id, seed, size, scale]);
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

/* ============================================================ */
export default function App() {
  const [screen, setScreen] = useState("select");
  const [beach, setBeach] = useState(null);
  const [collection, setCollection] = useState({});
  const [finds, setFinds] = useState([]);             // 拾った全個体 {id,seed,beachId,time}
  const [beachNames, setBeachNames] = useState({});   // {beachId: 自分でつけた名前}
  const [fontReady, setFontReady] = useState(false);

  /* 明朝体を読み込み(失敗しても游明朝等にフォールバック) */
  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;600;700&display=swap";
    l.onload = () => setFontReady(true);
    document.head.appendChild(l);
    return () => l.remove();
  }, []);

  /* コレクションと浜の名前の読み込み */
  useEffect(() => {
    (async () => {
      try {
        const r = await storage.get("seaglass-collection");
        if (r?.value) setCollection(JSON.parse(r.value));
      } catch { /* 初回は未保存 */ }
      try {
        const r = await storage.get("seaglass-finds");
        if (r?.value) setFinds(JSON.parse(r.value));
      } catch { /* 初回は未保存 */ }
      try {
        const r = await storage.get("seaglass-beach-names");
        if (r?.value) setBeachNames(JSON.parse(r.value));
      } catch { /* 初回は未保存 */ }
    })();
  }, []);

  /* 表示用の浜(名前付き)。参照を安定させ、拾得のたびの再生成で
     漂着物の位置がリセットされるのを防ぐ */
  const beachView = useMemo(
    () => (beach ? { ...beach, name: beachNames[beach.id] || beach.name } : null),
    [beach, beachNames],
  );

  const saveBeachName = useCallback((beachId, name) => {
    setBeachNames(prev => {
      const next = { ...prev, [beachId]: name };
      try { storage.set("seaglass-beach-names", JSON.stringify(next)); } catch { }
      return next;
    });
  }, []);

  const addToCollection = useCallback((id, seed, beachId) => {
    setCollection(prev => {
      const cur = prev[id];
      const count = (typeof cur === "number" ? cur : cur?.count || 0) + 1;
      const next = { ...prev, [id]: { count, seed } };   // seed = 最後に拾った個体の形
      try { storage.set("seaglass-collection", JSON.stringify(next)); } catch { }
      return next;
    });
    setFinds(prev => {
      const next = [...prev, { id, seed, beachId, time: Date.now() }];
      const trimmed = next.length > 1000 ? next.slice(-1000) : next;
      try { storage.set("seaglass-finds", JSON.stringify(trimmed)); } catch { }
      return trimmed;
    });
  }, []);

  const font = `"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif`;

  return (
    <div style={{ position: "fixed", inset: 0, fontFamily: font, color: "#33413f", overflow: "hidden", background: "#dce8e4" }}>
      {screen === "select" && (
        <BeachSelect
          beachNames={beachNames}
          collection={collection}
          onPick={(b) => { setBeach(b); setScreen(beachNames[b.id] ? "beach" : "naming"); }}
        />
      )}
      {screen === "naming" && beach && (
        <NamingCeremony
          beach={beach}
          onConfirm={(name) => { saveBeachName(beach.id, name); setScreen("beach"); }}
          onBack={() => setScreen("select")}
        />
      )}
      {screen === "beach" && beach && (
        <BeachScene
          beach={beachView}
          collection={collection}
          finds={finds}
          beachNames={beachNames}
          onCollect={addToCollection}
          onLeave={() => setScreen("select")}
        />
      )}
    </div>
  );
}

/* ============================================================
   海岸を選ぶ画面
   ============================================================ */
function BeachSelect({ onPick, collection, beachNames }) {
  const found = Object.keys(collection).length;
  return (
    <div style={{
      position: "absolute", inset: 0, overflowY: "auto",
      background: "linear-gradient(180deg,#cfe4e2 0%,#e9e2cf 78%,#e3d7bd 100%)",
    }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "56px 24px 48px" }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ fontSize: 13, letterSpacing: "0.45em", opacity: 0.6, marginBottom: 14 }}>海 か ら の 贈 り も の</div>
          <h1 style={{ margin: 0, fontSize: "clamp(24px, 6.5vw, 34px)", fontWeight: 600, letterSpacing: "0.22em", textIndent: "0.22em", whiteSpace: "nowrap" }}>シーグラスをさがして</h1>
          <div style={{ width: 46, height: 1, background: "#33413f55", margin: "22px auto" }} />
          <p style={{ fontSize: 14, lineHeight: 2, opacity: 0.75, margin: 0 }}>
            地図には載っていない、あなただけの海岸。<br />
            空模様は、それぞれの海の今日ほんとうの天気。<br />
            荒れた海の翌朝は、宝ものが多く打ち上がります。
          </p>
        </div>

        <div style={{ fontSize: 12, letterSpacing: "0.25em", opacity: 0.55, marginBottom: 14 }}>── 今日はどの浜を歩きますか</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {BEACHES.map(b => (
            <button key={b.id} onClick={() => onPick(b)}
              style={{
                textAlign: "left", cursor: "pointer", border: "1px solid rgba(51,65,63,0.18)",
                background: "rgba(255,253,247,0.72)", borderRadius: 4, padding: "16px 18px",
                fontFamily: "inherit", color: "inherit", transition: "background .2s, transform .2s",
              }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,253,247,0.95)"}
              onMouseLeave={e => e.currentTarget.style.background = "rgba(255,253,247,0.72)"}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: "0.12em", opacity: beachNames[b.id] ? 1 : 0.55 }}>
                  {beachNames[b.id] || "名もなき浜"}
                </span>
                <span style={{ fontSize: 11.5, opacity: 0.55, letterSpacing: "0.08em" }}>{b.region}</span>
              </div>
              <div style={{ fontSize: 12.5, opacity: 0.68, marginTop: 6, letterSpacing: "0.04em" }}>{b.note}</div>
              {!beachNames[b.id] && (
                <div style={{ fontSize: 11, marginTop: 6, color: "#4c7a6d", letterSpacing: "0.12em" }}>
                  はじめて訪れる浜 ── 名前をつけましょう
                </div>
              )}
            </button>
          ))}
        </div>

        <div style={{ textAlign: "center", marginTop: 34, fontSize: 12, opacity: 0.55, letterSpacing: "0.15em" }}>
          図鑑 {found} / {CATALOG.length} 種
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   命名の儀式 — はじめて訪れる浜に、名前をつける
   ============================================================ */
function NamingCeremony({ beach, onConfirm, onBack }) {
  const [name, setName] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const confirm = () => onConfirm((name.trim() || beach.name).slice(0, 12));

  return (
    <div style={{
      position: "absolute", inset: 0, overflowY: "auto",
      background: "linear-gradient(180deg,#bfd8d6 0%,#dfe4d4 55%,#e7dcc0 100%)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{ maxWidth: 420, width: "100%", padding: "40px 28px", textAlign: "center", animation: "sg-rise .6s cubic-bezier(.2,.8,.3,1)" }}>
        <div style={{ fontSize: 12, letterSpacing: "0.35em", opacity: 0.6 }}>{beach.region} ── はじめて訪れる浜</div>
        <p style={{ fontSize: 13.5, lineHeight: 2, opacity: 0.7, margin: "18px 0 0" }}>{beach.note}。</p>
        <div style={{ width: 40, height: 1, background: "#33413f44", margin: "26px auto" }} />
        <div style={{ fontSize: 17, letterSpacing: "0.2em", marginBottom: 22 }}>この浜に、名前をつけましょう</div>

        <input
          ref={inputRef}
          value={name}
          maxLength={12}
          placeholder={beach.name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") confirm(); }}
          style={{
            fontFamily: "inherit", fontSize: 24, fontWeight: 600, letterSpacing: "0.15em",
            textAlign: "center", color: "#33413f", background: "transparent",
            border: "none", borderBottom: "1px solid rgba(51,65,63,0.45)",
            outline: "none", padding: "6px 4px", width: "min(300px, 82%)",
          }}
        />
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 12, letterSpacing: "0.1em" }}>
          そのままにすると「{beach.name}」と呼ばれます
        </div>

        <div style={{ marginTop: 34, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <button onClick={confirm} style={{
            fontFamily: "inherit", fontSize: 14, letterSpacing: "0.22em",
            padding: "12px 34px", cursor: "pointer", background: "#33413f", color: "#f6f3ea",
            border: "none", borderRadius: 3,
          }}>
            この名前で歩きはじめる
          </button>
          <button onClick={onBack} style={{
            fontFamily: "inherit", fontSize: 12, letterSpacing: "0.15em",
            background: "none", border: "none", cursor: "pointer",
            color: "#33413f", opacity: 0.6, textDecoration: "underline", textUnderlineOffset: 4,
          }}>
            浜を選びなおす
          </button>
        </div>
      </div>
      <style>{`@keyframes sg-rise { from { transform:translateY(24px); opacity:0 } to { transform:none; opacity:1 } }`}</style>
    </div>
  );
}

/* ============================================================
   浜辺の画面
   ============================================================ */
function BeachScene({ beach, collection, finds, beachNames, onCollect, onLeave }) {
  const canvasRef = useRef(null);
  const [weather, setWeather] = useState(null);          // {kind,label,temp,wind,source}
  const [discovery, setDiscovery] = useState(null);       // 拾ったもののモーダル
  const [showBook, setShowBook] = useState(false);
  const [bookTab, setBookTab] = useState("catalog");      // catalog(図鑑) | shelf(棚)
  const [shelfPick, setShelfPick] = useState(null);       // 棚で拡大表示する個体
  const [hint, setHint] = useState(true);
  const [onShore, setOnShore] = useState(null);          // 浜にある数(潮が静かなときの案内用)
  const [bottles, setBottles] = useState(null);           // 小瓶の状態(断片・アーム・全容)
  const [fragment, setFragment] = useState(null);         // 小瓶を開いたときの断片モーダル
  const weatherRef = useRef(null);
  const stateRef = useRef(null);                          // アニメーション用の可変状態
  const shoreRef = useRef(null);                          // 渚の状態 {items,lastWash,day,dayCount}
  const tideRef = useRef(0);                              // 現在の潮位 tideLevel(1分tickで更新)
  const tidePoolRef = useRef(null);                       // 潮間帯の個体 {day,items:[{id,seed,rx,ry}]}
  const washupsRef = useRef(null);                        // 時化の漂着 {lastCheckedDate,stormedToday,items:[...]}
  const bottlesRef = useRef(null);                        // 小瓶の状態(canvas/ロジック用のミラー)
  const presentBottleRef = useRef(null);                  // 今この浜にひらいている小瓶 {pool,key,seed}

  const persistShore = useCallback(() => {
    const s = shoreRef.current; if (!s) return;
    try { storage.set(`seaglass-shore-${beach.id}`, JSON.stringify(s)); } catch { }
  }, [beach.id]);

  const persistTidePool = useCallback(() => {
    const s = tidePoolRef.current; if (!s) return;
    saveTidePool({ id: beach.id }, s);
  }, [beach.id]);

  const persistWashups = useCallback(() => {
    const s = washupsRef.current; if (!s) return;
    saveWashups(beach.id, s);
  }, [beach.id]);

  /* --- 渚の状態を読み込み、経過時間ぶん進める --- */
  useEffect(() => {
    let alive = true;
    (async () => {
      let stored = null;
      try {
        const r = await storage.get(`seaglass-shore-${beach.id}`);
        if (r?.value) stored = JSON.parse(r.value);
      } catch { /* 初回は未保存 */ }
      if (!alive) return;
      const advanced = advanceShore(stored, Date.now(), weatherRef.current, beach);
      shoreRef.current = advanced;
      persistShore();
    })();
    return () => { alive = false; };
  }, [beach.id, persistShore]);

  /* --- 潮間帯の個体を読み込み(当日分は引き継ぎ、日が変われば新規生成) --- */
  useEffect(() => {
    let alive = true;
    (async () => {
      const pool = await loadTidePool({ id: beach.id, stones: beach.stones }, dateKey(Date.now()));
      if (!alive) return;
      tidePoolRef.current = pool;
      persistTidePool();
    })();
    return () => { alive = false; };
  }, [beach.id, beach.stones, persistTidePool]);

  /* --- 潮位は1分ごとに更新(毎フレーム再計算しない)。描画は tideRef を読むだけ --- */
  useEffect(() => {
    const tick = () => { tideRef.current = computeTide(Date.now(), beach); };
    tick();
    const iv = setInterval(tick, 60_000);
    return () => clearInterval(iv);
  }, [beach.id, beach.lon]);

  /* --- 時化の漂着:朝の一度きり。清掃 → 前日天気の取得 → 当日ぶんの生成(§3.5) --- */
  useEffect(() => {
    let alive = true;
    (async () => {
      const today = dateKey(Date.now());
      const stored = await loadWashups(beach.id);   // {lastCheckedDate,items,...} 未定義はデフォルト補完
      if (!alive) return;
      let { lastCheckedDate, items } = stored;
      let stormedToday = stored.stormedToday ?? false;
      if (lastCheckedDate !== today) {
        items = cleanWashups(items, today);                       // 翌々日を迎えた未採取分を潮が引き取る
        const real = await fetchStormIntensity(beach, today);     // 前日天気(当日1回だけ)
        if (!alive) return;
        /* 取得できない体験モードでは、日付と浜から決まる擬似強度で稀に打ち上げる */
        const intensity = real != null ? real : dateSeed(today, beach.id, "storm-demo")() * 0.5;
        const fresh = generateWashups(today, beach, intensity);   // appearedDate=today を付けて追加
        items = items.concat(fresh);
        stormedToday = fresh.length > 0;
        lastCheckedDate = today;
      }
      const next = { lastCheckedDate, stormedToday, items };
      washupsRef.current = next;
      saveWashups(beach.id, next);
    })();
    return () => { alive = false; };
  }, [beach.id, beach.lat, beach.lon]);

  /* --- 小瓶:収集マイルストーンの判定とアーム、今朝ひらく1本の決定(§4.2) --- */
  useEffect(() => {
    let alive = true;
    (async () => {
      let b = bottlesRef.current;
      if (!b) { b = await loadBottles(); if (!alive) return; }   // 全体で1つ。初回だけ読み込む
      const today = dateKey(Date.now());
      /* しきい値判定は既存の収集データから毎回導出(専用カウンタは持たない・非消費) */
      const se = Math.min(Math.floor(bottleColorCount(collection, SURFACE_COLORS) / SURFACE_COUNT), BOTTLE_MESSAGES.surface.length);
      const ce = Math.min(Math.floor(bottleColorCount(collection, CORE_COLORS) / CORE_COUNT), BOTTLE_MESSAGES.core.length);
      let changed = false;
      /* 跨いだぶんをアーム(即座には出さず、次の 0:00 に流れ着く)。二重発生は triggered で防ぐ */
      while (b.surfaceTriggered < se) {
        b.armed.push({ pool: "surface", foundBeach: lastFindBeach(finds, SURFACE_COLORS) || beach.id, armedDate: today });
        b.surfaceTriggered++; changed = true;
      }
      while (b.coreTriggered < ce) {
        b.armed.push({ pool: "core", foundBeach: lastFindBeach(finds, CORE_COLORS) || beach.id, armedDate: today });
        b.coreTriggered++; changed = true;
      }
      bottlesRef.current = b;
      if (changed) saveBottles(b);
      if (!alive) return;
      setBottles({ ...b });
      /* この浜で今朝ひらく1本(前夜までにアーム済み) */
      const present = pickPresentBottle(b, beach.id, today);
      presentBottleRef.current = present
        ? { pool: present.pool, key: `${present.pool}:${present.armedDate}:${present.foundBeach}`, seed: hashString(`${present.armedDate}:${beach.id}:${present.pool}`) }
        : null;
    })();
    return () => { alive = false; };
  }, [beach.id, collection, finds]);

  /* 小瓶を開く:次の未取得断片を渡し、図書室へ加える(順送り。全容は両プール完走で解ける) */
  const openBottle = useCallback((pool) => {
    const b = bottlesRef.current; if (!b) return;
    const today = dateKey(Date.now());
    const frag = nextFragment(pool, b.collected);
    const idx = b.armed.findIndex(a => a.pool === pool && a.armedDate < today && a.foundBeach === beach.id);
    if (idx >= 0) b.armed.splice(idx, 1);
    const wasComplete = b.storyComplete;
    if (frag) b.collected.push({ pool, id: frag.id, order: frag.order, foundBeach: beach.id, dateKey: today });
    b.storyComplete = isStoryComplete(b.collected);
    bottlesRef.current = b; saveBottles(b); setBottles({ ...b });
    presentBottleRef.current = null;
    if (frag) setFragment({ ...frag, pool, storyJustComplete: b.storyComplete && !wasComplete });
  }, [beach.id]);

  /* --- 実況天気の取得(失敗時は体験モード) --- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${beach.lat}&longitude=${beach.lon}&current=temperature_2m,weather_code,wind_speed_10m`;
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const data = await res.json();
        const cur = data.current;
        const kind = codeToKind(cur.weather_code);
        if (!alive) return;
        const w = { kind, label: WEATHER_KINDS[kind].label, temp: Math.round(cur.temperature_2m), wind: Math.round(cur.wind_speed_10m), source: "live" };
        weatherRef.current = w; setWeather(w);
      } catch {
        if (!alive) return;
        /* 日付と海岸から穏やかに揺らぐ疑似天気 */
        const rnd = mulberry(new Date().getDate() * 97 + beach.id.length * 13);
        const kind = pickWeighted([["clear", 45], ["cloudy", 32], ["rain", 18], ["snow", 5]].map(p => p));
        const w = { kind, label: WEATHER_KINDS[kind].label, temp: Math.round(14 + rnd() * 12), wind: Math.round(rnd() * 30), source: "demo" };
        weatherRef.current = w; setWeather(w);
      }
    })();
    return () => { alive = false; };
  }, [beach]);

  const setDemoWeather = (kind) => {
    const w = { ...(weatherRef.current || { temp: 20, wind: 10 }), kind, label: WEATHER_KINDS[kind].label, source: "demo" };
    weatherRef.current = w; setWeather(w);
  };

  /* --- キャンバス描画ループ --- */
  useEffect(() => {
    const cv = canvasRef.current;
    const ctx = cv.getContext("2d");
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const S = stateRef.current = {
      items: [], tideItems: [], stormItems: [], bottle: null, bottleKey: null, bursts: [], sand: [], clouds: [], drops: [],
      wet: 0, surge: 0, surgePhase: "idle", nextSurge: 4, surgePeak: 0,
      tideLevel: null, tideSeeded: false, stormSeeded: false,
      t: 0, last: performance.now(), W: 0, H: 0, motion: reduce ? 0.45 : 1,
    };

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      S.W = cv.clientWidth; S.H = cv.clientHeight;
      cv.width = S.W * dpr; cv.height = S.H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      /* 砂の粒(静的) */
      S.sand = [];
      for (let i = 0; i < 340; i++) {
        S.sand.push({ x: Math.random() * S.W, y: S.H * 0.5 + Math.random() * S.H * 0.5, r: Math.random() * 1.1 + 0.3, a: Math.random() * 0.25 + 0.05 });
      }
      S.clouds = [];
      for (let i = 0; i < 5; i++) {
        S.clouds.push({ x: Math.random() * S.W, y: S.H * (0.05 + Math.random() * 0.18), w: 80 + Math.random() * 140, v: 4 + Math.random() * 8 });
      }
      S.drops = [];
      for (let i = 0; i < 70; i++) S.drops.push({ x: Math.random() * S.W, y: Math.random() * S.H, v: 300 + Math.random() * 250 });
      /* 既存の漂着物が空側へ取り残されないよう砂浜の範囲へ収める */
      if (S.items) for (const it of S.items) {
        if (it.y < S.H * 0.6 || it.y > S.H) it.y = S.H * (0.64 + Math.random() * 0.3);
        if (it.x < 24 || it.x > S.W - 24) it.x = 24 + Math.random() * (S.W - 48);
      }
      /* 潮間帯・時化の個体は相対座標から再配置(位置は決してリセットしない) */
      if (S.tideItems) for (const it of S.tideItems) placeTideItem(it);
      if (S.stormItems) for (const it of S.stormItems) placeStormItem(it);
      if (S.bottle) placeBottle(S.bottle);
    }
    /* 潮間帯バンド(高潮線〜低潮線の内側)へ相対座標をマップ */
    function placeTideItem(it) {
      it.x = 24 + it.rx * (S.W - 48);
      it.y = S.H * (0.44 + it.ry * 0.12);
    }
    /* 時化の漂着は汀線の帯(潮間帯より浜側、常に露出)へ */
    function placeStormItem(it) {
      it.x = 24 + it.rx * (S.W - 48);
      it.y = S.H * (0.60 + it.ry * 0.10);
    }
    /* 小瓶も汀線寄りに置く(漂着感) */
    function placeBottle(b) {
      b.x = 24 + b.rx * (S.W - 48);
      b.y = S.H * (0.61 + b.ry * 0.07);
    }
    resize();
    window.addEventListener("resize", resize);

    /* 渚の状態から漂着物を並べる(位置は毎回、潮まかせで置きなおす) */
    const spawnZone = () => ({
      x: 24 + Math.random() * (S.W - 48),
      y: S.H * (0.64 + Math.random() * 0.3),
    });
    function seedFromShore() {
      const shore = shoreRef.current;
      S.items = [];
      for (const rec of shore.items.slice(-MAX_ON_SHORE)) {
        S.items.push({ id: rec.id, seed: rec.seed, ...spawnZone(), sparkle: 0, born: S.t });
      }
      setOnShore(S.items.length);
    }
    /* 潮間帯の個体を相対座標から並べる(潮位アニメとは分離。位置・形はリセットしない) */
    function seedTidePool() {
      const pool = tidePoolRef.current;
      S.tideItems = [];
      for (const rec of pool.items) {
        const it = { id: rec.id, seed: rec.seed, rx: rec.rx, ry: rec.ry };
        placeTideItem(it);
        S.tideItems.push(it);
      }
    }
    /* 時化の漂着を相対座標から並べる(24個上限とは別枠) */
    function seedStorm() {
      const wu = washupsRef.current;
      S.stormItems = [];
      for (const rec of wu.items) {
        const it = { id: rec.id, seed: rec.seed, rx: rec.rx, ry: rec.ry };
        placeStormItem(it);
        S.stormItems.push(it);
      }
    }
    /* 今朝ひらく小瓶を1本置く(なければ消す)。present の変化に追従 */
    function seedBottle() {
      const p = presentBottleRef.current;
      S.bottleKey = p ? p.key : null;
      if (!p) { S.bottle = null; return; }
      const rng = mulberry(p.seed);
      const b = { seed: p.seed, pool: p.pool, rx: rng(), ry: rng() };
      placeBottle(b);
      S.bottle = b;
    }
    /* 浜にいる間、1時間ごとに1個だけ打ち上げる(上限内で) */
    function maybeWashUp() {
      const shore = shoreRef.current; if (!shore) return;
      const now = Date.now();
      if (shore.day !== dateKey(now)) { shore.day = dateKey(now); shore.dayCount = 0; }
      if (S.items.length >= MAX_ON_SHORE) return;
      if (shore.dayCount >= DAILY_CAP) return;
      if (now - shore.lastWash < WASH_INTERVAL) return;
      const rec = newShoreItem(weatherRef.current, beach);
      shore.items.push(rec);
      shore.dayCount += 1;
      shore.lastWash += WASH_INTERVAL;
      if (now - shore.lastWash > WASH_INTERVAL) shore.lastWash = now;  // 繰り越し過多を防ぐ
      S.items.push({ id: rec.id, seed: rec.seed, ...spawnZone(), sparkle: 1.6, born: S.t });
      setOnShore(S.items.length);
      persistShore();
    }
    /* サイズと渚データが確定してから初期配置 */
    if (S.H > 0 && shoreRef.current) { seedFromShore(); S.seeded = true; }

    /* 汀線の基準Y。潮位で上下(満潮=下へ広がり浜を覆う / 干潮=上へ引いて浜が広がる)。
       波の呼吸・大波(foamOff)はこの上に別途乗る。アイテム state とは完全分離。 */
    const foamBase = () => S.H * (0.5 + (S.tideLevel ?? 0) * TIDE_RANGE);

    function frame(now) {
      const dt = Math.min(0.05, (now - S.last) / 1000);
      S.last = now; S.t += dt;
      const t = S.t, W = S.W, H = S.H;
      const w = weatherRef.current || { kind: "clear", wind: 8 };
      const pal = scenePalette(new Date().getHours(), w.kind);
      const windAmp = 1 + Math.min(1.4, (w.wind || 0) / 28);

      /* サイズ・渚データが未確定なら、確定してから初期配置 */
      if (!S.seeded) {
        if (S.H > 0 && shoreRef.current) { seedFromShore(); S.seeded = true; }
        else { S.raf = requestAnimationFrame(frame); return; }
      }
      /* 潮間帯・時化の個体は、データが届いてから一度だけ配置 */
      if (!S.tideSeeded && S.H > 0 && tidePoolRef.current) { seedTidePool(); S.tideSeeded = true; }
      if (!S.stormSeeded && S.H > 0 && washupsRef.current) { seedStorm(); S.stormSeeded = true; }
      /* 小瓶は present の変化(出現・採取)に追従して置き直す */
      if (S.H > 0 && S.bottleKey !== (presentBottleRef.current?.key ?? null)) seedBottle();
      /* 潮位を1分tickの目標値へ滑らかに追従(段差を消す。潮は緩慢なので体感差なし) */
      const tideTarget = tideRef.current ?? 0;
      if (S.tideLevel == null) S.tideLevel = tideTarget;
      else S.tideLevel += (tideTarget - S.tideLevel) * Math.min(1, dt * 0.8);

      /* --- 大波の周期 --- */
      if (S.surgePhase === "idle" && t > S.nextSurge) { S.surgePhase = "run"; S.surgeT = 0; }
      if (S.surgePhase === "run") {
        S.surgeT += dt;
        const dur = 3.2;
        S.surge = Math.sin(Math.min(1, S.surgeT / dur) * Math.PI);
        if (S.surgeT >= dur) {
          S.surgePhase = "idle"; S.surge = 0;
          S.nextSurge = t + 9 + Math.random() * 8;
          maybeWashUp();   // 波が引いたあと、頃合いなら一つだけ打ち上がる
        }
      }

      /* 波打ち際:基準 + 潮の呼吸 + 大波 */
      const breathe = (Math.sin(t * 0.55) * 16 + Math.sin(t * 0.21) * 9) * S.motion * windAmp;
      const surgeReach = S.surge * H * 0.17 * windAmp;
      const foamOff = breathe + surgeReach;
      S.wet = Math.max(S.wet - H * 0.035 * dt, foamOff);
      const foamAt = (x) =>
        foamBase() + foamOff
        + Math.sin(x * 0.012 + t * 0.9) * 7 * S.motion
        + Math.sin(x * 0.027 - t * 0.6) * 4 * S.motion;

      /* ---------- 空 ---------- */
      const horizon = H * 0.36;
      let g = ctx.createLinearGradient(0, 0, 0, horizon * 1.3);
      g.addColorStop(0, pal.sky1); g.addColorStop(1, pal.sky2);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, horizon + 2);
      if (w.kind === "clear" && pal.hour >= 5 && pal.hour < 20) {
        const sx = W * 0.72, sy = horizon * 0.42;
        const sg = ctx.createRadialGradient(sx, sy, 2, sx, sy, 70);
        sg.addColorStop(0, "rgba(255,250,230,0.9)"); sg.addColorStop(1, "rgba(255,250,230,0)");
        ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sx, sy, 70, 0, Math.PI * 2); ctx.fill();
      }
      /* 雲 */
      const cloudA = w.kind === "clear" ? 0.35 : 0.75;
      ctx.fillStyle = `rgba(255,255,255,${cloudA * pal.light * 0.8})`;
      for (const c of S.clouds) {
        c.x += c.v * dt * S.motion; if (c.x - c.w > W) c.x = -c.w;
        for (const [ox, oy, r] of [[0, 0, 0.32], [-0.3, 0.1, 0.24], [0.3, 0.12, 0.26], [0.05, -0.12, 0.22]]) {
          ctx.beginPath(); ctx.ellipse(c.x + ox * c.w, c.y + oy * c.w * 0.5, c.w * r, c.w * r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
        }
      }

      /* ---------- 砂浜(乾いた砂) ---------- */
      g = ctx.createLinearGradient(0, horizon, 0, H);
      g.addColorStop(0, mix("#d9cbab", "#b3aa97", 1 - pal.light));
      g.addColorStop(1, mix("#e9dfc6", "#c0b8a5", 1 - pal.light));
      ctx.fillStyle = g; ctx.fillRect(0, horizon, W, H - horizon);
      for (const p of S.sand) {
        ctx.fillStyle = `rgba(110,95,70,${p.a})`;
        ctx.fillRect(p.x, p.y, p.r, p.r);
      }

      /* ---------- 濡れた砂 ---------- */
      const wetDepth = Math.max(12, S.wet - foamOff + 46);
      ctx.beginPath();
      ctx.moveTo(0, foamAt(0));
      for (let x = 0; x <= W; x += 10) ctx.lineTo(x, foamAt(x));
      for (let x = W; x >= 0; x -= 10) ctx.lineTo(x, foamAt(x) + wetDepth + Math.sin(x * 0.02 + 2) * 6);
      ctx.closePath();
      const wg = ctx.createLinearGradient(0, foamBase(), 0, foamBase() + wetDepth + 60);
      wg.addColorStop(0, "rgba(120,110,88,0.55)");
      wg.addColorStop(1, "rgba(120,110,88,0)");
      ctx.fillStyle = wg; ctx.fill();

      /* ---------- 漂着物 ---------- */
      for (const it of S.items) {
        ctx.save(); ctx.translate(it.x, it.y);
        drawItem(ctx, it.id, it.seed, 1);
        ctx.restore();
        if (it.sparkle > 0) {
          it.sparkle -= dt;
          const a = Math.max(0, it.sparkle / 1.6);
          ctx.strokeStyle = `rgba(255,255,240,${a})`;
          ctx.lineWidth = 1.2;
          for (let k = 0; k < 4; k++) {
            const ang = k * Math.PI / 2 + t * 1.5, r1 = 14 + Math.sin(t * 6) * 2;
            ctx.beginPath();
            ctx.moveTo(it.x + Math.cos(ang) * r1, it.y + Math.sin(ang) * r1);
            ctx.lineTo(it.x + Math.cos(ang) * (r1 + 6), it.y + Math.sin(ang) * (r1 + 6));
            ctx.stroke();
          }
        }
      }

      /* ---------- 潮間帯の個体 ----------
         汀線基準より浜側なら露出、海側なら海ポリゴンが上に被さり水面下に透ける。
         合図は「浜が広がること」だけ。ここでは何も演出しない(§2.5)。 */
      for (const it of S.tideItems) {
        ctx.save(); ctx.translate(it.x, it.y);
        drawItem(ctx, it.id, it.seed, 1);
        ctx.restore();
      }
      /* ---------- 時化の漂着(汀線の帯・常に露出) ---------- */
      for (const it of S.stormItems) {
        ctx.save(); ctx.translate(it.x, it.y);
        drawItem(ctx, it.id, it.seed, 1);
        ctx.restore();
      }
      /* ---------- 小瓶(汀線寄り。静かに、ひとつ) ---------- */
      if (S.bottle) {
        ctx.save(); ctx.translate(S.bottle.x, S.bottle.y);
        drawBottle(ctx, S.bottle.seed, S.bottle.pool, 1);
        ctx.restore();
      }

      /* ---------- 海(半透明で、波を被ったものが透ける) ---------- */
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      ctx.lineTo(W, horizon);
      for (let x = W; x >= 0; x -= 10) ctx.lineTo(x, foamAt(x));
      ctx.closePath();
      g = ctx.createLinearGradient(0, horizon, 0, foamBase() + 60);
      g.addColorStop(0, pal.sea1); g.addColorStop(1, pal.sea2);
      ctx.globalAlpha = 0.93; ctx.fillStyle = g; ctx.fill(); ctx.globalAlpha = 1;

      /* 沖の波頭 */
      ctx.strokeStyle = `rgba(255,255,255,${0.16 * pal.light})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const y = horizon + 14 + i * ((foamBase() - horizon) / 4.4);
        ctx.beginPath();
        for (let x = 0; x <= W; x += 14) {
          const yy = y + Math.sin(x * 0.02 + t * (0.8 + i * 0.2) + i * 2) * 3;
          x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }

      /* ---------- 波の泡 ---------- */
      ctx.lineWidth = 9;
      ctx.strokeStyle = `rgba(255,255,255,${0.72 * (0.6 + pal.light * 0.4)})`;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const y = foamAt(x) - 2;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const y = foamAt(x) + 7 + Math.sin(x * 0.05 + t * 2) * 2;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      /* 引き波の名残(乾きかけの泡の線) */
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 12) {
        const y = foamBase() + S.wet + 20 + Math.sin(x * 0.02 + 5) * 6;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      /* ---------- 天候エフェクト ---------- */
      if (w.kind === "rain" || w.kind === "snow") {
        const snow = w.kind === "snow";
        ctx.strokeStyle = "rgba(220,232,238,0.5)";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1;
        for (const d of S.drops) {
          d.y += (snow ? d.v * 0.14 : d.v) * dt * S.motion;
          d.x += (snow ? Math.sin(t + d.v) * 18 : -30) * dt;
          if (d.y > H) { d.y = -10; d.x = Math.random() * W; }
          if (snow) { ctx.beginPath(); ctx.arc(d.x, d.y, 1.6, 0, Math.PI * 2); ctx.fill(); }
          else { ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - 2, d.y + 12); ctx.stroke(); }
        }
      }

      /* 拾った瞬間の波紋 */
      for (let i = S.bursts.length - 1; i >= 0; i--) {
        const b = S.bursts[i]; b.r += 60 * dt; b.a -= dt * 1.2;
        if (b.a <= 0) { S.bursts.splice(i, 1); continue; }
        ctx.strokeStyle = `rgba(255,255,255,${b.a})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(b.x, b.y, b.r, b.r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
      }

      S.raf = requestAnimationFrame(frame);
    }
    S.raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(S.raf); window.removeEventListener("resize", resize); };
  }, [beach]);

  /* --- タップで拾う --- */
  /* pointerdown ではなく click で拾う。pointerdown で拾うと、同じタップの直後に
     発生する click が、開いたばかりの発見モーダルの背景に届いてすぐ閉じてしまう。 */
  const onTapPick = (e) => {
    const S = stateRef.current; if (!S) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    /* 小瓶:汀線にひらいた1本。開くと断片がひとつ、静かに届く */
    if (S.bottle && (x - S.bottle.x) ** 2 + (y - S.bottle.y) ** 2 < 34 ** 2) {
      const pool = S.bottle.pool;
      S.bursts.push({ x: S.bottle.x, y: S.bottle.y, r: 6, a: 0.8 });
      S.bottle = null; S.bottleKey = null;
      setHint(false);
      openBottle(pool);
      return;
    }
    /* 時化の漂着:汀線の帯に打ち上がった流木・レア色ガラス(24個上限とは別枠・常に採取可) */
    for (let i = S.stormItems.length - 1; i >= 0; i--) {
      const it = S.stormItems[i];
      if ((x - it.x) ** 2 + (y - it.y) ** 2 < 32 ** 2) {
        S.stormItems.splice(i, 1);
        S.bursts.push({ x: it.x, y: it.y, r: 6, a: 0.8 });
        const wu = washupsRef.current;
        if (wu) {
          const idx = wu.items.findIndex(r => r.seed === it.seed && r.id === it.id);
          if (idx >= 0) wu.items.splice(idx, 1);
          persistWashups();
        }
        const def = CATALOG.find(d => d.id === it.id);
        onCollect(it.id, it.seed, beach.id);
        setDiscovery({ ...def, seed: it.seed, count: entryCount(collection[it.id]) + 1 });
        setHint(false);
        return;
      }
    }
    /* 潮間帯の個体:干潮で汀線より浜側に露出しているものだけ拾える(24個上限とは別枠) */
    const waterline = S.H * (0.5 + (S.tideLevel ?? 0) * TIDE_RANGE);
    for (let i = S.tideItems.length - 1; i >= 0; i--) {
      const it = S.tideItems[i];
      if (it.y <= waterline + 10) continue;   // 水面下は採取不可(潮が満ちれば再び覆われる)
      if ((x - it.x) ** 2 + (y - it.y) ** 2 < 30 ** 2) {
        S.tideItems.splice(i, 1);
        S.bursts.push({ x: it.x, y: it.y, r: 6, a: 0.8 });
        const pool = tidePoolRef.current;
        if (pool) {
          const idx = pool.items.findIndex(r => r.seed === it.seed && r.id === it.id);
          if (idx >= 0) pool.items.splice(idx, 1);
          persistTidePool();
        }
        const def = CATALOG.find(d => d.id === it.id);
        onCollect(it.id, it.seed, beach.id);
        setDiscovery({ ...def, seed: it.seed, count: entryCount(collection[it.id]) + 1 });
        setHint(false);
        return;
      }
    }
    for (let i = S.items.length - 1; i >= 0; i--) {
      const it = S.items[i];
      if ((x - it.x) ** 2 + (y - it.y) ** 2 < 30 ** 2) {
        S.items.splice(i, 1);
        S.bursts.push({ x: it.x, y: it.y, r: 6, a: 0.8 });
        /* 渚の記録からも取り除く(拾ったものは戻らない) */
        const shore = shoreRef.current;
        if (shore) {
          const idx = shore.items.findIndex(r => r.seed === it.seed && r.id === it.id);
          if (idx >= 0) shore.items.splice(idx, 1);
          persistShore();
        }
        setOnShore(S.items.length);
        const def = CATALOG.find(d => d.id === it.id);
        onCollect(it.id, it.seed, beach.id);
        setDiscovery({ ...def, seed: it.seed, count: entryCount(collection[it.id]) + 1 });
        setHint(false);
        return;
      }
    }
  };

  const uiPanel = {
    background: "rgba(252,250,244,0.88)", backdropFilter: "blur(6px)",
    border: "1px solid rgba(51,65,63,0.16)", borderRadius: 4, color: "#33413f",
  };
  const foundCount = Object.keys(collection).length;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <canvas
        ref={canvasRef}
        onClick={onTapPick}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "pointer", touchAction: "manipulation" }}
      />

      {/* ---- 上部:海岸名と天気 ---- */}
      <div style={{ position: "absolute", top: 14, left: 14, right: 14, display: "flex", justifyContent: "space-between", alignItems: "flex-start", pointerEvents: "none" }}>
        <div style={{ ...uiPanel, padding: "10px 16px", pointerEvents: "auto" }}>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "0.14em" }}>{beach.name}</div>
          <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 3, letterSpacing: "0.05em" }}>
            {weather
              ? <>{weather.label} ・ {weather.temp}℃ ・ 風 {weather.wind}km/h
                {weather.source === "live" ? " ・ 実況" : " ・ 体験"}</>
              : "空模様をたずねています…"}
          </div>
          {isBonus(weather) && (
            <div style={{ fontSize: 11, marginTop: 4, color: "#4c7a6d", letterSpacing: "0.05em" }}>
              海が荒れています — シーグラスが多く打ち上がるかも
            </div>
          )}
        </div>
        <button onClick={onLeave} style={{ ...uiPanel, padding: "8px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.1em", pointerEvents: "auto" }}>
          海岸を変える
        </button>
      </div>

      {/* ---- ヒント ---- */}
      {hint && onShore > 0 && (
        <div style={{
          position: "absolute", bottom: "26%", left: 0, right: 0, textAlign: "center",
          fontSize: 13.5, letterSpacing: "0.2em", color: "rgba(60,60,50,0.75)",
          textShadow: "0 1px 4px rgba(255,255,255,0.7)", pointerEvents: "none",
          animation: "sg-fade 3s ease-in-out infinite alternate",
        }}>
          砂浜のものに、触れてみましょう
        </div>
      )}
      {onShore === 0 && (
        <div style={{
          position: "absolute", bottom: "26%", left: 0, right: 0, textAlign: "center",
          fontSize: 13.5, letterSpacing: "0.2em", color: "rgba(60,60,50,0.7)",
          textShadow: "0 1px 4px rgba(255,255,255,0.7)", pointerEvents: "none", lineHeight: 2,
        }}>
          潮が静かです。<br />
          <span style={{ fontSize: 11.5, opacity: 0.8 }}>時をおいて訪れると、新しい贈りものが届きます</span>
        </div>
      )}

      {/* ---- 下部:図鑑と空模様 ---- */}
      <div style={{ position: "absolute", bottom: 14, left: 14, right: 14, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div style={{ ...uiPanel, padding: "7px 10px", display: "flex", gap: 6, alignItems: "center", opacity: 0.85 }}>
          <span style={{ fontSize: 10.5, opacity: 0.6, letterSpacing: "0.1em", marginRight: 2 }}>空模様を試す</span>
          {Object.entries(WEATHER_KINDS).map(([k, v]) => (
            <button key={k} onClick={() => setDemoWeather(k)}
              style={{
                fontFamily: "inherit", fontSize: 12, cursor: "pointer", padding: "3px 8px",
                border: "1px solid rgba(51,65,63,0.25)", borderRadius: 3,
                background: weather?.kind === k ? "#33413f" : "transparent",
                color: weather?.kind === k ? "#f6f3ea" : "#33413f",
              }}>{v.label}</button>
          ))}
        </div>
        <button onClick={() => setShowBook(true)}
          style={{ ...uiPanel, padding: "10px 18px", fontSize: 13.5, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.15em" }}>
          図鑑 <span style={{ fontSize: 11, opacity: 0.6 }}>{foundCount}/{CATALOG.length}</span>
        </button>
      </div>

      {/* ---- 発見モーダル ---- */}
      {discovery && (
        <div onClick={() => setDiscovery(null)} style={{
          position: "absolute", inset: 0, background: "rgba(30,42,44,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            ...uiPanel, background: "rgba(253,251,246,0.97)", width: 300, padding: "28px 26px 22px",
            textAlign: "center", animation: "sg-rise .45s cubic-bezier(.2,.8,.3,1)",
          }}>
            <div style={{ fontSize: 11, letterSpacing: "0.4em", opacity: 0.55 }}>み つ け た</div>
            <div style={{ margin: "14px auto 6px", width: 140, height: 140, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ItemThumb id={discovery.id} seed={discovery.seed} size={140} scale={5} />
            </div>
            <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "0.12em" }}>{discovery.name}</div>
            <div style={{ fontSize: 12, margin: "8px 0 2px", color: "#8a7a55", letterSpacing: "0.3em" }}>
              {"●".repeat(discovery.rarity)}{"○".repeat(5 - discovery.rarity)}
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.9, opacity: 0.78, margin: "12px 0 4px" }}>{discovery.poem}</p>
            <div style={{ fontSize: 11.5, opacity: 0.55 }}>これで {discovery.count} 個目</div>
            <button onClick={() => setDiscovery(null)} style={{
              marginTop: 16, fontFamily: "inherit", fontSize: 13, letterSpacing: "0.2em",
              padding: "9px 26px", cursor: "pointer", background: "#33413f", color: "#f6f3ea",
              border: "none", borderRadius: 3,
            }}>浜へ戻る</button>
          </div>
        </div>
      )}

      {/* ---- 小瓶の断片モーダル(静かに、ひとつ) ---- */}
      {fragment && (
        <div onClick={() => setFragment(null)} style={{
          position: "absolute", inset: 0, background: "rgba(30,42,44,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 6,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            ...uiPanel, background: "rgba(253,251,246,0.98)", width: 320, padding: "30px 28px 22px",
            textAlign: "center", animation: "sg-rise .55s cubic-bezier(.2,.8,.3,1)",
          }}>
            <div style={{ fontSize: 11, letterSpacing: "0.4em", opacity: 0.5 }}>
              {fragment.pool === "core" ? "核 心 の 断 片" : "日 常 の 断 片"}
            </div>
            <div style={{ fontSize: 11.5, opacity: 0.5, marginTop: 10, letterSpacing: "0.1em" }}>
              小瓶がひとつ、流れ着いていた
            </div>
            <div style={{ width: 34, height: 1, background: "#33413f33", margin: "20px auto" }} />
            <p style={{ fontSize: 15, lineHeight: 2.1, opacity: 0.85, margin: "0 0 8px", letterSpacing: "0.04em" }}>
              {fragment.text}
            </p>
            <div style={{ width: 34, height: 1, background: "#33413f33", margin: "20px auto 14px" }} />
            <div style={{ fontSize: 11, opacity: 0.5, letterSpacing: "0.1em" }}>
              図書室に、断片がひとつ加わった
            </div>
            {fragment.storyJustComplete && (
              <div style={{ fontSize: 12, marginTop: 10, color: "#8a6a55", letterSpacing: "0.14em", lineHeight: 1.9 }}>
                すべての断片が、そろった。<br />図書室で通しで読めます。
              </div>
            )}
            <button onClick={() => setFragment(null)} style={{
              marginTop: 18, fontFamily: "inherit", fontSize: 13, letterSpacing: "0.2em",
              padding: "9px 26px", cursor: "pointer", background: "#33413f", color: "#f6f3ea",
              border: "none", borderRadius: 3,
            }}>そっと しまう</button>
          </div>
        </div>
      )}

      {/* ---- 図鑑 ---- */}
      {showBook && (
        <div style={{
          position: "absolute", inset: 0, background: "rgba(246,243,234,0.97)",
          overflowY: "auto", padding: "28px 20px 40px",
        }}>
          <div style={{ maxWidth: 620, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "0.25em" }}>
                {bookTab === "catalog" ? "図鑑" : bookTab === "shelf" ? "棚" : "断片"}
              </h2>
              <button onClick={() => setShowBook(false)} style={{ ...uiPanel, padding: "7px 16px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.15em" }}>
                浜へ戻る
              </button>
            </div>

            {/* タブ */}
            <div style={{ display: "flex", gap: 22, borderBottom: "1px solid rgba(51,65,63,0.2)", marginBottom: 20 }}>
              {[["catalog", `図鑑 ${foundCount}/${CATALOG.length}`], ["shelf", `棚 ${finds.length}`],
                ...(bottles?.collected?.length ? [["fragment", `断片 ${bottles.collected.length}/15`]] : [])].map(([k, label]) => (
                <button key={k} onClick={() => setBookTab(k)} style={{
                  fontFamily: "inherit", fontSize: 14, letterSpacing: "0.15em", cursor: "pointer",
                  background: "none", border: "none", padding: "0 0 10px", color: "#33413f",
                  opacity: bookTab === k ? 1 : 0.4, fontWeight: bookTab === k ? 600 : 500,
                  borderBottom: bookTab === k ? "2px solid #33413f" : "2px solid transparent",
                  marginBottom: -1,
                }}>{label}</button>
              ))}
            </div>

            {bookTab === "catalog" && CAT_ORDER.map(cat => (
              <div key={cat} style={{ marginBottom: 26 }}>
                <div style={{ fontSize: 13, letterSpacing: "0.3em", opacity: 0.6, borderBottom: "1px solid rgba(51,65,63,0.2)", paddingBottom: 6, marginBottom: 12 }}>
                  {cat}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10 }}>
                  {CATALOG.filter(d => d.cat === cat).map(d => {
                    const entry = collection[d.id];
                    const n = entryCount(entry);
                    return (
                      <div key={d.id} style={{
                        border: "1px solid rgba(51,65,63,0.15)", borderRadius: 4,
                        background: n ? "rgba(255,253,247,0.85)" : "rgba(220,216,205,0.4)",
                        padding: "12px 10px", textAlign: "center",
                      }}>
                        <div style={{ height: 58, display: "flex", alignItems: "center", justifyContent: "center", filter: n ? "none" : "grayscale(1) opacity(0.25)" }}>
                          <ItemThumb id={d.id} seed={entrySeed(entry)} size={58} scale={2.1} />
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.06em", marginTop: 6 }}>
                          {n ? d.name : "？？？"}
                        </div>
                        <div style={{ fontSize: 10.5, color: "#8a7a55", letterSpacing: "0.2em", marginTop: 3 }}>
                          {"●".repeat(d.rarity)}{"○".repeat(5 - d.rarity)}
                        </div>
                        <div style={{ fontSize: 10.5, opacity: 0.55, marginTop: 3 }}>{n ? `${n} 個` : "未発見"}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {bookTab === "shelf" && (
              finds.length === 0 ? (
                <div style={{ textAlign: "center", opacity: 0.5, fontSize: 13, letterSpacing: "0.1em", padding: "48px 0", lineHeight: 2 }}>
                  まだ棚は空っぽです。<br />浜辺で拾ったものが、新しい順にここへ並びます。
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 14, letterSpacing: "0.08em" }}>
                    拾った {finds.length} 個 ── 新しいものから
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(72px,1fr))", gap: 4 }}>
                    {finds.slice().reverse().map((f, i) => (
                      <button key={finds.length - i} onClick={() => setShelfPick(f)} title={CATALOG.find(d => d.id === f.id)?.name}
                        style={{
                          border: "none", background: "transparent", cursor: "pointer", padding: 4,
                          borderRadius: 3, transition: "background .15s",
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(51,65,63,0.06)"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                      >
                        <ItemThumb id={f.id} seed={f.seed} size={64} scale={2.3} />
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}

            {bookTab === "fragment" && (() => {
              const got = new Set((bottles?.collected || []).map(c => c.id));
              const fragCard = (f, pool) => {
                const has = got.has(f.id);
                return (
                  <div key={f.id} style={{
                    border: "1px solid rgba(51,65,63,0.15)", borderRadius: 4,
                    background: has ? "rgba(255,253,247,0.85)" : "rgba(220,216,205,0.32)",
                    padding: "14px 16px", minHeight: 44, display: "flex", alignItems: "center",
                  }}>
                    {has
                      ? <p style={{ margin: 0, fontSize: 13.5, lineHeight: 2, opacity: 0.82, letterSpacing: "0.03em" }}>{f.text}</p>
                      : <span style={{ fontSize: 12, opacity: 0.4, letterSpacing: "0.3em" }}>── まだ 届いていない ──</span>}
                  </div>
                );
              };
              const layer = (pool, title, note) => (
                <div style={{ marginBottom: 26 }}>
                  <div style={{ fontSize: 13, letterSpacing: "0.3em", opacity: 0.6, borderBottom: "1px solid rgba(51,65,63,0.2)", paddingBottom: 6, marginBottom: 6 }}>{title}</div>
                  <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 12, letterSpacing: "0.06em" }}>{note}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {BOTTLE_MESSAGES[pool].map(f => fragCard(f, pool))}
                  </div>
                </div>
              );
              const whole = [
                ...BOTTLE_MESSAGES.surface.map(f => ({ ...f, pool: "surface" })),
                ...BOTTLE_MESSAGES.core.map(f => ({ ...f, pool: "core" })),
              ].sort((a, b) => a.order - b.order);
              return (
                <div>
                  <div style={{ fontSize: 12.5, opacity: 0.62, lineHeight: 2, marginBottom: 20, letterSpacing: "0.04em" }}>
                    集めた硝子のお礼のように、小瓶がひとつ流れ着きます。<br />
                    日常と核心、両方の断片がそろうと、一篇として通しで読めます。
                  </div>
                  {layer("surface", "日常の断片", "通常色の硝子を集めると届く")}
                  {layer("core", "核心の断片", "赤 ── この渚でいちばん稀な色を集めると届く")}
                  {bottles?.storyComplete && (
                    <div style={{ marginTop: 10, border: "1px solid rgba(51,65,63,0.25)", borderRadius: 4, background: "rgba(252,250,244,0.7)", padding: "22px 22px 26px" }}>
                      <div style={{ fontSize: 13, letterSpacing: "0.4em", opacity: 0.6, textAlign: "center", marginBottom: 18 }}>全 容</div>
                      <div style={{ maxWidth: 460, margin: "0 auto" }}>
                        {whole.map(f => (
                          <div key={f.id} style={{
                            fontSize: 14, lineHeight: 2.2, letterSpacing: "0.04em", opacity: 0.85,
                            paddingLeft: f.pool === "core" ? 22 : 0,
                            color: f.pool === "core" ? "#5c4a44" : "#33413f",
                          }}>{f.text}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ---- 棚の個体を拡大 ---- */}
      {shelfPick && (() => {
        const def = CATALOG.find(d => d.id === shelfPick.id);
        const beachLabel = beachNames?.[shelfPick.beachId] || BEACHES.find(b => b.id === shelfPick.beachId)?.name || "どこかの浜";
        const d = new Date(shelfPick.time);
        const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
        return (
          <div onClick={() => setShelfPick(null)} style={{
            position: "absolute", inset: 0, background: "rgba(30,42,44,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 5,
          }}>
            <div onClick={e => e.stopPropagation()} style={{
              ...uiPanel, background: "rgba(253,251,246,0.97)", width: 290, padding: "26px 24px 20px",
              textAlign: "center", animation: "sg-rise .4s cubic-bezier(.2,.8,.3,1)",
            }}>
              <div style={{ margin: "4px auto 6px", width: 130, height: 130, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <ItemThumb id={shelfPick.id} seed={shelfPick.seed} size={130} scale={4.6} />
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "0.12em" }}>{def?.name}</div>
              <div style={{ fontSize: 12, margin: "7px 0 2px", color: "#8a7a55", letterSpacing: "0.3em" }}>
                {"●".repeat(def?.rarity || 0)}{"○".repeat(5 - (def?.rarity || 0))}
              </div>
              <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 12, letterSpacing: "0.08em", lineHeight: 1.9 }}>
                {beachLabel} にて<br />{dateStr} に拾う
              </div>
              <button onClick={() => setShelfPick(null)} style={{
                marginTop: 16, fontFamily: "inherit", fontSize: 12.5, letterSpacing: "0.2em",
                padding: "8px 24px", cursor: "pointer", background: "#33413f", color: "#f6f3ea",
                border: "none", borderRadius: 3,
              }}>閉じる</button>
            </div>
          </div>
        );
      })()}

      <style>{`
        @keyframes sg-fade { from { opacity:.35 } to { opacity:.9 } }
        @keyframes sg-rise { from { transform:translateY(24px); opacity:0 } to { transform:none; opacity:1 } }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: .01s !important; }
        }
      `}</style>
    </div>
  );
}
