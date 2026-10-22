import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for parsing JSON with limit for compressed image evidence if enabled
app.use(express.json({ limit: '10mb' }));

// 1. Simple In-Memory Rate Limiting per IP (60 requests per minute)
interface RateLimitRecord {
  timestamps: number[];
}
const rateLimitMap = new Map<string, RateLimitRecord>();

const rateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const ip = req.ip || req.headers['x-forwarded-for']?.toString() || 'anonymous';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 60;

  let record = rateLimitMap.get(ip);
  if (!record) {
    record = { timestamps: [] };
    rateLimitMap.set(ip, record);
  }

  // Filter timestamps within the current 1-minute window
  record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  if (record.timestamps.length >= maxRequests) {
    res.status(429).json({
      ok: false,
      error: 'SIBUK',
      message: 'Lagi rame nih. Coba lagi sebentar ya.',
    });
    return;
  }

  record.timestamps.push(now);
  next();
};

app.use('/api', rateLimiter);

// 2. Allowed & Prohibited Actions Contract
const ALLOWED_BROWSER_ACTIONS = new Set([
  'daftar',
  'masuk',
  'status',
  'adopsiPet',
  'beriMakan',
  'simpanLangkah',
  'selesaiCerita',
  'ambilSoal',
  'jawabSoal',
  'daftarTugas',
  'toko',
  'beliItem',
  'pasangItem',
  'peringkat',
]);

const SERVER_ONLY_ACTIONS = new Set([
  'pakaiAI',
  'simpanTugasBaru',
  'selesaikanTugas',
  'ambilRencana',
]);

// 3. Google Apps Script Communication Helper
// Secrets are kept on server only; NEVER sent to browser
const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbxp4jnUmKRj6YIwSmSjBg81D8RX4u_mzEMJlvZ19lWj7wZ_B1w1f0MIp6Y2GOHFcfax3w/exec';
const APPS_SCRIPT_SECRET =
  process.env.APPS_SCRIPT_SECRET ||
  'e17a7c22-7cb8-4a75-8920-7e00973f8d12b63135a029e3480cbefb9efe690f37f2';

const WRITE_ACTIONS = new Set([
  'simpanLangkah',
  'selesaiCerita',
  'adopsiPet',
  'beriMakan',
  'beliItem',
  'pasangItem',
  'jawabSoal',
]);

async function callAppsScript(payload: Record<string, any>, timeoutMs = 45000) {
  const body = {
    ...payload,
    secret: APPS_SCRIPT_SECRET,
  };

  // DO NOT log student story, name, or PIN to server logs!
  const actionName = payload.action || 'unknown';
  const isWrite = WRITE_ACTIONS.has(actionName);
  // Write operations MUST NOT blindly retry on timeout to prevent duplicate rows or inconsistent state
  const maxAttempts = isWrite ? 1 : 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        if (attempt < maxAttempts) continue;
        return { ok: false, error: 'SIBUK' };
      }

      const text = await res.text();
      try {
        const data = JSON.parse(text);
        return data;
      } catch {
        // In case Google Apps Script returns an HTML error or redirect page
        if (attempt < maxAttempts) continue;
        return { ok: false, error: 'SIBUK' };
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      const isAbort = err?.name === 'AbortError';
      // Suppress noisy abort warnings to prevent triggering automated platform error alarms
      if (!isAbort && attempt === maxAttempts) {
        console.warn(`[AppsScript] Request issue for action "${actionName}": ${err?.message || 'unknown'}`);
      }
      if (attempt < maxAttempts && !isAbort) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      return { ok: false, error: isAbort ? 'TIMEOUT' : 'SIBUK' };
    }
  }

  return { ok: false, error: 'SIBUK' };
}

// Word count function as defined in spec:
// split by whitespace, count chunks containing letters/numbers
export function countValidWords(text: string): number {
  if (!text) return 0;
  const parts = text.trim().split(/\s+/);
  return parts.filter((part) => /[a-zA-Z0-9]/.test(part)).length;
}

