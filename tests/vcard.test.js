// 電子名刺の連絡先ファイル（nishikawa.vcf）と、電子名刺ページ（card.html）の連絡先表示を確かめるテスト。
// 電話番号と住所は公開しない方針なので、「載っていないこと」も確かめる。
//
//   node tests/vcard.test.js            … いまのファイルを検査し、修正前（下の BASE_REF のコミット）からの変化も確かめる
//   node tests/vcard.test.js <コミット>  … 比べる相手のコミットを指定する
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE_REF = process.argv[2] || 'ebf2a18';

// 電話番号らしい数字の並び（03-1234-5678、090-1234-5678、09012345678、+81-90-… など）
const PHONE_LIKE_RE = /(?:\+81[-\s]?\d|0\d{1,4}-\d{1,4}-\d{3,4}|0[5789]0\d{8})/;

let failed = 0, count = 0;
function check(name, ok, detail) {
  count++;
  if (!ok) failed++;
  console.log((ok ? '  [OK] ' : '  [NG] ') + name + (detail ? '  … ' + detail : ''));
}

// ---- vCard を1行ずつに分けて読む ----
function parseVcard(buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);   // UTF-8として正しくなければここで失敗する
  const raw = text.split('\r\n');
  // 折り返し（次の行が空白で始まる）をつなげる
  const lines = [];
  raw.forEach(function (l) { if (/^[ \t]/.test(l) && lines.length) lines[lines.length - 1] += l.slice(1); else lines.push(l); });
  const props = lines.filter(Boolean).map(function (l) {
    const m = /^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+(?:=[^;:]*)?)*):(.*)$/.exec(l);
    return m ? { name: m[1].toUpperCase(), params: m[2].split(';').filter(Boolean).map(function (p) { return p.toUpperCase(); }), value: m[3], line: l } : { bad: l };
  });
  return { text: text, raw: raw, props: props };
}
function one(card, name) { const list = card.props.filter(function (p) { return p.name === name; }); return list.length === 1 ? list[0] : null; }

const bytes = fs.readFileSync(path.join(ROOT, 'nishikawa.vcf'));
const before = execFileSync('git', ['show', BASE_REF + ':nishikawa.vcf'], { cwd: ROOT });

console.log('■ 連絡先ファイル nishikawa.vcf の構文');
let card;
try { card = parseVcard(bytes); check('UTF-8として正しく読める', true); } catch (e) { check('UTF-8として正しく読める', false, String(e.message)); process.exit(1); }
check('先頭にBOM（目印の3バイト）がない', !(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF));
check('改行はすべてCRLF（vCardの決まり）で、最後も改行で終わる', !/[^\r]\n/.test(card.text) && !/\r(?!\n)/.test(card.text) && card.text.endsWith('\r\n'));
check('どの行も「項目名(;属性):値」の形になっている', card.props.every(function (p) { return !p.bad; }), card.props.filter(function (p) { return p.bad; }).length ? '形の合わない行があります' : '');
check('1行は75バイト以内（長い行の折り返しが不要）', card.raw.every(function (l) { return Buffer.byteLength(l, 'utf8') <= 75; }),
  '最長 ' + Math.max.apply(null, card.raw.map(function (l) { return Buffer.byteLength(l, 'utf8'); })) + ' バイト');
check('BEGIN:VCARD で始まり END:VCARD で終わる', card.props[0].line === 'BEGIN:VCARD' && card.props[card.props.length - 1].line === 'END:VCARD');
check('VERSION:3.0 が BEGIN の直後にある', card.props[1].line === 'VERSION:3.0');
check('必須の N と FN が1つずつある', !!one(card, 'N') && !!one(card, 'FN'));
check('文字の値に、区切りと紛らわしい「,」「;」「\\」が入っていない', ['FN', 'NICKNAME', 'ORG', 'TITLE', 'NOTE'].every(function (n) { const p = one(card, n); return p && !/[,;\\]/.test(p.value); }));

console.log('■ 氏名とニックネーム');
check('氏名（FN）は従来どおり「西川 尚」', one(card, 'FN').value === '西川 尚');
check('姓・名（N）は従来どおり「西川;尚;;;」', one(card, 'N').value === '西川;尚;;;');
const nick = one(card, 'NICKNAME');
check('NICKNAME が1つあり、値は「明日しよう」', !!nick && nick.value === '明日しよう' && nick.params.length === 0);
check('ニックネームが氏名（FN・N）に混ざっていない', one(card, 'FN').value.indexOf('明日') === -1 && one(card, 'N').value.indexOf('明日') === -1);

