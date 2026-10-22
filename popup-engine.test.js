// Jalankan: letakkan 3 file (pesan_popup.json, popup-engine.js, popup-engine.test.js) dalam satu folder
// yang punya package.json berisi {"type":"module"}, lalu:  node popup-engine.test.js
import fs from 'node:fs';
import {
  buatMesinPopup, adapterMemori, adapterLocalStorage, validasiData, rencanaPopup, isiTemplat, acakFisherYates
} from './popup-engine.js';

const data = JSON.parse(fs.readFileSync(new URL('./pesan_popup.json', import.meta.url), 'utf8'));
let lulus = 0, gagal = 0;
const cek = (nama, ok, info) => { if (ok) { lulus++; console.log('  OK    ' + nama); } else { gagal++; console.log('  GAGAL ' + nama + (info !== undefined ? ' -> ' + JSON.stringify(info) : '')); } };
const semua = [];
Object.keys(data.kategori).forEach((k) => data.kategori[k].pesan.forEach((p) => semua.push({ ...p, kat: k })));
// pengacak berbiji (deterministik) agar uji bisa diulang
const biji = (n) => () => { n |= 0; n = (n + 0x6D2B79F5) | 0; let t = Math.imul(n ^ (n >>> 15), 1 | n); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

console.log('\n[A] Kualitas data');
cek('tepat 200 kalimat', semua.length === 200 && data.total === 200, semua.length);
cek('validasiData() tanpa masalah', validasiData(data).length === 0, validasiData(data));
cek('ID unik semua', new Set(semua.map((p) => p.id)).size === 200);
cek('teks unik semua (abaikan huruf besar & tanda baca)', new Set(semua.map((p) => p.teks.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim())).size === 200);
const jumlah = Object.fromEntries(Object.keys(data.kategori).map((k) => [k, data.kategori[k].pesan.length]));
cek('9 kategori x 20, konfirmasi_langkah 12, konfirmasi_selesai 8', ['sapaan','apresiasi','refleksi','harapan','evaluasi','rencana','guru','netral','belum_siap'].every((k) => jumlah[k] === 20) && jumlah.konfirmasi_langkah === 12 && jumlah.konfirmasi_selesai === 8, jumlah);
const kata = (t) => t.replace(/\{minKata\}/g, '10').split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)).length;
cek('semua pendek (maks. 16 kata)', semua.every((p) => kata(p.teks) <= 16), semua.filter((p) => kata(p.teks) > 16).map((p) => p.id));
cek('tiap kalimat minimal 3 kata', semua.every((p) => kata(p.teks) >= 3));
const seg = new Intl.Segmenter('id', { granularity: 'grapheme' });
const emoji = (t) => [...seg.segment(t)].filter((s) => /\p{Extended_Pictographic}/u.test(s.segment)).length;
cek('maksimal 1 emoji per kalimat', semua.every((p) => emoji(p.teks) <= 1));
cek('tidak ada placeholder selain {minKata}', semua.every((p) => (p.teks.match(/\{[^}]*\}/g) || []).every((m) => m === '{minKata}')));
const larangan = /\b(pasti|dijamin|sembuh|depresi|gangguan|diagnosis|trauma|semua akan baik|baik-baik saja|masalahmu (serius|berat)|masalah yang (hebat|keren))\b/i;
cek('tanpa janji, diagnosis, atau penilaian atas isi masalah', semua.every((p) => !larangan.test(p.teks)), semua.filter((p) => larangan.test(p.teks)).map((p) => p.id));
const pujian = /\b(keren|hebat|bagus|mantap|salut|bangga|pintar|pandai|terima kasih)\b/i;
cek('kategori netral & belum_siap: netral (tanpa pujian berlebihan)', data.kategori.netral.pesan.every((p) => !pujian.test(p.teks)) && data.kategori.belum_siap.pesan.every((p) => !/\b(keren|hebat|bagus|mantap|salut|bangga|pintar)\b/i.test(p.teks)));
cek('kategori netral tidak menuduh', data.kategori.netral.pesan.every((p) => !/(asal|malas|bohong|main-main|ngawur)/i.test(p.teks)));
cek('konfirmasi_langkah tidak mengaku cerita sudah terkirim', data.kategori.konfirmasi_langkah.pesan.every((p) => !/(terkirim|selesai dan|semua jawaban|seluruh)/i.test(p.teks)), data.kategori.konfirmasi_langkah.pesan.filter((p) => /(terkirim|selesai dan|semua jawaban|seluruh)/i.test(p.teks)).map((p) => p.id));
const mirip = (a, b) => { const A = new Set(a.toLowerCase().match(/\p{L}+/gu)), B = new Set(b.toLowerCase().match(/\p{L}+/gu)); let i = 0; A.forEach((x) => { if (B.has(x)) i++; }); return i / (A.size + B.size - i); };
let terlaluMirip = [];
for (let i = 0; i < semua.length; i++) for (let j = i + 1; j < semua.length; j++) if (mirip(semua[i].teks, semua[j].teks) > 0.75) terlaluMirip.push([semua[i].id, semua[j].id]);
cek('tidak ada dua kalimat yang nyaris kembar (kemiripan kata <= 75%)', terlaluMirip.length === 0, terlaluMirip);
cek('{minKata} diganti nilai backend', isiTemplat('Tulis {minKata} kata', { minKata: 12 }) === 'Tulis 12 kata' && isiTemplat('Tulis {minKata} kata') === 'Tulis 10 kata');