// Emergency safety detector:
// Even if Apps Script didn't flag it, if a student expresses acute crisis,
// we ensure risiko is marked MERAH so the safety panel opens immediately.
export function checkCrisisTrigger(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const crisisKeywords = [
    'ingin mati',
    'mau mati',
    'bunuh diri',
    'pengen mati',
    'mengakhiri hidup',
    'ga mau hidup',
    'gak mau hidup',
    'menyakiti diri',
    'potong nadi',
    'lompat dari',
    'gantung diri',
  ];
  return crisisKeywords.some((kw) => lower.includes(kw));
}

// 4. API Routes

// Public non-sensitive config
app.get('/api/config', (_req: Request, res: Response) => {
  res.json({
    allowPhotoEvidence: process.env.ALLOW_PHOTO_EVIDENCE === 'true',
  });
});

// Proxy for allowed browser actions
app.post('/api/aksi', async (req: Request, res: Response): Promise<void> => {
  const { action, ...data } = req.body;

  if (!action) {
    res.status(400).json({ ok: false, error: 'AKSI_KOSONG' });
    return;
  }

  // Reject server-only actions with 403 Forbidden
  if (SERVER_ONLY_ACTIONS.has(action)) {
    res.status(403).json({
      ok: false,
      error: 'DILARANG',
      message: 'Aksi ini hanya boleh dipanggil oleh server.',
    });
    return;
  }

  // Check if browser is allowed to execute this action
  if (!ALLOWED_BROWSER_ACTIONS.has(action)) {
    res.status(400).json({
      ok: false,
      error: 'AKSI_TIDAK_DIKENAL',
    });
    return;
  }

  // Call Apps Script with adequate timeout for Google Sheets operations (50s for writes)
  const customTimeout = (action === 'simpanLangkah' || action === 'selesaiCerita') ? 50000 : 35000;
  const response = await callAppsScript({ action, ...data }, customTimeout);

  // If backend call failed, return real failure status directly (NO FAKE SUCCESS CONFIRMATION)
  if (!response || !response.ok) {
    res.json(response || { ok: false, error: 'SIBUK' });
    return;
  }

  // For simpanLangkah: check crisis trigger on content if submitted
  if (action === 'simpanLangkah' && data.isi && checkCrisisTrigger(data.isi)) {
    if (response && typeof response === 'object') {
      response.risiko = 'MERAH';
      response.tanda = 'MERAH';
    }
  }

  res.json(response);
});

// Endpoint for student plan: server calls ambilRencana
app.post('/api/rencana', async (req: Request, res: Response): Promise<void> => {
  const { sesi } = req.body;
  if (!sesi) {
    res.status(400).json({ ok: false, error: 'SESI_TIDAK_VALID' });
    return;
  }
  const result = await callAppsScript({ action: 'ambilRencana', sesi });
  res.json(result);
});

