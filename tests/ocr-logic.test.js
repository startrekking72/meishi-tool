// 名刺管理ツール（index.html）の読み取りロジックを、修正前と修正後で見比べるテスト。
//
//   node tests/ocr-logic.test.js            … 修正前（下の BASE_REF のコミット）と、いまの index.html を比べる
//   node tests/ocr-logic.test.js <コミット>  … 比べる相手のコミットを指定する
//
// index.html の中のスクリプトを、画面の代わりになる簡単な部品（偽のDOM）の上でそのまま動かす。
// 実際の写真の文字認識（Tesseract）は動かさず、「読み取れた行」を入力にして、その先の処理を確かめる。
// 種類: keep＝修正前と同じ結果でなければならない / improve＝修正後が期待どおりでなければならない
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE_REF = process.argv[2] || '48b7e94';
const STORAGE_KEY = 'dejiina_meishi_tool_v1';

function makeEnv(html, stored) {
  const m = /<script>\s*([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('index.html のスクリプトが見つかりません');
  // スクリプトの中の関数を外から呼べるよう、最後に取り出し口を足す（index.html 自体は書き換えない）
  const src = m[1].replace('window.meishiDebug =', 'window.__eval = function (s) { return eval(s); };\n  window.meishiDebug =');
  const els = {};
  const store = Object.assign({}, stored || {});
  const env = { alerts: [], blobs: [], store: store, els: els };
  function makeEl(id) {
    const el = {
      id: id, value: '', innerHTML: '', textContent: '', checked: false, disabled: false, style: {}, _h: {}, _attr: {},
      classList: {
        _s: new Set(),
        add: function () { for (const x of arguments) this._s.add(x); },
        remove: function () { for (const x of arguments) this._s.delete(x); },
        contains: function (x) { return this._s.has(x); }
      },
      addEventListener: function (type, fn) { (el._h[type] = el._h[type] || []).push(fn); },
      querySelectorAll: function () { return []; },
      getAttribute: function (k) { return k in el._attr ? el._attr[k] : null; },
      setAttribute: function (k, v) { el._attr[k] = v; },
      removeAttribute: function (k) { delete el._attr[k]; },
      closest: function () { return null; },
      appendChild: function () {}, removeChild: function () {}, remove: function () {},
      focus: function () {}, select: function () {}, setSelectionRange: function () {}, click: function () {},
      getContext: function () { return {}; }
    };
    return el;
  }
  const document = {
    getElementById: function (id) { return els[id] || (els[id] = makeEl(id)); },
    createElement: function (tag) { return makeEl('<' + tag + '>'); },
    head: makeEl('head'), body: makeEl('body'), execCommand: function () { return true; }
  };
  // 画面の初期状態でチェックが入っている項目
  ['ocrMergeSimilar', 'ocrHideUsed'].forEach(function (id) { document.getElementById(id).checked = true; });
  class FakeBlob { constructor(parts, opt) { this.text = parts.join(''); this.type = (opt || {}).type; env.blobs.push(this); } }
  class FakeURL extends URL { static createObjectURL() { return 'blob:test'; } static revokeObjectURL() {} }
  class FakeReader {
    readAsText(file) { const self = this; setTimeout(function () { self.onload({ target: { result: file._text } }); }, 0); }
  }
  const context = {
    document: document,
    localStorage: {
      getItem: function (k) { return k in store ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    navigator: { userAgent: 'node-test', platform: 'test', maxTouchPoints: 0 },
    location: { href: 'https://example.test/meishi-tool/', origin: 'https://example.test', pathname: '/meishi-tool/' },
    alert: function (msg) { env.alerts.push(msg); },
    confirm: function () { return true; },
    URL: FakeURL, Blob: FakeBlob, FileReader: FakeReader,
    Image: function () {}, console: { error: function () {}, log: function () {} },
    setTimeout: setTimeout, scrollTo: function () {}, innerHeight: 800
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(src, context, { filename: 'index.html<script>' });
  env.ev = function (code) { return context.__eval(code); };
  env.has = function (name) { return context.__eval('typeof ' + name) === 'function'; };
  env.el = document.getElementById;
  env.fire = function (id, type, event) { (els[id]._h[type] || []).forEach(function (fn) { fn(event || { target: els[id] }); }); };
  return env;
}

function tick() { return new Promise(function (resolve) { setTimeout(resolve, 5); }); }
function plain(v) { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }

// ---- 修正前のコードにない関数は、修正前の readCard / showOcrLines がしていたことをそのままなぞる ----
function decide(env, f, readings) {
  if (env.has('decideField')) return plain(env.ev('decideField')(f, readings));
  return plain(env.ev('voteReadings')(readings, f === 'email'));
}
function vote(env, f, values) {
  const sources = ['sharp', 'soft', 'bold'];
  return decide(env, f, values.map(function (v, i) { return { value: v, source: sources[i] }; }));
}
function combine(env, passItems, rereads) {
  const parseCardLines = env.ev('parseCardLines');
  const parses = passItems.map(function (items) { return parseCardLines(items); });
  if (env.has('combinePasses')) return plain(env.ev('combinePasses')(parses, rereads || [], 0));
  const voteReadings = env.ev('voteReadings');
  const sources = ['sharp', 'soft', 'bold'];
  const result = { candidates: {}, quarter: 0, lines: [] };
  env.ev('OCR_FIELDS').forEach(function (f) {
    const readings = parses.map(function (p, i) { return { value: p[f], source: sources[i] }; });
    if (f === 'email') (rereads || []).forEach(function (email, i) { readings.push({ value: email, source: sources[i] }); });
    const decided = voteReadings(readings, f === 'email');
    result[f] = decided.value;
    if (decided.candidates.length) result.candidates[f] = decided.candidates;
  });
  parses.forEach(function (p) {
    p.lines.forEach(function (line) {
      const key = line.replace(/\s+/g, '');
      if (!result.lines.some(function (l) { return l.replace(/\s+/g, '') === key; })) result.lines.push(line);
    });
  });
  return plain(result);
}
// 画面の「読み取った行」に実際に並ぶ行
function shownLines(env, passes, values, options) {
  const lines = [];
  passes.forEach(function (pass) {
    pass.forEach(function (line) {
      const key = line.replace(/\s+/g, '');
      if (!lines.some(function (l) { return l.replace(/\s+/g, '') === key; })) lines.push(line);
    });
  });
  Object.keys(values || {}).forEach(function (f) { env.el('f_' + f).value = values[f]; });
  if (options) {
    env.el('ocrMergeSimilar').checked = options.merge;
    env.el('ocrHideUsed').checked = options.hideUsed;
  }
  env.ev('showOcrLines')(lines, passes);
  return plain(env.el('ocrLines')._lines);
}
function line(text, h, conf) { return { text: text, conf: conf == null ? 90 : conf, h: h == null ? 20 : h }; }
function scrub(text) {
  return String(text).replace(/c_\d+_[a-z0-9]+/g, '<id>').replace(/"(createdAt|updatedAt)": ?\d+/g, '"$1": <time>')
    .replace(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}(:\d{2})?/g, '<time>').replace(/meishi_\d{8}_\d{4}/g, 'meishi_<stamp>');
}

const BODY = [line('東京都千代田区千代田1-2-3', 20), line('TEL 03-1234-5678', 20), line('info@example.com', 20)];
const SAMPLE_CARDS = {
  '標準的な名刺': '株式会社サンプル商事\n営業部 部長\n山田 太郎\n〒100-0001 東京都千代田区千代田1-2-3 サンプルビル5F\nTEL 03-1234-5678 FAX 03-1234-5679\n携帯 090-1111-2222\nE-mail: yamada@sample.co.jp\nhttps://www.sample.co.jp',
  '役職と氏名が同じ行': '有限会社アークリー\n代表取締役 西川 尚\n大阪府大阪市北区梅田1-1-1\nTEL: 06-1234-5678\narcly@example.com',
  '屋号だけの名刺': '山田法律事務所\n弁護士\n山田 花子\n〒530-0001\n大阪府大阪市北区梅田2-3-4\n電話 06(1111)2222',
  '後株の名刺': 'サンプル工業株式会社\n技術部\n主任 鈴木 一郎\n愛知県名古屋市中区栄3-4-5\nTEL 052-123-4567\nMobile 080-3333-4444\nsuzuki@sample-kogyo.co.jp',
  '読み取りが崩れた名刺': '山 田 太 郎\n| ー ・\n株 式 会 社 テ ス ト\nTEL O3-1234-5678\n東京都港区'
};
const LEGACY_CARDS = [
  { id: 'c_1_old', name: '旧 太郎', company: '旧データ株式会社', department: '', title: '部長', phone: '090-9999-8888', email: 'old@example.com', metDate: '2026-09-01', eventName: '交流会A', memo: '分離前に保存した名刺', photo: '', createdAt: 1, updatedAt: 1 },
  { id: 'c_2_new', name: '新 花子', company: '新データ合同会社', department: '営業部', title: '', phone: '03-1111-2222', mobile: '080-1111-2222', email: 'new@example.com', address: '〒100-0001 東京都千代田区千代田1-1', metDate: '2026-10-01', eventName: '交流会B', memo: '', photo: 'data:image/jpeg;base64,AAAA', photoOriginal: '', mailTo: '', mailSubject: '', mailBody: '', mailOpenedAt: 0, createdAt: 2, updatedAt: 2 }
];

const CASES = [
  // ---- 1. 氏名候補 ----
  { group: '1 氏名候補', name: '氏名らしい行が2つあり大きさが近い → 候補として両方を出す', type: 'improve',
    run: function (env) {
      const items = [line('山田 太郎', 40), line('不老 長寿', 38)].concat(BODY);
      const r = combine(env, [items, items, items]);
      return { name: r.name, 候補: r.candidates.name || [] };
    },
    expect: { name: '', 候補: ['山田 太郎', '不老 長寿'] } },
  { group: '1 氏名候補', name: '大きさで1つに決まり、3回とも同じ → 自動入力のまま（候補は出さない）', type: 'keep',
    run: function (env) {
      const items = [line('山田 太郎', 48), line('不老 長寿', 22)].concat(BODY);
      const r = combine(env, [items, items, items]);
      return { name: r.name, 候補: r.candidates.name || [] };
    },
    expect: { name: '山田 太郎', 候補: [] } },
  { group: '1 氏名候補', name: '読み方が分かれた氏名 → 多く読めた方を先に、ほかの氏名らしい行も後ろに出す', type: 'improve',
    run: function (env) {
      const a = [line('山田 太郎', 48), line('不老 長寿', 22)].concat(BODY);
      const b = [line('山田 大郎', 48), line('不老 長寿', 22)].concat(BODY);
      const r = combine(env, [a, b, a]);
      return { name: r.name, 候補: r.candidates.name || [] };
    },
    expect: { name: '', 候補: ['山田 太郎', '山田 大郎', '不老 長寿'] } },
  { group: '1 氏名候補', name: '氏名らしい行がない → 候補なし', type: 'keep',
    run: function (env) { const r = combine(env, [BODY, BODY, BODY]); return { name: r.name, 候補: r.candidates.name || [] }; },
    expect: { name: '', 候補: [] } },

  // ---- 2. 電話番号 ----
  { group: '2 電話番号', name: 'ハイフンの有無だけの違い → 同じ番号として確定し、区切りのある書き方を残す', type: 'improve',
    run: function (env) { return vote(env, 'phone', ['0312345678', '03-1234-5678', '03-1234-5678']); },
    expect: { value: '03-1234-5678', candidates: [] } },
  { group: '2 電話番号', name: '3回とも区切りなし → 読めたままで確定（区切り位置は作らない）', type: 'keep',
    run: function (env) { return vote(env, 'phone', ['0312345678', '0312345678', '0312345678']); },
    expect: { value: '0312345678', candidates: [] } },
  { group: '2 電話番号', name: '数字が1つ違う番号 → まとめずに候補にする', type: 'keep',
    run: function (env) { return vote(env, 'phone', ['03-1234-5678', '03-1234-5679', '03-1234-5678']); },
    expect: { value: '', candidates: ['03-1234-5678', '03-1234-5679'] } },
  { group: '2 電話番号', name: '携帯：+81 の書き方と 090 の書き方 → 同じ番号', type: 'improve',
    run: function (env) { return vote(env, 'mobile', ['090-1111-2222', '+81-90-1111-2222', '09011112222']); },
    expect: { value: '090-1111-2222', candidates: [] } },
  { group: '2 電話番号', name: '1回しか読めなかった番号 → 確定しない（従来どおり）', type: 'keep',
    run: function (env) { return vote(env, 'phone', ['03-1234-5678', '', '']); },
    expect: { value: '', candidates: ['03-1234-5678'] } },
  { group: '2 電話番号', name: '行から番号を取り出す処理（固定・携帯・FAXの振り分け）は変えていない', type: 'keep',
    run: function (env) {
      const f = env.ev('extractPhones');
      return plain([f(['TEL 03-1234-5678 FAX 03-1234-5679', '携帯 090-1111-2222']), f(['TEL 03(1234)5678']), f(['Mobile +81 90 1111 2222'])]);
    } },

  // ---- 3. 住所 ----
  { group: '3 住所', name: '郵便番号・建物名の有無だけの違い → 2回以上読めた部分を確定し、建物名つきは候補に出す', type: 'improve',
    run: function (env) { return vote(env, 'address', ['〒100-0001 東京都千代田区千代田1-1', '東京都千代田区千代田1-1', '〒100-0001 東京都千代田区千代田1-1 ABCビル']); },
    expect: { value: '〒100-0001 東京都千代田区千代田1-1', candidates: ['〒100-0001 東京都千代田区千代田1-1 ABCビル'] } },
  { group: '3 住所', name: '建物名つきが2回読めた → 建物名まで確定', type: 'improve',
    run: function (env) { return vote(env, 'address', ['東京都千代田区千代田1-1 ABCビル5F', '東京都千代田区千代田1-1', '東京都千代田区千代田1-1 ABCビル5F']); },
    expect: { value: '東京都千代田区千代田1-1 ABCビル5F', candidates: [] } },
  { group: '3 住所', name: '郵便番号が1回しか読めなかった → 郵便番号なしで確定し、郵便番号つきは候補に出す', type: 'improve',
    run: function (env) { return vote(env, 'address', ['〒100-0001 東京都千代田区千代田1-1', '東京都千代田区千代田1-1', '東京都千代田区千代田1-1']); },
    expect: { value: '東京都千代田区千代田1-1', candidates: ['〒100-0001 東京都千代田区千代田1-1'] } },
  { group: '3 住所', name: '番地が違う（1-2 と 1-2-3）→ 別の住所かもしれないので、まとめない', type: 'keep',
    run: function (env) { return vote(env, 'address', ['東京都千代田区千代田1-2', '東京都千代田区千代田1-2-3', '東京都千代田区千代田1-2']); },
    expect: { value: '', candidates: ['東京都千代田区千代田1-2', '東京都千代田区千代田1-2-3'] } },
  { group: '3 住所', name: '番地が違う（1-1 と 1-10）→ まとめない', type: 'keep',
    run: function (env) { return vote(env, 'address', ['東京都千代田区千代田1-1', '東京都千代田区千代田1-10', '東京都千代田区千代田1-10']); },
    expect: { value: '', candidates: ['東京都千代田区千代田1-10', '東京都千代田区千代田1-1'] } },
  { group: '3 住所', name: '丁目の先が欠けた読み（1 と 1丁目2-3）→ まとめない', type: 'keep',
    run: function (env) { return vote(env, 'address', ['東京都千代田区千代田1', '東京都千代田区千代田1丁目2-3', '東京都千代田区千代田1']).value; },
    expect: '' },
  { group: '3 住所', name: '建物名が食い違う → まとめずに、それぞれを候補にする', type: 'improve',
    run: function (env) { return vote(env, 'address', ['東京都千代田区千代田1-1 山田ビル', '東京都千代田区千代田1-1 佐藤ビル', '東京都千代田区千代田1-1']); },
    expect: { value: '', candidates: ['東京都千代田区千代田1-1 山田ビル', '東京都千代田区千代田1-1 佐藤ビル'] } },
  { group: '3 住所', name: '郵便番号の読みが食い違う → 確定しない（従来どおり）', type: 'keep',
    run: function (env) { return vote(env, 'address', ['〒100-0001 東京都千代田区千代田1-1', '〒100-0007 東京都千代田区千代田1-1', '〒100-0001 東京都千代田区千代田1-1']); },
    expect: { value: '', candidates: ['〒100-0001 東京都千代田区千代田1-1', '〒100-0007 東京都千代田区千代田1-1'] } },
  { group: '3 住所', name: 'まったく別の住所（本社と支店）→ まとめない', type: 'keep',
    run: function (env) { return vote(env, 'address', ['東京都千代田区千代田1-1', '大阪府大阪市北区梅田2-2', '東京都千代田区千代田1-1']); },
    expect: { value: '', candidates: ['東京都千代田区千代田1-1', '大阪府大阪市北区梅田2-2'] } },
  { group: '3 住所', name: '3回とも同じ → 確定（従来どおり）', type: 'keep',
    run: function (env) { return vote(env, 'address', ['〒100-0001 東京都千代田区千代田1-1', '〒100-0001 東京都千代田区千代田1-1', '〒100-0001 東京都千代田区千代田1-1']); },
    expect: { value: '〒100-0001 東京都千代田区千代田1-1', candidates: [] } },
  { group: '3 住所', name: '1回しか読めなかった → 確定しない（従来どおり）', type: 'keep',
    run: function (env) { return vote(env, 'address', ['', '東京都千代田区千代田1-1 ABCビル', '']); },
    expect: { value: '', candidates: ['東京都千代田区千代田1-1 ABCビル'] } },

  // ---- 4. 読み取った行の一覧 ----
  { group: '4 行一覧', name: '空白や記号だけの違い・1文字の読み違い・端が欠けた行 → 1行にまとめる', type: 'improve',
    run: function (env) {
      return shownLines(env, [
        ['株式会社サンプル商事', '営業部 部長', 'TEL 03-1234-5678', '長寿社会への取り組み'],
        ['株式会社サンプル商亊', '営業部・部長', 'TEL 03-1234-5678', '長寿社会への取り組'],
        ['株式会社サンプル商事', '営業部 部長', 'TEL:03-1234-5678', '長寿社会への取り組み']
      ], {});
    },
    expect: ['株式会社サンプル商事', '営業部 部長', 'TEL 03-1234-5678', '長寿社会への取り組み'] },
  { group: '4 行一覧', name: '数字が違う行（TELとFAX、別の番地）・メールの読み違い → まとめない', type: 'keep',
    run: function (env) {
      return shownLines(env, [
        ['TEL 03-1234-5678', 'FAX 03-1234-5679', '千代田区千代田1-2-3', 'info@example.com'],
        ['TEL 03-1234-5670', '千代田区千代田1-2-8', 'into@example.com'], []
      ], {});
    },
    expect: ['TEL 03-1234-5678', 'FAX 03-1234-5679', '千代田区千代田1-2-3', 'info@example.com', 'TEL 03-1234-5670', '千代田区千代田1-2-8', 'into@example.com'] },
  { group: '4 行一覧', name: '入力済みの項目に使った行 → 隠す（FAXなど未使用の行は残す）', type: 'improve',
    run: function (env) {
      return shownLines(env, [[
        '株式会社サンプル商事', '営業部 部長', '山田 太郎', '〒100-0001', '東京都千代田区千代田1-2-3', 'サンプルビル5F',
        'TEL 03-1234-5678 FAX 03-1234-5679', '携帯 090-1111-2222', 'E-mail: yamada@sample.co.jp', '長寿社会への取り組み'
      ]], { name: '山田 太郎', company: '株式会社サンプル商事', department: '営業部', title: '部長', phone: '03-1234-5678', mobile: '090-1111-2222',
        email: 'yamada@sample.co.jp', address: '〒100-0001 東京都千代田区千代田1-2-3 サンプルビル5F' });
    },
    expect: ['TEL 03-1234-5678 FAX 03-1234-5679', '長寿社会への取り組み'] },
  { group: '4 行一覧', name: '2つのチェックを外す → 修正前と同じ全行が出る（元の読み取り結果は残っている）', type: 'keep',
    run: function (env) {
      return shownLines(env, [
        ['株式会社サンプル商事', '山田 太郎', 'TEL 03-1234-5678'], ['株式会社サンプル商亊', '山田 太郎', 'TEL:03-1234-5678'], ['株式会社サンプル商事']
      ], { name: '山田 太郎' }, { merge: false, hideUsed: false });
    },
    expect: ['株式会社サンプル商事', '山田 太郎', 'TEL 03-1234-5678', '株式会社サンプル商亊', 'TEL:03-1234-5678'] },
  { group: '4 行一覧', name: '行を項目に割り当てるボタン → その項目に入り、行は一覧から消える', type: 'improve',
    run: function (env) {
      shownLines(env, [['株式会社サンプル商事', '山田 太郎', '長寿社会への取り組み']], {});
      const row = { getAttribute: function () { return '1'; } };
      env.fire('ocrLines', 'click', { target: { getAttribute: function (k) { return k === 'data-f' ? 'name' : null; }, closest: function () { return row; }, textContent: '氏名' } });
      return { 氏名欄: env.el('f_name').value, 残りの行: plain(env.el('ocrLines')._lines) };
    },
    expect: { 氏名欄: '山田 太郎', 残りの行: ['株式会社サンプル商事', '長寿社会への取り組み'] } },
  { group: '4 行一覧', name: '読み取り結果そのもの（lines）は修正前と同じ内容で残る', type: 'keep',
    run: function (env) {
      const a = [line('株式会社サンプル商事', 30), line('山田 太郎', 48)].concat(BODY);
      const b = [line('株式会社サンプル商亊', 30), line('山田 太郎', 48)].concat(BODY);
      return combine(env, [a, b, a]).lines;
    } },

  // ---- 5. 会社名・閉じ括弧 ----
  { group: '5 会社名', name: '後株で英字の社名「ABC 株式会社」', type: 'improve',
    run: function (env) { return env.ev('pickCompany')('ABC 株式会社'); }, expect: 'ABC 株式会社' },
  { group: '5 会社名', name: '後株で英字2語「ABC Works 株式会社」', type: 'improve',
    run: function (env) { return env.ev('pickCompany')('ABC Works 株式会社'); }, expect: 'ABC Works 株式会社' },
  { group: '5 会社名', name: '前株で英字2語「株式会社 ABC Works」', type: 'improve',
    run: function (env) { return env.ev('pickCompany')('株式会社 ABC Works'); }, expect: '株式会社 ABC Works' },
  { group: '5 会社名', name: '前株でつながった英字2語「株式会社ABC Works」', type: 'improve',
    run: function (env) { return env.ev('pickCompany')('株式会社ABC Works'); }, expect: '株式会社ABC Works' },
  { group: '5 会社名', name: '後ろに役職・見出しが続く「株式会社ABC CEO」「株式会社 ABC TEL」→ 社名だけ', type: 'keep',
    run: function (env) { const f = env.ev('pickCompany'); return [f('株式会社ABC CEO'), f('株式会社 ABC TEL')]; },
    expect: ['株式会社ABC', '株式会社 ABC'] },
  { group: '5 会社名', name: '法人格の後ろが電話番号「株式会社 03-1234-5678」→ 社名にしない', type: 'improve',
    run: function (env) { return env.ev('pickCompany')('株式会社 03-1234-5678'); }, expect: '' },
  { group: '5 会社名', name: '従来から読めていた形（前株・後株・前株+英字1語・法人格なし）は変えていない', type: 'keep',
    run: function (env) {
      const f = env.ev('pickCompany');
      return [f('株式会社サンプル商事'), f('サンプル工業株式会社'), f('株式会社 ABC'), f('ABC株式会社 営業部'), f('| 株式会社サンプル ・'), f('ARCLY Inc.'), f('株式会社')];
    },
    expect: ['株式会社サンプル商事', 'サンプル工業株式会社', '株式会社 ABC', 'ABC株式会社', '株式会社サンプル', 'ARCLY Inc.', ''] },
  { group: '5 閉じ括弧', name: '住所の「ビル(5階)」→ 閉じ括弧を残す', type: 'improve',
    run: function (env) { return env.ev('extractAddress')(['東京都千代田区千代田1-2-3 山田ビル(5階)']); },
    expect: '東京都千代田区千代田1-2-3 山田ビル(5階)' },
  { group: '5 閉じ括弧', name: '括弧の内側に空白が入って読まれた住所「ビル (5 階 )」→ 括弧の中まで残す', type: 'improve',
    run: function (env) { return env.ev('extractAddress')(['〒100-0001 東京都千代田区千代田 1-2-3 山田ビル (5 階 )']); },
    expect: '〒100-0001 東京都千代田区千代田1-2-3 山田ビル (5階)' },
  { group: '5 閉じ括弧', name: '括弧のない住所・番地だけの住所・郵便番号が前の行にある住所は変えていない', type: 'keep',
    run: function (env) {
      const f = env.ev('extractAddress');
      return [f(['〒100-0001 東京都千代田区千代田1-2-3 サンプルビル5F']), f(['東京都千代田区千代田1-2-3']), f(['〒530-0001', '大阪府大阪市北区梅田2-3-4 TEL 06-1111-2222']), f(['東京都港区'])];
    } },

  // ---- 既存機能が変わっていないこと ----
  { group: '既存機能', name: '名刺の文字から各項目を取り出す処理（見本5枚）', type: 'keep',
    run: function (env) {
      const out = {};
      // emailAlt（メールの別の読み）は後から足した項目。空のときは、修正前と見比べられるよう取り除く
      Object.keys(SAMPLE_CARDS).forEach(function (k) { out[k] = plain(env.ev('parseCardText')(SAMPLE_CARDS[k])); if (!out[k].emailAlt) delete out[k].emailAlt; });
      return out;
    } },
  { group: '既存機能', name: 'メールアドレスの突き合わせ（欠けた読みをまとめる・食い違いは候補）', type: 'keep',
    run: function (env) { return [vote(env, 'email', ['arcly4@gmail.com', 'cly4@gmail.com', 'arcly4@gmail.com']), vote(env, 'email', ['a@example.com', 'o@example.com', 'a@example.com'])]; },
    expect: [{ value: 'arcly4@gmail.com', candidates: [] }, { value: '', candidates: ['a@example.com', 'o@example.com'] }] },
  { group: '既存機能', name: '会社名・部署・役職の突き合わせ', type: 'keep',
    run: function (env) { return [vote(env, 'company', ['株式会社 ABC', '株式会社ABC', '株式会社ABC']), vote(env, 'title', ['部長', '部長', '郡長']), vote(env, 'department', ['営業部', '', '営業部'])]; } },
  { group: '既存機能', name: '保存済みの名刺（分離前の古い形を含む）を読み込んでも内容が変わらない', type: 'keep',
    run: async function (env) { await tick(); return { 件数: env.ev('cards').length, 中身: plain(env.ev('cards')), 保存領域: env.store[STORAGE_KEY] }; },
    stored: true },
  { group: '既存機能', name: '新規保存：phone・mobile を含む保存データの形', type: 'keep',
    run: async function (env) {
      await tick();
      const v = { name: '山田 太郎', company: '株式会社サンプル商事', department: '営業部', title: '部長', phone: '03-1234-5678', mobile: '090-1111-2222', email: 'yamada@sample.co.jp', address: '〒100-0001 東京都千代田区千代田1-2-3', metDate: '2026-10-09', eventName: '交流会C', memo: 'メモ' };
      Object.keys(v).forEach(function (f) { env.el('f_' + f).value = v[f]; });
      env.fire('saveBtn', 'click');
      await tick();
      return { 保存後の件数: env.ev('cards').length, 保存領域: scrub(JSON.stringify(JSON.parse(env.store[STORAGE_KEY]), null, 1)), 警告: env.alerts };
    },
    stored: true },
  { group: '既存機能', name: 'CSV書き出しの内容', type: 'keep',
    run: async function (env) { await tick(); env.fire('exportCsvBtn', 'click'); return scrub(env.blobs.map(function (b) { return b.type + '\n' + b.text; }).join('\n')); },
    stored: true },
  { group: '既存機能', name: 'JSON書き出しの内容', type: 'keep',
    run: async function (env) { await tick(); env.fire('exportBtn', 'click'); return env.blobs.map(function (b) { return b.type + '\n' + b.text; }).join('\n'); },
    stored: true },
  { group: '既存機能', name: 'JSON読み込み（古い形のデータも追加され、既存の名刺は残る）', type: 'keep',
    run: async function (env) {
      await tick();
      const input = env.el('importInput');
      input.files = [{ _text: JSON.stringify([{ name: '読込 次郎', phone: '06-1111-2222', company: '読込株式会社' }, LEGACY_CARDS[1]]) }];
      env.fire('importInput', 'change');
      await tick(); await tick();
      return scrub(JSON.stringify(JSON.parse(env.store[STORAGE_KEY]), null, 1));
    },
    stored: true },
  { group: '既存機能', name: 'お礼メールの文面（{phone}{mobile} などの差し込み）', type: 'keep',
    run: async function (env) {
      await tick();
      const fill = env.ev('fillTemplate');
      return LEGACY_CARDS.map(function (c) { return fill('{salutation}／{occasion}／[[{company} ]][[{title} ]]TEL{phone}／携帯{mobile}／{address}／{email}', c) + '\n' + fill(env.ev('mailTemplate').body, c); });
    },
    stored: true },
  { group: '既存機能', name: '保存前の形式チェック（桁数・携帯の先頭・郵便番号と都道府県）', type: 'keep',
    run: function (env) {
      const f = env.ev('checkFormats');
      return plain([f({ phone: '03-1234-567', mobile: '03-1234-5678', email: 'a@b', address: '〒530-0001 東京都千代田区' }), f({ phone: '03-1234-5678', mobile: '090-1111-2222', email: 'a@b.jp', address: '〒100-0001 東京都千代田区千代田1-1' })]);
    } },
  { group: '既存機能', name: '一覧の表示（電話・携帯の行を含む）', type: 'keep',
    run: async function (env) { await tick(); return env.el('cardList').innerHTML; },
    stored: true },

  // ---- 6. 名刺に書かれていない項目を空欄のまま保存する ----
  { group: '6 任意項目の空欄', name: '氏名だけ入力し、部署・役職・電話・メール・住所・交流会名・メモは空欄 → 保存できる', type: 'keep',
    run: async function (env) {
      await tick();
      env.el('f_name').value = '山田 太郎';
      env.fire('saveBtn', 'click');
      await tick();
      const saved = JSON.parse(env.store[STORAGE_KEY] || '[]');
      return { 件数: saved.length, 名刺: scrub(JSON.stringify(saved[0])), 警告: env.alerts };
    } },
  { group: '6 任意項目の空欄', name: '自動読み取りのあと役職が空欄 → 確認画面が出て、「確認したので保存する」で保存できる', type: 'keep',
    run: async function (env) {
      await tick();
      setForm(env, { name: '山田 太郎', company: '株式会社サンプル商事', title: '', email: 'yamada@sample.co.jp' });
      env.ev('ocrUsed = true');
      env.fire('saveBtn', 'click');
      const shown = env.el('confirmModal').classList.contains('show');
      env.fire('confirmSaveBtn', 'click');
      await tick();
      const saved = JSON.parse(env.store[STORAGE_KEY] || '[]');
      return { 確認画面が出た: shown, 保存後の件数: saved.length, 役職: saved[0] && saved[0].title, 部署: saved[0] && saved[0].department, 警告: env.alerts };
    },
    expect: { 確認画面が出た: true, 保存後の件数: 1, 役職: '', 部署: '', 警告: [] } },
  { group: '6 任意項目の空欄', name: '確認画面：空欄の部署・役職・電話・メール・住所を、赤い「未入力」にしない', type: 'improve',
    run: async function (env) {
      await tick();
      setForm(env, { name: '山田 太郎', company: '株式会社サンプル商事' });
      env.ev('ocrUsed = true');
      env.fire('saveBtn', 'click');
      return confirmRows(env);
    },
    expect: { 赤い未入力: [], 空欄の表示: ['部署', '役職', '固定電話', '携帯電話', 'メール', '住所'] } },
  { group: '6 任意項目の空欄', name: '確認画面：氏名・会社名が空欄のときは、従来どおり赤で知らせる（保存はできる）', type: 'improve',
    run: async function (env) {
      await tick();
      env.ev("currentPhotoDataUrl = 'data:image/jpeg;base64,PHOTO'");
      env.ev('ocrUsed = true');
      env.fire('saveBtn', 'click');
      const rows = confirmRows(env);
      env.fire('confirmSaveBtn', 'click');
      await tick();
      return { 赤い未入力: rows.赤い未入力, 保存後の件数: JSON.parse(env.store[STORAGE_KEY] || '[]').length };
    },
    expect: { 赤い未入力: ['氏名', '会社名'], 保存後の件数: 1 } },
  { group: '6 任意項目の空欄', name: '氏名・会社名・写真がすべて空 → 従来どおり保存しない（どれか1つは必要）', type: 'keep',
    run: async function (env) {
      await tick();
      setForm(env, { title: '部長', memo: 'メモだけ' });
      env.fire('saveBtn', 'click');
      await tick();
      return { 件数: JSON.parse(env.store[STORAGE_KEY] || '[]').length, 警告: env.alerts };
    },
    expect: { 件数: 0, 警告: ['氏名・会社名・写真のいずれかは入力してください。'] } },
  { group: '6 任意項目の空欄', name: '読み取りで役職の読み方が分かれた → 役職は赤枠にせず、空欄で保存できると案内する', type: 'improve',
    run: async function (env) {
      await tick();
      env.ev('applyOcrResult')({ name: '山田 太郎', company: '', department: '', title: '', phone: '', mobile: '', email: '', address: '', quarter: 0,
        candidates: { title: ['代表', '代衰'], company: ['株式会社A', '株式会社B'] }, lines: [], linePasses: [] });
      function frame(id) { const c = env.el(id).classList; return c.contains('needs-check') ? '赤枠' : (c.contains('has-candidates') ? '茶色の枠' : 'なし'); }
      const hint = env.el('ocrResultHint').textContent;
      return { 役職: frame('f_title'), 部署: frame('f_department'), 会社名: frame('f_company'), メール: frame('f_email'), 氏名: frame('f_name'),
        案内に空欄で保存できると書いてある: hint.indexOf('空欄のままで保存できます') !== -1 };
    },
    expect: { 役職: '茶色の枠', 部署: 'なし', 会社名: '赤枠', メール: '赤枠', 氏名: 'なし', 案内に空欄で保存できると書いてある: true } },
  { group: '6 任意項目の空欄', name: '空欄で保存した名刺の再表示（一覧と、編集で開いたときの入力欄・写真）', type: 'keep',
    run: async function (env) {
      await tick();
      env.el('f_name').value = '山田 太郎';
      env.ev("currentPhotoDataUrl = 'data:image/jpeg;base64,PHOTO'; originalPhotoDataUrl = 'data:image/jpeg;base64,ORIG'");
      env.fire('saveBtn', 'click');
      await tick();
      const list = scrub(env.el('cardList').innerHTML);
      const id = env.ev('cards')[0].id;
      env.fire('cardList', 'click', { target: { src: '', classList: { contains: function (c) { return c === 'edit-btn'; } }, closest: function () { return { getAttribute: function () { return id; } }; } } });
      const form = {};
      ['name', 'company', 'department', 'title', 'phone', 'mobile', 'email', 'address', 'eventName', 'memo'].forEach(function (f) { form[f] = env.el('f_' + f).value; });
      return { 一覧: list, 入力欄: form, 写真: env.el('photoPreview').src, 元の写真: env.ev('originalPhotoDataUrl'), 見出し: env.el('formTitle').textContent };
    } },
  { group: '6 任意項目の空欄', name: '空欄の名刺を編集して空欄のまま更新 → 写真・元の写真・登録日時が残る', type: 'keep',
    run: async function (env) {
      await tick();
      const id = env.ev('cards')[1].id;
      env.fire('cardList', 'click', { target: { src: '', classList: { contains: function (c) { return c === 'edit-btn'; } }, closest: function () { return { getAttribute: function () { return id; } }; } } });
      setForm(env, { title: '', department: '', eventName: '', memo: '' });
      env.fire('saveBtn', 'click');
      await tick();
      const saved = JSON.parse(env.store[STORAGE_KEY]);
      return { 件数: saved.length, 触っていない名刺はそのまま: JSON.stringify(saved[0]) === JSON.stringify(LEGACY_CARDS[0]), 更新した名刺: scrub(JSON.stringify(saved[1])), 警告: env.alerts };
    },
    stored: true },
  { group: '6 任意項目の空欄', name: 'JSON書き出し → 別の端末で読み込み：空欄の項目と写真がそのまま戻る', type: 'keep',
    run: async function (env, html) {
      await tick();
      env.el('f_name').value = '山田 太郎';
      env.ev("currentPhotoDataUrl = 'data:image/jpeg;base64,PHOTO'; originalPhotoDataUrl = 'data:image/jpeg;base64,ORIG'");
      env.fire('saveBtn', 'click');
      await tick();
      env.fire('exportBtn', 'click');
      const json = env.blobs[env.blobs.length - 1].text;
      const other = makeEnv(html, {});
      await tick();
      other.el('importInput').files = [{ _text: json }];
      other.fire('importInput', 'change');
      await tick(); await tick();
      const a = JSON.parse(json)[0], b = JSON.parse(other.store[STORAGE_KEY])[0];
      const differs = Object.keys(b).filter(function (k) { return k !== 'id' && k !== 'updatedAt' && (a[k] || (k === 'mailOpenedAt' ? 0 : '')) !== b[k]; });
      return { 読み込んだ件数: JSON.parse(other.store[STORAGE_KEY]).length, 食い違う項目: differs, 写真: b.photo, 元の写真: b.photoOriginal, 役職: b.title, 書き出したJSON: scrub(json) };
    } },
  { group: '6 任意項目の空欄', name: '役職などのキー自体がない古いJSONの読み込み → 空欄として読み込まれ、保存できる', type: 'keep',
    run: async function (env) {
      await tick();
      env.el('importInput').files = [{ _text: JSON.stringify([{ name: '旧 太郎', photo: 'data:image/jpeg;base64,OLD' }]) }];
      env.fire('importInput', 'change');
      await tick(); await tick();
      return { 名刺: scrub(env.store[STORAGE_KEY]), 一覧に表示: env.el('cardList').innerHTML.indexOf('旧 太郎') !== -1, 警告: env.alerts };
    } },

  // ---- 7. 文字認識の乱れ（図柄の消し残し・氏名の端の余計な文字・メールの先頭の欠け） ----
  { group: '7 図柄の消し方', name: 'QRコードのすぐ横（8px）に文字がある → QRは消し残さず、文字は消さない', type: 'improve',
    run: function (env) { return graphicsCase(env, 8); },
    expect: { QRの消し残し: 0, 消えた文字: 0 } },
  { group: '7 図柄の消し方', name: 'QRコードと文字がごく近い（4px）→ それでも文字は消さない', type: 'improve',
    run: function (env) { return graphicsCase(env, 4); },
    expect: { QRの消し残し: 0, 消えた文字: 0 } },
  { group: '7 図柄の消し方', name: '丸いロゴ（四角くない図柄）は従来と同じ消し方のまま', type: 'keep',
    run: function (env) {
      const bmp = makeBitmap(700, 400);
      for (let y = -90; y <= 90; y++) for (let x = -90; x <= 90; x++) if (x * x + y * y <= 8100) bmp.fill(250 + x, 200 + y, 1, 1);
      drawTextLike(bmp, 400, 190, 200, 30);
      return env.ev('findGraphics')(bmp, 34).map(function (r) { return [r.x, r.y, r.w, r.h].map(function (v) { return Math.round(v * 10000); }).join(','); }).join(' ');
    } },
  { group: '7 図柄の消し方', name: '図柄のない名刺（文字だけ）→ 何も消さない', type: 'keep',
    run: function (env) {
      const bmp = makeBitmap(700, 400);
      [60, 120, 180, 240, 300].forEach(function (y) { drawTextLike(bmp, 60, y, 520, 30); });
      return env.ev('findGraphics')(bmp, 34).length;
    },
    expect: 0 },

  { group: '7 氏名の端の文字', name: '氏名の端に図形に似た文字（回）が付いた → 自動では入れず、除いた形を先頭に両方を候補に出す', type: 'improve',
    run: function (env) {
      const items = [line('山田 太郎 回', 48)].concat(BODY);
      const r = combine(env, [items, items, items]);
      return { name: r.name, 候補: r.candidates.name || [] };
    },
    expect: { name: '', 候補: ['山田 太郎', '山田太郎回'] } },
  { group: '7 氏名の端の文字', name: '3回のうち1回だけ余計な文字が付き、残り2回は一致した → 一致した読みを自動入力する', type: 'improve',
    run: function (env) {
      const junk = [line('佐藤 花子 ロ', 48)].concat(BODY), clean = [line('佐藤 花子', 48)].concat(BODY);
      const r = combine(env, [clean, junk, clean]);
      return { name: r.name, 候補: r.candidates.name || [] };
    },
    expect: { name: '佐藤 花子', 候補: [] } },
  { group: '7 氏名の端の文字', name: '「口」で終わる姓（山口・川口）や、途中に「口」がある氏名は、従来どおり自動入力する', type: 'keep',
    run: function (env) {
      return ['山口', '川口 花子', '樋口 一葉', '谷口 太郎'].map(function (name) {
        const items = [line(name, 48)].concat(BODY);
        return combine(env, [items, items, items]).name;
      });
    },
    expect: ['山口', '川口 花子', '樋口 一葉', '谷口 太郎'] },

  { group: '7 メールの先頭', name: '先頭の1文字が空白で切り離されて読まれた「t anaka@…」→ つなげた形を採用し、つなげない形も候補に出す', type: 'improve',
    run: function (env) {
      const items = [line('山田 太郎', 48), line('東京都千代田区千代田1-2-3'), line('t anaka@example.com')];
      const r = combine(env, [items, items, items]);
      return { email: r.email, 候補: r.candidates.email || [] };
    },
    expect: { email: 'tanaka@example.com', 候補: ['anaka@example.com'] } },
  { group: '7 メールの先頭', name: '1回だけ切り離されて読まれた → ほかの読みと同じアドレスとして確定する', type: 'improve',
    run: function (env) {
      const split = [line('yo shida@example.co.jp')], whole = [line('yoshida@example.co.jp')];
      const r = combine(env, [whole, split, whole]);
      return { email: r.email, 候補: r.candidates.email || [] };
    },
    expect: { email: 'yoshida@example.co.jp', 候補: ['shida@example.co.jp'] } },
  { group: '7 メールの先頭', name: '見出しの略号（E・M）や大文字・数字の切れ端はつなげない（つなげた形は候補にだけ出す）', type: 'improve',
    run: function (env) {
      return ['E info@example.com', 'M info@example.com', 'R info@example.com', 'TEL 03 info@example.com'].map(function (text) {
        const r = combine(env, [[line(text)], [line(text)], [line(text)]]);
        return r.email + ' / 候補: ' + (r.candidates.email || []).join(',');
      });
    },
    expect: ['info@example.com / 候補: Einfo@example.com', 'info@example.com / 候補: Minfo@example.com', 'info@example.com / 候補: Rinfo@example.com', 'info@example.com / 候補: 03info@example.com'] },
  { group: '7 メールの先頭', name: '見出しつき・見出しなしの普通のアドレスは従来どおり', type: 'keep',
    run: function (env) {
      return ['E-mail: info@example.com', 'Mail info@example.com', 'メール：info@example.com', 'info@example.com', 'info @ example . com', 'E-mail info@example.com URL https://example.com'].map(function (text) {
        const r = combine(env, [[line(text)], [line(text)], [line(text)]]);
        return r.email + ' / 候補: ' + (r.candidates.email || []).join(',');
      });
    },
    expect: ['info@example.com / 候補: ', 'info@example.com / 候補: ', 'info@example.com / 候補: ', 'info@example.com / 候補: ', 'info@example.com / 候補: ', 'info@example.com / 候補: '] },

  { group: '7 読み違いの補正', name: 'カタカナの語の前の「Al」（Iをlと読み違えたもの）→「AI」に直す。ほかの英字の語は変えない', type: 'improve',
    run: function (env) {
      const f = env.ev('normalizeOcrText');
      return ['Al プレゼンター', 'Alコンサルタント', '生成Al エンジニア', 'Alice Smith', 'Al Jazeera', 'ALSOK', 'CEO Albert', 'AIプレゼンター'].map(function (t) { return f(t); });
    },
    expect: ['AI プレゼンター', 'AIコンサルタント', '生成AI エンジニア', 'Alice Smith', 'Al Jazeera', 'ALSOK', 'CEO Albert', 'AIプレゼンター'] },

  // ---- 8. 候補・行を正しい欄へ入れる ----
  { group: '8 欄への反映', name: 'まとめられた行の「別の読み」を選んでから氏名に入れる → 選んだ読みが入る', type: 'improve',
    run: function (env) {
      shownLines(env, [['山田太郎回', '長寿社会への取り組み'], ['山田太郎'], ['山田太郎回']], {});
      const shown = plain(env.el('ocrLines')._lines);
      const row = { getAttribute: function () { return '0'; } };
      env.fire('ocrLines', 'click', { target: { getAttribute: function (k) { return k === 'data-r' ? '山田太郎' : null; }, closest: function () { return row; }, textContent: '山田太郎' } });
      env.fire('ocrLines', 'click', { target: { getAttribute: function (k) { return k === 'data-f' ? 'name' : null; }, closest: function () { return row; }, textContent: '氏名' } });
      return { 一覧の先頭: shown[0], 氏名欄: env.el('f_name').value };
    },
    expect: { 一覧の先頭: '山田太郎回', 氏名欄: '山田太郎' } },
  { group: '8 欄への反映', name: '行を項目に入れる → 見出しや別の項目を除いて、その項目に当たる部分だけが入る', type: 'improve',
    run: function (env) {
      const lines = ['E-mail: info@example.com', 'TEL 03-1234-5678 FAX 03-1234-5679', '携帯 090-1111-2222', '〒100-0001 東京都千代田区千代田1-2-3 TEL 03-1111-2222', '【株式会社サンプル商事】', '・営業部'];
      const targets = ['email', 'phone', 'mobile', 'address', 'company', 'department'];
      env.el('ocrHideUsed').checked = false;
      shownLines(env, [lines], {}, { merge: true, hideUsed: false });
      const out = {};
      targets.forEach(function (f, i) {
        const row = { getAttribute: function () { return String(i); } };
        env.fire('ocrLines', 'click', { target: { getAttribute: function (k) { return k === 'data-f' ? f : null; }, closest: function () { return row; }, textContent: f } });
        out[f] = env.el('f_' + f).value;
      });
      return out;
    },
    expect: { email: 'info@example.com', phone: '03-1234-5678', mobile: '090-1111-2222', address: '〒100-0001 東京都千代田区千代田1-2-3', company: '株式会社サンプル商事', department: '営業部' } },
  { group: '8 欄への反映', name: '項目に当たる部分が取り出せない行は、従来どおり行をそのまま入れる（メモへの追記も従来どおり）', type: 'keep',
    run: function (env) {
      shownLines(env, [['長寿社会への取り組み', 'AI活用・出版']], {}, { merge: true, hideUsed: false });
      const out = {};
      [['email', 0], ['phone', 0], ['title', 1], ['memo', 0], ['memo', 1]].forEach(function (t) {
        const row = { getAttribute: function () { return String(t[1]); } };
        env.fire('ocrLines', 'click', { target: { getAttribute: function (k) { return k === 'data-f' ? t[0] : null; }, closest: function () { return row; }, textContent: t[0] } });
        out[t[0]] = env.el('f_' + t[0]).value;
      });
      return out;
    },
    expect: { email: '長寿社会への取り組み', phone: '長寿社会への取り組み', title: 'AI活用・出版', memo: '長寿社会への取り組み\nAI活用・出版' } },
  { group: '8 欄への反映', name: '候補ボタンをタップ → その候補の項目の欄に入る（氏名・メール・住所）', type: 'keep',
    run: function (env) {
      const out = {};
      [['name', '山田 太郎'], ['email', 'tanaka@example.com'], ['address', '〒100-0001 東京都千代田区千代田1-2-3 ABCビル']].forEach(function (t) {
        env.fire('ocrCandidates', 'click', { target: { getAttribute: function (k) { return k === 'data-f' ? t[0] : (k === 'data-v' ? t[1] : null); } } });
        out[t[0]] = env.el('f_' + t[0]).value;
      });
      return out;
    },
    expect: { name: '山田 太郎', email: 'tanaka@example.com', address: '〒100-0001 東京都千代田区千代田1-2-3 ABCビル' } },
  { group: '8 欄への反映', name: '「部署と役職の内容を入れ替える」→ 役職に入った肩書きを部署へ移せる', type: 'improve',
    run: function (env) {
      setForm(env, { department: '', title: 'AIプレゼンター' });
      env.fire('swapDeptTitleBtn', 'click');
      const once = { 部署: env.el('f_department').value, 役職: env.el('f_title').value };
      env.fire('swapDeptTitleBtn', 'click');
      return { 一度押す: once, もう一度押す: { 部署: env.el('f_department').value, 役職: env.el('f_title').value } };
    },
    expect: { 一度押す: { 部署: 'AIプレゼンター', 役職: '' }, もう一度押す: { 部署: '', 役職: 'AIプレゼンター' } } },
  { group: '8 欄への反映', name: '肩書きの自動の振り分け（「〜プレゼンター」「〜コンサルタント」は役職、「営業部」は部署）は変えていない', type: 'keep',
    run: function (env) {
      return ['AIプレゼンター', 'ITコンサルタント', '営業部', '営業部 部長'].map(function (text) {
        const r = env.ev('parseCardText')('株式会社サンプル商事\n' + text + '\n山田 太郎');
        return '部署=' + r.department + ' 役職=' + r.title;
      });
    },
    expect: ['部署= 役職=AIプレゼンター', '部署= 役職=ITコンサルタント', '部署=営業部 役職=', '部署=営業部 役職=部長'] },
  { group: '8 欄への反映', name: '役職・部署を空欄にしたまま保存できる（入れ替えで役職が空になったあとも）', type: 'improve',
    run: async function (env) {
      await tick();
      setForm(env, { name: '山田 太郎', department: '', title: 'AIプレゼンター' });
      env.fire('swapDeptTitleBtn', 'click');
      env.fire('saveBtn', 'click');
      await tick();
      const saved = JSON.parse(env.store[STORAGE_KEY] || '[]');
      return { 件数: saved.length, 部署: saved[0] && saved[0].department, 役職: saved[0] && saved[0].title, 警告: env.alerts };
    },
    expect: { 件数: 1, 部署: 'AIプレゼンター', 役職: '', 警告: [] } }
];

// ---- 図柄を消す処理のための、白黒の絵（1＝黒）。index.html の findGraphics が受け取る canvas の代わり ----
function makeBitmap(W, H) {
  const bits = new Uint8Array(W * H);
  return {
    width: W, height: H, bits: bits,
    fill: function (x, y, w, h) { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) bits[yy * W + xx] = 1; },
    getContext: function () {
      return { getImageData: function () {
        const data = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = bits[i] ? 0 : 255; data[i * 4 + 3] = 255; }
        return { data: data };
      } };
    }
  };
}
// QRコードに似た絵：3つの隅に「回」の形の目印、ほかは決まった並びの点
function drawQrLike(bmp, x, y, modules, m) {
  // 偏りのない決まった並びを作る（実際のQRコードも、白黒が偏らないように作られている）
  let state = 20261009;
  function next() { state = (state + 0x6D2B79F5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  for (let r = 0; r < modules; r++) for (let c = 0; c < modules; c++) {
    const bit = next() < 0.5;
    const corner = (r < 7 && c < 7) ? [r, c] : (r < 7 && c >= modules - 7) ? [r, c - (modules - 7)] : (r >= modules - 7 && c < 7) ? [r - (modules - 7), c] : null;
    const dark = corner ? (corner[0] === 0 || corner[0] === 6 || corner[1] === 0 || corner[1] === 6 || (corner[0] >= 2 && corner[0] <= 4 && corner[1] >= 2 && corner[1] <= 4)) : bit;
    if (dark) bmp.fill(x + c * m, y + r * m, m, m);
  }
}
// 文字の行に似た絵：縦の線と横の線の並び
function drawTextLike(bmp, x, y, w, h) {
  for (let xx = x; xx + 3 <= x + w; xx += 9) bmp.fill(xx, y, 3, h);
  bmp.fill(x, y + Math.floor(h / 2), w - (w % 9 || 9) + 3, 2);
}
// QRの左右に gap ピクセルだけ離して文字の行を置き、消される範囲を調べる
function graphicsCase(env, gap) {
  const W = 900, H = 420, qx = 360, qy = 110, m = 4, n = 41, size = n * m;  // QRの1マスは本文の文字より細かい
  const bmp = makeBitmap(W, H);
  drawQrLike(bmp, qx, qy, n, m);
  const textLeft = { x: qx - gap - 198, y: qy + 60, w: 198, h: 34 }, textRight = { x: qx + size + gap, y: qy + 90, w: 198, h: 34 };
  [textLeft, textRight].forEach(function (t) { drawTextLike(bmp, t.x, t.y, t.w, t.h); });
  const rects = env.ev('findGraphics')(bmp, 34).map(function (r) {
    const x = Math.round(r.x * W), y = Math.round(r.y * H);
    return { x0: x, y0: y, x1: x + Math.round(r.w * W), y1: y + Math.round(r.h * H) };
  });
  function uncovered(area, wantCovered) {
    let count = 0;
    for (let y = area.y; y < area.y + area.h; y++) for (let x = area.x; x < area.x + area.w; x++) {
      if (!bmp.bits[y * W + x]) continue;
      const covered = rects.some(function (r) { return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1; });
      if (covered !== wantCovered) count++;
    }
    return count;
  }
  return { QRの消し残し: uncovered({ x: qx, y: qy, w: size, h: size }, true), 消えた文字: uncovered(textLeft, false) + uncovered(textRight, false) };
}

function setForm(env, values) { Object.keys(values).forEach(function (f) { env.el('f_' + f).value = values[f]; }); }
// 保存前の確認画面に並んだ行のうち、赤い「未入力」になっている項目と、空欄と表示されている項目
function confirmRows(env) {
  const out = { 赤い未入力: [], 空欄の表示: [] };
  env.el('confirmList').innerHTML.split('<div class="card-row">').slice(1).forEach(function (row) {
    const label = /<span class="k">([^<]*)<\/span>/.exec(row)[1];
    if (row.indexOf('var(--danger)') !== -1) out.赤い未入力.push(label);
    else if (row.indexOf('var(--sub)') !== -1) out.空欄の表示.push(label);
  });
  return out;
}

async function runCase(html, c) {
  const stored = c.stored ? { [STORAGE_KEY]: JSON.stringify(LEGACY_CARDS) } : {};
  try { return { value: plain(await c.run(makeEnv(html, stored), html)) }; } catch (err) { return { error: String(err && err.message || err) }; }
}
function show(r) { return r.error ? '（エラー: ' + r.error + '）' : JSON.stringify(r.value); }

(async function () {
  const after = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const before = execFileSync('git', ['show', BASE_REF + ':index.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');
  console.log('修正前: コミット ' + BASE_REF + ' の index.html ／ 修正後: 作業フォルダの index.html\n');
  let failed = 0, changed = 0, group = '';
  for (const c of CASES) {
    const b = await runCase(before, c);
    const a = await runCase(after, c);
    const same = show(b) === show(a);
    const meets = !('expect' in c) || (!a.error && JSON.stringify(a.value) === JSON.stringify(c.expect));
    const ok = !a.error && meets && (c.type !== 'keep' || same);
    if (!ok) failed++;
    if (!same) changed++;
    if (c.group !== group) { group = c.group; console.log('■ ' + group); }
    console.log((ok ? '  [OK] ' : '  [NG] ') + c.name + (c.type === 'keep' ? '（変えない）' : '（改善）'));
    if (same) console.log('        修正前後で同じ' + (show(a).length <= 160 ? ': ' + show(a) : '（' + show(a).length + '文字の結果が一致）'));
    else { console.log('        修正前: ' + show(b)); console.log('        修正後: ' + show(a)); }
    if (!meets) console.log('        期待  : ' + JSON.stringify(c.expect));
  }
  console.log('\n' + CASES.length + ' 件中 ' + (CASES.length - failed) + ' 件 OK、' + failed + ' 件 NG（修正前後で結果が変わったもの ' + changed + ' 件）');
  process.exit(failed ? 1 : 0);
})();