console.log('\n[B] Tanpa pengulangan sebelum siklus habis');
for (const kat of Object.keys(data.kategori)) {
  const n = data.kategori[kat].pesan.length;
  const m = buatMesinPopup({ data, penyimpanan: adapterMemori(), acak: biji(n * 7) });
  const siklus = [];
  for (let c = 0; c < 4; c++) { const ids = []; for (let i = 0; i < n; i++) ids.push(m.ambil('S1', kat).id); siklus.push(ids); }
  const unikSemua = siklus.every((ids) => new Set(ids).size === n);
  const batasOk = siklus.every((ids, c) => c === 0 || ids[0] !== siklus[c - 1][n - 1]);
  const acakBeda = new Set(siklus.map((x) => x.join())).size > 1;
  cek(kat + ': ' + n + ' kalimat muncul tepat 1x per siklus (4 siklus), batas siklus tak berulang', unikSemua && batasOk && acakBeda);
}
{
  const m = buatMesinPopup({ data, penyimpanan: adapterMemori(), acak: biji(1) });
  const kumpul = new Set();
  Object.keys(data.kategori).forEach((kat) => { for (let i = 0; i < data.kategori[kat].pesan.length; i++) kumpul.add(m.ambil('S1', kat).id); });
  cek('200 ID berbeda tampil tepat satu kali saat semua kategori dihabiskan', kumpul.size === 200, kumpul.size);
  const r = m.ringkasan('S1');
  cek('ringkasan: semua kategori terpakai penuh, siklus 1', Object.values(r).every((x) => x.terpakai === x.total && x.siklus === 1));
  m.ambil('S1', 'refleksi');
  cek('siklus baru mulai hanya setelah kategori habis', m.ringkasan('S1').refleksi.siklus === 2 && m.ringkasan('S1').refleksi.terpakai === 1);
}
{
  const w = acakFisherYates(Array.from({ length: 6 }, (_, i) => i), biji(3));
  const hitung = {}; const N = 6000; const mm = biji(99);
  for (let t = 0; t < N; t++) { const a = acakFisherYates([0, 1, 2, 3, 4], mm); hitung[a[0]] = (hitung[a[0]] || 0) + 1; }
  cek('Fisher-Yates: posisi pertama merata (tiap nilai 17%-23%)', Object.values(hitung).every((c) => c / N > 0.17 && c / N < 0.23) && w.length === 6, hitung);
}