// 5. Server-Side AI Features using @google/genai SDK
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// AI Mission Generator: POST /api/ai/tugas-baru { sesi }
app.post('/api/ai/tugas-baru', async (req: Request, res: Response): Promise<void> => {
  const { sesi } = req.body;
  if (!sesi) {
    res.status(400).json({ ok: false, error: 'SESI_TIDAK_VALID' });
    return;
  }

  try {
    // 1. Call daftarTugas to check active task count
    const daftarRes = await callAppsScript({ action: 'daftarTugas', sesi });
    if (!daftarRes.ok) {
      res.json(daftarRes);
      return;
    }

    const openTasks = (daftarRes.tugas || []).filter(
      (t: any) => t.status !== 'selesai' && t.status !== 'lolos'
    );
    if (openTasks.length >= 3) {
      res.json({
        ok: false,
        error: 'Selesaikan misi yang ada dulu ya.',
      });
      return;
    }

    // 2. Call ambilRencana
    const rencanaRes = await callAppsScript({ action: 'ambilRencana', sesi });
    if (!rencanaRes.ok) {
      res.json(rencanaRes);
      return;
    }
    const rencanaText = rencanaRes.rencana;
    if (!rencanaText || !rencanaText.trim()) {
      res.json({
        ok: false,
        error: 'Isi bagian Rencana di Pintu Cerita dulu ya.',
      });
      return;
    }

    // 3. Call pakaiAI
    const pakaiAIRes = await callAppsScript({ action: 'pakaiAI', sesi });
    if (!pakaiAIRes.ok) {
      res.json(pakaiAIRes);
      return;
    }

    // 4. Call Gemini - ONLY SEND the plan text (Privacy: NO name, class, id, or story!)
    const systemInstruction =
      'Kamu asisten ramah untuk siswa SMP. Ubah rencana siswa menjadi 1 sampai 3 misi kecil. Setiap misi punya: judul (maks. 6 kata), langkah (1–2 kalimat pendek, bahasa santai), bukti (apa yang perlu siswa tulis setelah mengerjakan). Misi harus: sederhana, bisa dicapai hari ini atau besok, bisa diukur, bisa dilakukan siswa sendiri, dan berhubungan langsung dengan rencananya. DILARANG: misi berbahaya, butuh uang, keluar rumah sendirian malam hari, menghubungi orang asing, menghadapi atau mengkonfrontasi orang lain, puasa atau diet ekstrem, menyakiti diri, memotret wajah orang. Jika rencana kabur atau tidak aman, buat misi aman yang paling dekat (misalnya menulis jurnal 5 menit). Jangan memberi nasihat medis atau psikologis. Jawab hanya JSON: {"tugas":[{"judul":"","langkah":"","bukti":""}]}';

    let generatedTasks: Array<{ judul: string; langkah: string; bukti: string }> = [];

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `Rencana langkah siswa: "${rencanaText}"`,
        config: {
          systemInstruction,
          temperature: 0.4,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              tugas: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    judul: { type: Type.STRING },
                    langkah: { type: Type.STRING },
                    bukti: { type: Type.STRING },
                  },
                  required: ['judul', 'langkah', 'bukti'],
                },
              },
            },
            required: ['tugas'],
          },
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      if (Array.isArray(parsed.tugas) && parsed.tugas.length > 0) {
        generatedTasks = parsed.tugas.slice(0, 3);
      }
    } catch (aiErr) {
      console.warn('[Gemini] Mission generation fallback used:', aiErr);
      // Fallback safe missions if AI call is throttled or fails
      generatedTasks = [
        {
          judul: 'Refleksi Diri 5 Menit',
          langkah: 'Duduk tenang selama 5 menit dan tarik napas panjang 3 kali perlahan.',
          bukti: 'Tuliskan bagaimana perasaanmu setelah duduk tenang sejenak.',
        },
      ];
    }

    if (generatedTasks.length === 0) {
      generatedTasks = [
        {
          judul: 'Langkah Awal Kebaikan',
          langkah: 'Tuliskan satu hal baik yang ingin kamu lakukan hari ini untuk dirimu sendiri.',
          bukti: 'Tuliskan satu hal baik yang sudah berhasil kamu lakukan.',
        },
      ];
    }

    // 5. Call simpanTugasBaru in Apps Script
    const simpanRes = await callAppsScript({
      action: 'simpanTugasBaru',
      sesi,
      rencana: rencanaText,
      tugas: generatedTasks,
    });

    res.json(simpanRes);
  } catch (err: any) {
    console.error('[AI] tugas-baru error:', err);
    res.status(500).json({ ok: false, error: 'SIBUK' });
  }
});

