// popup-engine.js - Pet Quest BK "Teman Cerita"
// Pop-up tanpa pengulangan: "shuffled bag" (Fisher-Yates) per siswa per kategori.
// Hanya menyimpan ID kalimat, urutan, dan indeks. TIDAK menyimpan cerita, jawaban, nama, atau kelas.
// Tanpa ketergantungan eksternal. Bisa dipakai di React/Vite maupun Node (untuk uji).

const PREFIKS = 'pqbk:popup';

// Peta konteks langkah Cerita & Refleksi -> kategori pesan utama
export const PETA_LANGKAH = {
  masalah: 'refleksi', tanyaBK: 'refleksi', tanyaDiri: 'refleksi',
  W: 'harapan', D: 'evaluasi', E: 'evaluasi', P: 'rencana'
};

export function acakFisherYates(arr, acak = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(acak() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

export function adapterMemori() {
  const peta = new Map();
  return { persisten: false, ambil: (k) => (peta.has(k) ? peta.get(k) : null), simpan: (k, v) => { peta.set(k, v); } };
}

// localStorage dengan cadangan memori. Jika localStorage tidak bisa dipakai (mode privat, penuh, diblokir),
// riwayat hanya bertahan selama halaman terbuka. Tidak ada sinkronisasi antar perangkat.
export function adapterLocalStorage(storage) {
  const s = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  const cadangan = adapterMemori();
  let aktif = !!s;
  if (aktif) {
    try { s.setItem('__pqbk_tes', '1'); s.removeItem('__pqbk_tes'); } catch (e) { aktif = false; }
  }
  return {
    get persisten() { return aktif; },
    ambil(k) {
      if (!aktif) return cadangan.ambil(k);
      try { return s.getItem(k); } catch (e) { aktif = false; return cadangan.ambil(k); }
    },
    simpan(k, v) {
      if (!aktif) return cadangan.simpan(k, v);
      try { s.setItem(k, v); } catch (e) { aktif = false; cadangan.simpan(k, v); }
    }
  };
}

export function isiTemplat(teks, opsi = {}) {
  const minKata = Number.isFinite(opsi.minKata) ? opsi.minKata : 10;
  return String(teks).replace(/\{minKata\}/g, String(minKata));
}

// Memeriksa data kalimat. Mengembalikan daftar masalah (kosong = lolos).
export function validasiData(data) {
  const masalah = [];
  const idPernah = new Set();
  const teksPernah = new Set();
  let total = 0;
  Object.keys(data.kategori || {}).forEach((kat) => {
    (data.kategori[kat].pesan || []).forEach((p) => {
      total += 1;
      if (!p.id || !p.teks) masalah.push('Kalimat tanpa id/teks di ' + kat);
      if (idPernah.has(p.id)) masalah.push('ID ganda: ' + p.id);
      idPernah.add(p.id);
      const norm = String(p.teks).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (teksPernah.has(norm)) masalah.push('Teks ganda: ' + p.id);
      teksPernah.add(norm);
    });
  });
  if (total !== data.total) masalah.push('Jumlah ' + total + ' tidak sama dengan total ' + data.total);
  return masalah;
}

// Menentukan kategori pesan dari hasil interaksi. Mengembalikan null bila TIDAK boleh ada pesan dari kumpulan ini
// (mis. jaringan gagal, atau AI menilai misi belum lolos).
// konteks: { jenis: 'sapaan'|'langkah'|'guru'|'misi', kolom, diterimaServer, kualitasOk, belumSiap, hasilMisi }
export function rencanaPopup(konteks) {
  const { jenis, kolom, diterimaServer, kualitasOk, belumSiap, hasilMisi } = konteks || {};
  if (jenis === 'sapaan') return { utama: 'sapaan', sub: null };
  if (!diterimaServer) return null;                         // jangan pernah konfirmasi palsu
  if (belumSiap) return { utama: 'belum_siap', sub: null };
  if (kualitasOk === false) return { utama: 'netral', sub: null }; // ekstingsi: tanpa pujian
  if (jenis === 'langkah') return { utama: PETA_LANGKAH[kolom] || 'apresiasi', sub: 'konfirmasi_langkah' };
  if (jenis === 'guru') return { utama: 'guru', sub: 'konfirmasi_selesai' };
  if (jenis === 'misi') {
    if (hasilMisi === 'belum') return null;                 // tampilkan catatan AI, bukan pujian
    return { utama: 'apresiasi', sub: 'konfirmasi_langkah' };
  }
  return null;
}

export function buatMesinPopup({ data, penyimpanan, acak = Math.random }) {
  const store = penyimpanan || adapterMemori();
  const kunci = (siswaId, kategori) => PREFIKS + ':' + siswaId + ':' + kategori;

  function idKategori(kategori) {
    const k = data.kategori[kategori];
    if (!k || !k.pesan.length) throw new Error('KATEGORI_TIDAK_DIKENAL: ' + kategori);
    return k.pesan.map((p) => p.id);
  }
  function baca(siswaId, kategori) {
    const mentah = store.ambil(kunci(siswaId, kategori));
    if (!mentah) return null;
    try {
      const s = JSON.parse(mentah);
      return (s && Array.isArray(s.urutan) && Number.isInteger(s.idx) && s.idx >= 0) ? s : null;
    } catch (e) { return null; }
  }
  function tulis(siswaId, kategori, st) { store.simpan(kunci(siswaId, kategori), JSON.stringify(st)); }

  function mulaiSiklus(ids, idTerakhir, siklus) {
    const urutan = acakFisherYates(ids, acak);
    if (idTerakhir && urutan.length > 1 && urutan[0] === idTerakhir) { // jangan sama dengan kalimat terakhir siklus lalu
      const j = 1 + Math.floor(acak() * (urutan.length - 1));
      const t = urutan[0]; urutan[0] = urutan[j]; urutan[j] = t;
    }
    return { v: data.versi, siklus, urutan, idx: 0 };
  }
  // Jika kumpulan kalimat diperbarui: yang sudah dipakai tetap dianggap terpakai, yang baru masuk sisa siklus.
  function sesuaikan(st, ids) {
    const ada = new Set(ids);
    const sama = st.urutan.length === ids.length && st.urutan.every((id) => ada.has(id));
    if (sama) return st;
    const terpakai = st.urutan.slice(0, st.idx).filter((id) => ada.has(id));
    const sisaLama = st.urutan.slice(st.idx).filter((id) => ada.has(id));
    const baru = ids.filter((id) => !st.urutan.includes(id));
    return { v: data.versi, siklus: st.siklus || 1, urutan: terpakai.concat(acakFisherYates(sisaLama.concat(baru), acak)), idx: terpakai.length };
  }

  function ambil(siswaId, kategori, opsi = {}) {
    if (!siswaId) throw new Error('SISWA_ID_WAJIB');
    const ids = idKategori(kategori);
    let st = baca(siswaId, kategori);
    st = st ? sesuaikan(st, ids) : mulaiSiklus(ids, null, 1);
    if (st.idx >= st.urutan.length) st = mulaiSiklus(ids, st.urutan[st.urutan.length - 1], (st.siklus || 1) + 1);
    const id = st.urutan[st.idx];
    st.idx += 1;
    tulis(siswaId, kategori, st);
    const p = data.kategori[kategori].pesan.find((x) => x.id === id);
    return { id, kategori, siklus: st.siklus, teks: isiTemplat(p.teks, opsi) };
  }

  // Dipanggil SETELAH respons backend diterima. Mengembalikan {utama, sub} atau null.
  function susun(siswaId, konteks, opsi = {}) {
    const rencana = rencanaPopup(konteks);
    if (!rencana) return null;
    return {
      utama: ambil(siswaId, rencana.utama, opsi),
      sub: rencana.sub ? ambil(siswaId, rencana.sub, opsi) : null
    };
  }

  function ringkasan(siswaId) {
    const o = {};
    Object.keys(data.kategori).forEach((kat) => {
      const total = data.kategori[kat].pesan.length;
      const st = baca(siswaId, kat);
      o[kat] = { total, terpakai: st ? Math.min(st.idx, total) : 0, siklus: st ? st.siklus : 0 };
    });
    return o;
  }

  return { ambil, susun, ringkasan };
}