console.log('\n[C] Persistensi dan pergantian akun');
{
  const store = adapterMemori();
  const m1 = buatMesinPopup({ data, penyimpanan: store, acak: biji(5) });
  const dipakai = []; for (let i = 0; i < 7; i++) dipakai.push(m1.ambil('SA', 'refleksi').id);
  const m2 = buatMesinPopup({ data, penyimpanan: store, acak: biji(777) }); // simulasi muat ulang halaman
  for (let i = 0; i < 13; i++) dipakai.push(m2.ambil('SA', 'refleksi').id);
  cek('muat ulang tidak mengulang & tidak mereset (7 + 13 = 20 ID berbeda)', new Set(dipakai).size === 20, dipakai.length);
  const a = buatMesinPopup({ data, penyimpanan: store, acak: biji(8) });
  a.ambil('SA', 'harapan'); a.ambil('SA', 'harapan'); a.ambil('SB', 'harapan');
  cek('riwayat SA dan SB tidak tercampur', a.ringkasan('SA').harapan.terpakai === 2 && a.ringkasan('SB').harapan.terpakai === 1);
  const nilai = allValues(store).map((v) => JSON.parse(v));
  const kunciOk = nilai.every((o) => Object.keys(o).every((k) => ['v', 'siklus', 'urutan', 'idx'].includes(k)) && o.urutan.every((id) => /^[A-Z]{3}-\d{2}$/.test(id)));
  cek('yang tersimpan hanya versi, siklus, ID kalimat, dan indeks (tanpa cerita/nama/kelas)', nilai.length > 0 && kunciOk, nilai[0] && Object.keys(nilai[0]));
  cek('ambil tanpa siswaId ditolak', throws(() => a.ambil('', 'refleksi')));
  cek('kategori tak dikenal ditolak', throws(() => a.ambil('SA', 'xxx')));
}
function allValues(s) { const o = []; const cobaAmbil = ['SA', 'SB']; const kat = Object.keys(data.kategori); cobaAmbil.forEach((i) => kat.forEach((k) => { const v = s.ambil('pqbk:popup:' + i + ':' + k); if (v) o.push(v); })); return o; }
function throws(f) { try { f(); return false; } catch (e) { return true; } }

console.log('\n[D] Kumpulan kalimat diperbarui di tengah siklus');
{
  const store = adapterMemori();
  const m1 = buatMesinPopup({ data, penyimpanan: store, acak: biji(11) });
  const awal = []; for (let i = 0; i < 8; i++) awal.push(m1.ambil('SC', 'rencana').id);
  const data2 = JSON.parse(JSON.stringify(data)); data2.versi = '2026.2';
  const hapus = data2.kategori.rencana.pesan.splice(15, 2).map((p) => p.id); // 2 kalimat dihapus
  data2.kategori.rencana.pesan.push({ id: 'REN-21', teks: 'Kalimat baru untuk uji pembaruan.' }, { id: 'REN-22', teks: 'Satu lagi kalimat baru untuk uji.' });
  const m2 = buatMesinPopup({ data: data2, penyimpanan: store, acak: biji(12) });
  const lanjut = []; for (let i = 0; i < 20 - 8 - hapus.filter((h) => !awal.includes(h)).length + 2; i++) lanjut.push(m2.ambil('SC', 'rencana').id);
  const kumpul = awal.concat(lanjut);
  cek('yang sudah dipakai tidak muncul lagi pada siklus yang sama', lanjut.every((id) => !awal.includes(id)), lanjut.filter((id) => awal.includes(id)));
  cek('kalimat baru ikut masuk sisa siklus', lanjut.includes('REN-21') && lanjut.includes('REN-22'));
  cek('kalimat yang dihapus tidak muncul', lanjut.every((id) => !hapus.includes(id)));
  cek('tidak ada ID ganda dalam satu siklus', new Set(kumpul).size === kumpul.length);
}