console.log('■ 電話番号・住所は載せない');
check('TEL（電話番号）が1つもない', !card.props.some(function (p) { return p.name === 'TEL'; }));
check('住所（ADR・LABEL）を載せていない', !card.props.some(function (p) { return p.name === 'ADR' || p.name === 'LABEL'; }));
check('ファイルのどこにも、電話番号らしい数字の並びがない', !PHONE_LIKE_RE.test(card.text));

console.log('■ 従来の項目が残っている');
[['ORG', '有限会社アークリー'], ['TITLE', '代表'], ['EMAIL', 'arcly4@gmail.com'], ['NOTE', '不老死労 / AI活用・出版・長寿社会への取り組み'], ['URL', 'https://startrekking72.github.io/meishi-tool/card.html']]
  .forEach(function (t) { const p = one(card, t[0]); check(t[0] + ' = ' + t[1], !!p && p.value === t[1]); });
check('EMAIL の属性（TYPE=INTERNET）もそのまま', one(card, 'EMAIL').params.join(';') === 'TYPE=INTERNET');
const oldLines = parseVcard(before).raw.filter(Boolean);
const newLines = card.raw.filter(Boolean);
check('修正前（' + BASE_REF + '）の行は、すべて同じ内容・同じ順番で残っている', oldLines.every(function (l) { return newLines.indexOf(l) !== -1; }) &&
  JSON.stringify(newLines.filter(function (l) { return oldLines.indexOf(l) !== -1; })) === JSON.stringify(oldLines));
const added = newLines.filter(function (l) { return oldLines.indexOf(l) === -1; });
check('足した行は NICKNAME の1行だけ', JSON.stringify(added) === JSON.stringify(['NICKNAME:明日しよう']), added.length + ' 行');

// ---- 電子名刺ページ：スクリプトを簡単な部品の上で動かし、連絡先の行とQRコードの中身を見る ----
console.log('■ 電子名刺ページ card.html');
const html = fs.readFileSync(path.join(ROOT, 'card.html'), 'utf8').replace(/\r\n/g, '\n');
const script = /<script>\s*([\s\S]*?)<\/script>/.exec(html)[1];
const els = {};
function makeEl(tag) {
  const el = { tag: tag, children: [], textContent: '', hidden: false, href: '', className: '', style: {},
    appendChild: function (c) { el.children.push(c); }, addEventListener: function () {},
    getContext: function () { return { fillRect: function () {} }; } };
  return el;
}
let qrText = null;
const context = {
  document: { getElementById: function (id) { return els[id] || (els[id] = makeEl('#' + id)); }, createElement: makeEl, title: 'card' },
  location: { origin: 'https://startrekking72.github.io', pathname: '/meishi-tool/card.html' },
  navigator: {},
  qrcode: function () { return { addData: function (t) { qrText = t; }, make: function () {}, getModuleCount: function () { return 21; }, isDark: function () { return false; } }; }
};
vm.createContext(context);
vm.runInContext(script, context);
const rows = els.contactRows.children.map(function (row) { return { label: row.children[0].textContent, text: row.children[1].textContent, href: row.children[1].href }; });
check('電話番号の行（電話・携帯）は出ていない', !rows.some(function (r) { return r.label === '電話' || r.label === '携帯' || /^tel:/.test(r.href); }));
check('メールの行は従来どおり（mailto:arcly4@gmail.com）', rows.some(function (r) { return r.label === 'メール' && r.href === 'mailto:arcly4@gmail.com'; }));
check('連絡先の行はメールの1つだけ（電話番号・住所は出ていない）', JSON.stringify(rows.map(function (r) { return r.label; })) === JSON.stringify(['メール']));
check('表示名・本名・会社名・肩書きは従来どおり', els.pHandle.textContent === '明日しよう' && els.pName.textContent === '西川 尚' && els.pCompany.textContent === '有限会社アークリー' && els.pTitle.textContent === '代表');
check('QRコードの中身は電子名刺のURL（連絡先ファイルの URL と同じ）', qrText === 'https://startrekking72.github.io/meishi-tool/card.html' && qrText === one(card, 'URL').value, String(qrText));
check('「連絡先に保存する」は nishikawa.vcf を開く', /id="vcardBtn" href="nishikawa\.vcf"/.test(html));
check('ページに住所・郵便番号が書かれていない', !/〒|住所|\d{3}-\d{4}(?!-)/.test(html));
check('ページのどこにも、電話番号らしい数字の並びや、番号入りの電話リンクがない', !PHONE_LIKE_RE.test(html) && !/tel:\+?\d/.test(html));

console.log('\n' + count + ' 件中 ' + (count - failed) + ' 件 OK、' + failed + ' 件 NG');
process.exit(failed ? 1 : 0);