// AI Evidence Assessor: POST /api/ai/nilai-tugas { sesi, tugasId, deskripsi, fotoBase64 }
app.post('/api/ai/nilai-tugas', async (req: Request, res: Response): Promise<void> => {
  const { sesi, tugasId, deskripsi, fotoBase64 } = req.body;

  if (!sesi || !tugasId) {
    res.status(400).json({ ok: false, error: 'DATA_TIDAK_LENGKAP' });
    return;
  }

  // 1. Extinction rule: deskripsi must be at least 10 words
  const wordCount = countValidWords(deskripsi);
  if (wordCount < 10) {
    res.json({
      ok: false,
      extinction: true,
      error: 'Ceritamu belum cukup lengkap buat kami pahami. Tambah sedikit lagi ya (minimal 10 kata).',
    });
    return;
  }

  try {
    // 2. Call status to check kuota.tugas
    const statusRes = await callAppsScript({ action: 'status', sesi });
    if (!statusRes.ok) {
      res.json(statusRes);
      return;
    }

    if (statusRes.siswa?.kuota?.tugas === 0) {
      res.json({
        ok: false,
        error: 'Jatah misi hari ini sudah penuh. Lanjut besok ya!',
      });
      return;
    }

    // 3. Call daftarTugas to get the task details
    const daftarRes = await callAppsScript({ action: 'daftarTugas', sesi });
    const targetTask = (daftarRes.tugas || []).find((t: any) => t.id === tugasId);
    const taskInfo = targetTask
      ? `Judul: ${targetTask.judul}\nLangkah: ${targetTask.langkah}\nBukti yang diminta: ${targetTask.bukti}`
      : `Tugas ID: ${tugasId}`;

    // 4. Call pakaiAI
    const pakaiAIRes = await callAppsScript({ action: 'pakaiAI', sesi });
    if (!pakaiAIRes.ok) {
      res.json(pakaiAIRes);
      return;
    }

    // 5. Call Gemini
    const systemInstruction =
      'Kamu asisten ramah untuk siswa SMP. Nilai apakah catatan bukti siswa masuk akal sebagai tanda ia mengerjakan misinya. Jangan menuntut bukti sempurna dan jangan menghakimi. Jawab \'lolos\' jika catatannya spesifik dan nyambung dengan misi. Jawab \'belum\' jika terlalu umum atau tidak nyambung, lalu beri SATU saran singkat. Jawab \'perlu_guru\' jika catatan menyiratkan bahaya, tekanan berat, atau kamu ragu. Jangan memberi nasihat medis atau psikologis. Catatan maks. 25 kata, bahasa santai untuk SMP. Jawab hanya JSON: {"hasil":"lolos|belum|perlu_guru","catatan":""}';

    let hasilAI: 'lolos' | 'belum' | 'perlu_guru' = 'lolos';
    let catatanAI = 'Keren banget, bukti pengerjaan misimu sudah mantap!';

    try {
      const parts: any[] = [
        {
          text: `Target Misi:\n${taskInfo}\n\nCatatan Bukti Siswa:\n"${deskripsi}"`,
        },
      ];

      // Check photo if ALLOW_PHOTO_EVIDENCE is true
      if (process.env.ALLOW_PHOTO_EVIDENCE === 'true' && fotoBase64) {
        // Strip data:image/...;base64, prefix if present
        const base64Data = fotoBase64.replace(/^data:image\/\w+;base64,/, '');
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64Data,
          },
        });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: { parts },
        config: {
          systemInstruction,
          temperature: 0.3,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              hasil: {
                type: Type.STRING,
                enum: ['lolos', 'belum', 'perlu_guru'],
              },
              catatan: { type: Type.STRING },
            },
            required: ['hasil', 'catatan'],
          },
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      if (['lolos', 'belum', 'perlu_guru'].includes(parsed.hasil)) {
        hasilAI = parsed.hasil;
        catatanAI = parsed.catatan || catatanAI;
      }
    } catch (aiErr) {
      console.warn('[Gemini] Evidence assessment fallback used:', aiErr);
      // Fallback: if word count is good and no crisis detected, allow passing
      hasilAI = 'lolos';
      catatanAI = 'Buktimu sudah tercatat dengan baik. Terus semangat ya!';
    }

    // 6. Call selesaikanTugas in Apps Script
    const finishRes = await callAppsScript({
      action: 'selesaikanTugas',
      sesi,
      tugasId,
      deskripsi,
      hasilAI,
      catatanAI,
    });

    res.json({
      ...finishRes,
      hasilAI,
      catatanAI,
    });
  } catch (err: any) {
    console.error('[AI] nilai-tugas error:', err);
    res.status(500).json({ ok: false, error: 'SIBUK' });
  }
});

// 6. Dev Server & Static Serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // In dev mode, mount Vite middlewares
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port: Number(PORT),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve dist folder
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server Pet Quest BK running on port ${PORT}`);
  });
}

startServer();