console.log('\n[E] Pemilihan kategori mengikuti hasil backend (tidak ada pujian palsu / konfirmasi palsu)');
{
  const R = rencanaPopup;
  cek('jaringan gagal -> tidak ada pesan dari kumpulan', R({ jenis: 'langkah', kolom: 'W', diterimaServer: false }) === null);
  cek('jawaban belum lengkap -> netral, tanpa baris konfirmasi', JSON.stringify(R({ jenis: 'langkah', kolom: 'W', diterimaServer: true, kualitasOk: false })) === '{"utama":"netral","sub":null}');
  cek('belum siap -> belum_siap, tanpa pujian/konfirmasi', JSON.stringify(R({ jenis: 'langkah', kolom: 'D', diterimaServer: true, kualitasOk: true, belumSiap: true })) === '{"utama":"belum_siap","sub":null}');
  const peta = { masalah: 'refleksi', tanyaBK: 'refleksi', tanyaDiri: 'refleksi', W: 'harapan', D: 'evaluasi', E: 'evaluasi', P: 'rencana' };
  cek('langkah diterima -> kategori sesuai + konfirmasi_langkah', Object.keys(peta).every((k) => { const r = R({ jenis: 'langkah', kolom: k, diterimaServer: true, kualitasOk: true }); return r.utama === peta[k] && r.sub === 'konfirmasi_langkah'; }));
  cek('guru dipilih & selesaiCerita ok -> guru + konfirmasi_selesai', JSON.stringify(R({ jenis: 'guru', diterimaServer: true, kualitasOk: true })) === '{"utama":"guru","sub":"konfirmasi_selesai"}');
  cek('misi lolos -> apresiasi; misi "belum" -> tidak ada pujian', R({ jenis: 'misi', diterimaServer: true, kualitasOk: true, hasilMisi: 'lolos' }).utama === 'apresiasi' && R({ jenis: 'misi', diterimaServer: true, kualitasOk: true, hasilMisi: 'belum' }) === null);
  cek('sapaan tidak bergantung pada validasi', R({ jenis: 'sapaan' }).utama === 'sapaan');
  const m = buatMesinPopup({ data, penyimpanan: adapterMemori(), acak: biji(21) });
  const hasil = m.susun('S9', { jenis: 'langkah', kolom: 'P', diterimaServer: true, kualitasOk: true });
  cek('susun(): pesan utama dari kategori rencana, sub dari konfirmasi_langkah', hasil.utama.id.startsWith('REN-') && hasil.sub.id.startsWith('KLG-'));
  cek('susun(): jaringan gagal tidak memakai satu pun kalimat', m.susun('S9', { jenis: 'langkah', kolom: 'P', diterimaServer: false }) === null && m.ringkasan('S9').rencana.terpakai === 1);
  const net = m.susun('S9', { jenis: 'langkah', kolom: 'W', diterimaServer: true, kualitasOk: false }, { minKata: 10 });
  cek('pesan netral tidak memuat placeholder mentah', !/\{minKata\}/.test(net.utama.teks));
}

console.log('\n[F] Penyimpanan bermasalah');
{
  const rusak = { setItem() { throw new Error('penuh'); }, getItem() { throw new Error('penuh'); }, removeItem() {} };
  const ad = adapterLocalStorage(rusak);
  const m = buatMesinPopup({ data, penyimpanan: ad, acak: biji(2) });
  const ids = []; for (let i = 0; i < 20; i++) ids.push(m.ambil('SF', 'guru').id);
  cek('localStorage rusak: tetap jalan tanpa error & tanpa pengulangan, persisten=false', new Set(ids).size === 20 && ad.persisten === false);
  const ok = { _d: {}, setItem(k, v) { this._d[k] = String(v); }, getItem(k) { return k in this._d ? this._d[k] : null; }, removeItem(k) { delete this._d[k]; } };
  const ad2 = adapterLocalStorage(ok);
  buatMesinPopup({ data, penyimpanan: ad2, acak: biji(2) }).ambil('SF', 'guru');
  cek('localStorage normal: persisten=true dan data tersimpan dengan kunci per siswa', ad2.persisten === true && Object.keys(ok._d).some((k) => k === 'pqbk:popup:SF:guru'));
}

console.log('\n==== HASIL: ' + lulus + ' lulus, ' + gagal + ' gagal ====');
process.exit(gagal ? 1 : 0);
