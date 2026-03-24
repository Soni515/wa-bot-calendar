require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { Client } = require('@notionhq/client');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ================================================================
// INISIALISASI PUSAT
// ================================================================
const notion = new Client({ auth: process.env.NOTION_SECRET });
const databaseId = process.env.NOTION_DATABASE_ID;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const spreadsheetId = process.env.SPREADSHEET_ID;
const NOMOR_SONI = ['6282136111625', '96886526599416'];

const auth = new google.auth.GoogleAuth({
    keyFile: './gen-lang-client-0136086078-4ace5bcc535b.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// ================================================================
// FORMAT TANGGAL & JAM
// ================================================================
function formatTanggal(date) {
    const hari = date.toLocaleDateString('id-ID', { weekday: 'long' });
    const tanggal = date.getDate().toString().padStart(2, '0');
    const bulan = date.toLocaleDateString('id-ID', { month: 'long' });
    return `${hari}, ${tanggal} - ${bulan} - ${date.getFullYear()}`;
}
function formatJam(date) {
    if (!date) return '';
    return `${date.getHours().toString().padStart(2, '0')}.${date.getMinutes().toString().padStart(2, '0')}`;
}
function getDateInfo() {
    const now = new Date();
    return {
        tanggal: now.getDate().toString(),
        bulan: `${now.toLocaleDateString('id-ID', { month: 'long' })}-${now.getFullYear()}`
    };
}

// ================================================================
// FUNGSI NOTION: BACA, TAMBAH, UPDATE, HAPUS
// ================================================================
async function fetchNotionData() {
    let jadwalHarian = [], todoList = [];
    try {
        const response = await notion.databases.query({ database_id: databaseId });
        response.results.forEach(page => {
            const props = page.properties;
            const judul = props['Name']?.title[0]?.plain_text || 'Tanpa Judul';
            const waktuMulai = props['Date']?.date?.start ? new Date(props['Date'].date.start) : null;
            const waktuSelesai = props['Date']?.date?.end ? new Date(props['Date'].date.end) : null;
            const kategori = props['Select']?.select?.name;
            if (waktuMulai) {
                if (kategori === 'Jadwal') jadwalHarian.push({ id: page.id, kegiatan: judul, waktuMulai, waktuSelesai });
                else if (kategori === 'To Do List') todoList.push({ id: page.id, tugas: judul, tenggat: waktuMulai });
            }
        });
        jadwalHarian.sort((a, b) => a.waktuMulai - b.waktuMulai);
        todoList.sort((a, b) => a.tenggat - b.tenggat);
    } catch (e) { console.error('[Notion] Gagal ambil data:', e.message); }
    return { jadwalHarian, todoList };
}
async function addNotionData(judul, waktuMulai, waktuSelesai, kategori) {
    try {
        const props = {
            'Name': { title: [{ text: { content: judul } }] },
            'Select': { select: { name: kategori } }
        };
        if (waktuMulai) props['Date'] = { date: { start: waktuMulai, end: waktuSelesai || null } };
        await notion.pages.create({ parent: { database_id: databaseId }, properties: props });
        return true;
    } catch (e) { console.error('[Notion] Gagal tambah:', e.message); return false; }
}
async function updateNotionWaktu(pageId, waktuMulai, waktuSelesai) {
    try {
        await notion.pages.update({ page_id: pageId, properties: { 'Date': { date: { start: waktuMulai, end: waktuSelesai || null } } } });
        return true;
    } catch (e) { console.error('[Notion] Gagal update:', e.message); return false; }
}
async function deleteNotionData(pageId) {
    try {
        await notion.pages.update({ page_id: pageId, archived: true });
        return true;
    } catch (e) { console.error('[Notion] Gagal hapus:', e.message); return false; }
}
function formatRekap(jadwalHarian, todoList) {
    let teks = '📅 *Jadwal* =\n';
    if (!jadwalHarian.length) teks += '- Kosong!\n\n';
    else {
        const grouped = {};
        jadwalHarian.forEach(item => {
            const tgl = formatTanggal(item.waktuMulai);
            if (!grouped[tgl]) grouped[tgl] = [];
            grouped[tgl].push(item);
        });
        for (const [tgl, items] of Object.entries(grouped)) {
            teks += `${tgl} =\n`;
            items.forEach(k => {
                const akhir = k.waktuSelesai ? ` - ${formatJam(k.waktuSelesai)}` : '';
                teks += `- ${formatJam(k.waktuMulai)}${akhir}: ${k.kegiatan}\n`;
            });
            teks += '\n';
        }
    }
    teks += '📝 *To Do List* =\n';
    if (!todoList.length) teks += '- Kosong!\n';
    else todoList.forEach((todo, i) => { teks += `${i + 1}. ${todo.tugas} ( ${formatTanggal(todo.tenggat)} - ${formatJam(todo.tenggat)} )\n`; });
    return teks;
}

// ================================================================
// FUNGSI GOOGLE SHEETS: TULIS & BACA
// ================================================================
async function appendToSheet(range, values) {
    try {
        await sheets.spreadsheets.values.append({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', requestBody: { values: [values] } });
        return true;
    } catch (e) { console.error('[Sheets] Gagal tulis:', e.message); return false; }
}
async function readSheet(range) {
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        return res.data.values || [];
    } catch (e) { console.error('[Sheets] Gagal baca:', e.message); return []; }
}

// ================================================================
// FASE 1: BACA DATA KEUANGAN + INCOME PER EFFORT PER SUMBER
// Sheet Transaksi: [A=tgl, B=bulan, C=tipe, D=kategori, E=sifat, F=nominal, G=effort_jam, H=ket]
// ================================================================
async function getFinancialSummary() {
    const rows = await readSheet('Transaksi!A:H');
    if (rows.length < 2) return null;

    const { bulan: bulanIni } = getDateInfo();
    let totalIncome = 0, totalExpense = 0, expenseKonsumtif = 0;
    const sumberIncome = {}, sumberExpense = {};
    // [BARU] Track effort per sumber income terpisah
    const effortPerSumber = {}; // { kategori: { income: X, jam: Y } }

    rows.slice(1).forEach(row => {
        const [, bulan, tipe, kategori, sifat, nominalStr, effortStr] = row;
        if (bulan !== bulanIni) return;

        // Bersihkan format mata uang dari Google Sheets ("Rp2.307.000" menjadi "2307000")
        const cleanNominal = String(nominalStr || '0').replace(/Rp/gi, '').replace(/\./g, '').trim().replace(',', '.');
        const nominal = parseFloat(cleanNominal) || 0;

        const cleanEffort = String(effortStr || '0').trim().replace(',', '.');
        const effort = parseFloat(cleanEffort) || 0;

        if (tipe === 'Income') {
            totalIncome += nominal;
            sumberIncome[kategori] = (sumberIncome[kategori] || 0) + nominal;
            // [BARU] Akumulasi effort per sumber income
            if (!effortPerSumber[kategori]) effortPerSumber[kategori] = { income: 0, jam: 0 };
            effortPerSumber[kategori].income += nominal;
            if (effort > 0) effortPerSumber[kategori].jam += effort;
        } else if (tipe === 'Expense') {
            totalExpense += nominal;
            if (sifat === 'Konsumtif') expenseKonsumtif += nominal;
            sumberExpense[kategori] = (sumberExpense[kategori] || 0) + nominal;
        }
    });

    const cashflow = totalIncome - totalExpense;
    const persenKonsumtif = totalExpense > 0 ? Math.round((expenseKonsumtif / totalExpense) * 100) : 0;

    // [BARU] Income per jam per sumber
    const efisiensiPerSumber = Object.entries(effortPerSumber).map(([k, v]) => ({
        sumber: k,
        totalIncome: v.income,
        totalJam: v.jam,
        perJam: v.jam > 0 ? Math.round(v.income / v.jam) : null
    })).sort((a, b) => (b.perJam || 0) - (a.perJam || 0));

    return {
        bulan: bulanIni, totalIncome, totalExpense, cashflow,
        persenKonsumtif,
        sumberIncomeTerbaik: Object.entries(sumberIncome).sort((a, b) => b[1] - a[1]),
        pengeluaranTerbesar: Object.entries(sumberExpense).sort((a, b) => b[1] - a[1]),
        efisiensiPerSumber // [BARU]
    };
}

// ================================================================
// FASE 2: FINANCIAL SCORING + MODE HIDUP
// ================================================================
function calcFinancialScore(summary) {
    if (!summary) return { score: 0, label: 'Tidak Ada Data', mode: 'Survive' };

    // Jika tidak ada transaksi sama sekali di bulan ini
    if (summary.totalIncome === 0 && summary.totalExpense === 0) {
        return { score: 0, label: 'Belum Ada Data', mode: 'Survive' };
    }

    let score = 100;
    if (summary.cashflow < 0) score -= 40;
    else if (summary.cashflow < summary.totalIncome * 0.1) score -= 15;
    if (summary.persenKonsumtif > 70) score -= 25;
    else if (summary.persenKonsumtif > 50) score -= 15;
    else if (summary.persenKonsumtif > 30) score -= 5;
    if (summary.sumberIncomeTerbaik.length === 1) score -= 10;
    // [BARU] Efisiensi income terbaik < 25k/jam
    const bestEfficiency = summary.efisiensiPerSumber[0]?.perJam;
    if (bestEfficiency !== null && bestEfficiency < 25000) score -= 10;
    if (summary.totalIncome === 0) score -= 20;
    score = Math.max(0, Math.min(100, score));

    let label = '', mode = '';
    if (score >= 80) { label = '🟢 Sehat'; mode = 'Scale'; }
    else if (score >= 60) { label = '🟡 Stabil'; mode = 'Growth'; }
    else if (score >= 40) { label = '🟠 Waspada'; mode = 'Stabil'; }
    else { label = '🔴 Kritis'; mode = 'Survive'; }
    return { score, label, mode };
}

// ================================================================
// [BARU] LEAD TRACKER: Baca & Catat Pipeline Klien
// Sheet "Lead Tracker": [A=tgl, B=nama_prospek, C=sumber, D=status, E=follow_up, F=catatan]
// Status: Prospek → Follow Up → Closing → Gagal
// ================================================================
async function fetchLeadTracker() {
    const rows = await readSheet('Lead Tracker!A:F');
    if (rows.length < 2) return [];
    return rows.slice(1).map(row => ({
        tanggal: row[0] || '',
        prospek: row[1] || '',
        sumber: row[2] || '',
        status: row[3] || '',
        followUp: row[4] || '',
        catatan: row[5] || ''
    }));
}

function formatLeadSummary(leads) {
    if (!leads.length) return 'Belum ada lead tercatat.';
    const statusCount = {};
    leads.forEach(l => { statusCount[l.status] = (statusCount[l.status] || 0) + 1; });
    const open = leads.filter(l => !['Closing', 'Gagal'].includes(l.status));
    let teks = `📋 *LEAD PIPELINE*\n`;
    teks += Object.entries(statusCount).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    if (open.length > 0) {
        teks += `\n\n⚡ *Perlu Ditindaklanjuti:*\n`;
        open.slice(0, 5).forEach(l => { teks += `- ${l.prospek} (${l.status}) → ${l.followUp || 'belum ada jadwal follow up'}\n`; });
    }
    return teks;
}

// ================================================================
// FASE 5: DECISION LOG
// Sheet "Decision Log": [A=tgl_bulan, B=keputusan, C=ekspektasi, D=evaluasi]
// ================================================================
async function fetchDecisionLog(batas = 5) {
    const rows = await readSheet('Decision Log!A:D');
    if (rows.length < 2) return [];
    return rows.slice(1).filter(r => r[1]).slice(-batas).map(row => ({
        tanggal: row[0] || '', keputusan: row[1] || '',
        ekspektasi: row[2] || '', evaluasi: row[3] || '(belum dievaluasi)'
    }));
}
function formatDecisionLog(decisions) {
    if (!decisions.length) return 'Belum ada keputusan tercatat.';
    return decisions.map((d, i) =>
        `${i + 1}. [${d.tanggal}] *${d.keputusan}*\n   Ekspektasi: ${d.ekspektasi}\n   Evaluasi: _${d.evaluasi}_`
    ).join('\n\n');
}

// ================================================================
// FASE 3: LAPORAN MINGGUAN YANG MEMAKSA KEPUTUSAN
// ================================================================
let laporanMingguan_terakhir = null;

async function kirimLaporanMingguan(sock) {
    const nomorTujuan = `${NOMOR_SONI[0]}@s.whatsapp.net`;
    const today = new Date();
    const weekKey = `${today.getFullYear()}-W${Math.ceil(today.getDate() / 7)}`;
    if (laporanMingguan_terakhir === weekKey) return;

    const summary = await getFinancialSummary();
    const { score, label, mode } = calcFinancialScore(summary);
    const decisions = await fetchDecisionLog(3);
    const leads = await fetchLeadTracker();
    const openLeads = leads.filter(l => !['Closing', 'Gagal'].includes(l.status));

    let laporan = `📊 *LAPORAN MINGGUAN SONI BOT*\nBulan: ${summary?.bulan || '-'}\n━━━━━━━━━━━━━━━━━━━━━\n\n`;

    laporan += `💰 *CASHFLOW BULAN INI*\n`;
    laporan += `Income : Rp${(summary?.totalIncome || 0).toLocaleString('id-ID')}\n`;
    laporan += `Expense: Rp${(summary?.totalExpense || 0).toLocaleString('id-ID')}\n`;
    laporan += `Net    : ${(summary?.cashflow || 0) >= 0 ? '✅' : '🔴'} Rp${(summary?.cashflow || 0).toLocaleString('id-ID')}\n`;
    laporan += `Konsumtif: ${summary?.persenKonsumtif || 0}%\n`;

    // [BARU] Income per jam per sumber
    if (summary?.efisiensiPerSumber?.length > 0) {
        laporan += `\n⚡ *EFISIENSI INCOME PER SUMBER*\n`;
        summary.efisiensiPerSumber.forEach(e => {
            laporan += `- ${e.sumber}: Rp${e.totalIncome.toLocaleString('id-ID')}`;
            if (e.perJam) laporan += ` (Rp${e.perJam.toLocaleString('id-ID')}/jam)`;
            laporan += '\n';
        });
    }

    laporan += `\n🎯 *FINANCIAL SCORE: ${score}/100 ${label}*\nMode: *${mode}*\n`;

    // [BARU] Lead pipeline update
    if (leads.length > 0) {
        laporan += `\n${formatLeadSummary(leads)}\n`;
        const closing = leads.filter(l => l.status === 'Closing').length;
        const total = leads.length;
        laporan += `📈 Conversion Rate: ${total > 0 ? Math.round((closing / total) * 100) : 0}%\n`;
    }

    // [BARU] Keputusan yang harus dievaluasi (nagih hasil)
    const belumEvaluasi = decisions.filter(d => d.evaluasi === '(belum dievaluasi)');
    if (belumEvaluasi.length > 0) {
        laporan += `\n🧠 *KEPUTUSAN YANG BELUM DIEVALUASI (${belumEvaluasi.length})*\n`;
        belumEvaluasi.forEach((d, i) => { laporan += `${i + 1}. *${d.keputusan}*\n   Ekspektasi: ${d.ekspektasi}\n`; });
        laporan += `\n_Bot perlu tahu: berhasil, gagal, atau tidak jalan? Balas bot dengan evaluasinya._`;
    }

    // [BARU] 3 Keputusan wajib minggu ini
    laporan += `\n\n🔥 *3 KEPUTUSAN WAJIB MINGGU INI*\nBerdasarkan kondisi Mode *${mode}*:\n`;
    if (mode === 'Survive') {
        laporan += `1. ✂️ STOP: Kegiatan konsumtif yang tidak menghasilkan leads\n2. 🎯 FOKUS: Satu aktivitas income dengan RPJ tertinggi\n3. 📞 AKSI: Hubungi 3 prospek lama hari ini juga`;
    } else if (mode === 'Stabil') {
        laporan += `1. 📊 ANALISIS: Bandingkan efisiensi setiap sumber income\n2. 🔁 KURANGI: Aktivitas dengan RPJ terendah di bawah Rp25rb/jam\n3. 🚀 SCALE: Duplikasi workflow income terbaik`;
    } else if (mode === 'Growth') {
        laporan += `1. 💡 INVESTASI: Alokasikan 20% income ke aktivitas produktif baru\n2. 🤝 SISTEM: Buat 1 SOP untuk pekerjaan yang berulang\n3. 🌱 EXPAND: Buka 1 sumber income baru bulan ini`;
    } else {
        laporan += `1. 🏗️ SISTEM: Delegasikan 1 tugas operasional\n2. 📈 PASSIVE: Buat 1 produk/konten yang bisa menghasilkan passive income\n3. 💼 SCALE: Naikkan tarif minimum 20% untuk klien baru`;
    }

    if (openLeads.length > 0) {
        laporan += `\n\n⚡ Jangan lupa follow up ${openLeads.length} lead yang masih terbuka!`;
    }

    await sock.sendMessage(nomorTujuan, { text: laporan });
    laporanMingguan_terakhir = weekKey;
    console.log('[Laporan] Laporan mingguan terkirim.');
}

// ================================================================
// FASE 6: GLOBAL WARNING SYSTEM
// ================================================================
function buildGlobalWarning(summary, scoreData) {
    if (!summary) return '';
    const warnings = [];
    if (summary.cashflow < 0)
        warnings.push(`🔴 CASHFLOW DEFISIT Rp${Math.abs(summary.cashflow).toLocaleString('id-ID')}. Ini bukan fase nongkrong.`);
    if (summary.persenKonsumtif > 50)
        warnings.push(`⚠️ ${summary.persenKonsumtif}% pengeluaran konsumtif. Lebih dari separo uangmu dibakar.`);
    if (summary.sumberIncomeTerbaik.length === 1)
        warnings.push(`⚡ SINGLE INCOME: Semua bergantung pada "${summary.sumberIncomeTerbaik[0]?.[0]}". Jika hilang, kamu habis.`);
    return warnings.join('\n');
}

// ================================================================
// OTAK AI: PROMPT DATA-AWARE + FORCED ACTION + LEAD CONTEXT
// ================================================================
async function analisisPesan(pesan, summary, scoreData, leads) {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        // Bangun konteks keuangan
        let finansialCtx = 'Data keuangan bulan ini: Belum ada data.';
        let scoreCtx = '';
        let leadCtx = '';

        if (summary) {
            const topInc = summary.sumberIncomeTerbaik.slice(0, 3).map(([k, v]) => `${k}: Rp${v.toLocaleString('id-ID')}`).join(', ');
            const topExp = summary.pengeluaranTerbesar.slice(0, 3).map(([k, v]) => `${k}: Rp${v.toLocaleString('id-ID')}`).join(', ');
            const efisiensi = summary.efisiensiPerSumber.map(e =>
                `${e.sumber}: ${e.perJam ? `Rp${e.perJam.toLocaleString('id-ID')}/jam` : 'no data effort'}`
            ).join(' | ');

            finansialCtx = `=== DATA KEUANGAN REAL (${summary.bulan}) ===
- Income  : Rp${summary.totalIncome.toLocaleString('id-ID')}
- Expense : Rp${summary.totalExpense.toLocaleString('id-ID')}
- Cashflow: Rp${summary.cashflow.toLocaleString('id-ID')} (${summary.cashflow >= 0 ? 'SURPLUS' : 'DEFISIT'})
- Konsumtif: ${summary.persenKonsumtif}%
- Sumber Income Terbaik: ${topInc || '-'}
- Pengeluaran Terbesar: ${topExp || '-'}
- Efisiensi (Rp/jam per sumber): ${efisiensi || '-'}`;

            scoreCtx = `=== STATUS KEUANGAN ===
- Score: ${scoreData.score}/100 ${scoreData.label}
- Mode: ${scoreData.mode}
- Arahan Mode ${scoreData.mode}: ${scoreData.mode === 'Survive' ? 'Cut semua non-income. Fokus cash masuk.' : scoreData.mode === 'Stabil' ? 'Pilah efisiensi. Scale yang paling tinggi RPJ.' : scoreData.mode === 'Growth' ? 'Ada surplus. Investasi aktivitas produktif.' : 'Bangun sistem. Delegasi. Passive income.'}`;
        }

        if (leads && leads.length > 0) {
            const openLeads = leads.filter(l => !['Closing', 'Gagal'].includes(l.status));
            leadCtx = `=== LEAD PIPELINE ===
- Total leads: ${leads.length} | Open: ${openLeads.length} | Closing: ${leads.filter(l => l.status === 'Closing').length}
- Lead yang perlu follow up: ${openLeads.map(l => l.prospek).join(', ') || 'tidak ada'}`;
        }

        const prompt = `Kamu adalah asisten AI pribadi Soni, bernama Soni Bot.
Waktu saat ini: ${now} (WIB). Gunakan ini sebagai patokan untuk "besok", "nanti", dll.

${finansialCtx}

${scoreCtx}

${leadCtx}

=== TUGAS UTAMA ===
Analisa pesan Soni, tentukan SATU aksi, dan berikan arahan KONKRET berbasis data nyata di atas.

=== KATEGORI AKSI ===
- READ_SCHEDULE    : Minta lihat jadwal/todo
- ADD_SCHEDULE     : Tambah jadwal/kegiatan
- ADD_TODO         : Tambah tugas/to-do
- RESCHEDULE       : Ubah waktu jadwal/tugas
- DELETE           : Hapus jadwal/tugas
- ADD_FINANCE      : Catat pemasukan/pengeluaran
- ADD_DECISION     : Catat keputusan strategis
- EVALUATE_DECISION: Soni mengevaluasi keputusan lama (berhasil/gagal/tidak jalan)
- ADD_LEAD         : Tambah lead/prospek klien baru
- UPDATE_LEAD      : Update status lead (follow up, closing, gagal)
- READ_LEADS       : Minta lihat pipeline lead
- CHAT             : Konsultasi/obrolan biasa

=== PERAN FINANCIAL ADVISOR (TEGAS, DATA-BASED) ===
Kamu BUKAN motivator. Setiap respons WAJIB ada arahan "Fokus/Kurangi/Stop".

JIKA ADD_SCHEDULE/ADD_TODO: Evaluasi dampak cashflow. Jika konsumtif, sebutkan angka aktualnya.
JIKA ADD_FINANCE: Berikan insight singkat tentang perubahan kondisi keuangan berdasarkan data.
JIKA ADD_LEAD/UPDATE_LEAD: Komentari conversion rate dan efektivitas pipeline.
JIKA EVALUATE_DECISION: Ekstrak nama keputusan dan hasil evaluasinya.
JIKA CHAT: Gunakan DATA NYATA. Jangan asumsi. Struktur: Kondisi → Temuan → Aksi (max 3) → Pertanyaan kritis.

=== FORMAT OUTPUT (JSON VALID, TANPA MARKDOWN) ===
{
  "action": "<SALAH SATU AKSI>",
  "financial_warning": "<Teguran berbasis data, atau ''>",
  "forced_action": {
    "fokus": "<1 hal yang harus dikerjakan sekarang>",
    "kurangi": "<1 hal yang harus dikurangi>",
    "stop": "<1 hal yang harus dihentikan segera>"
  },
  "data": {
    // ADD_SCHEDULE     : "kegiatan" (str), "waktuMulai" (ISO8601), "waktuSelesai" (ISO8601/null)
    // ADD_TODO         : "tugas" (str), "tenggat" (ISO8601/null)
    // RESCHEDULE       : "keywords" (str), "waktuMulaiBaru" (ISO8601), "waktuSelesaiBaru" (ISO8601/null)
    // DELETE           : "keywords" (str)
    // ADD_FINANCE      : "tipe" ("Income"/"Expense"), "sifat" (str/null), "kategori" (str), "nominal" (number), "effort_jam" (number), "keterangan" (str)
    // ADD_DECISION     : "keputusan" (str), "dampak" (str)
    // EVALUATE_DECISION: "keywords" (str, kata kunci keputusan), "hasil" ("Berhasil"/"Gagal"/"Tidak Jalan"), "catatan" (str)
    // ADD_LEAD         : "prospek" (str), "sumber" (str), "status" ("Prospek"), "followUp" (str), "catatan" (str)
    // UPDATE_LEAD      : "keywords" (str, nama prospek), "status" ("Follow Up"/"Closing"/"Gagal"), "catatan" (str)
    // CHAT/READ_SCHEDULE/READ_LEADS: "reply" (str)
  }
}

Pesan Soni: "${pesan}"`;

        const result = await model.generateContent(prompt);
        let teks = result.response.text().trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
        return JSON.parse(teks);
    } catch (e) {
        console.error('[Gemini] Error:', e.message);
        return { action: 'CHAT', financial_warning: '', forced_action: null, data: { reply: 'Maaf, otak AI-ku lagi sibuk. Coba lagi sebentar.' } };
    }
}

// ================================================================
// SISTEM PENGINGAT NOTION (H-30, H-15, H-5)
// ================================================================
let sudahDiingatkan = new Set();
let intervalPengingat = null;
let intervalLaporan = null;

function jalankanPengingat(sock) {
    const nomorTujuan = `${NOMOR_SONI[0]}@s.whatsapp.net`;
    if (intervalPengingat) clearInterval(intervalPengingat);
    console.log('⏰ Sistem pengingat aktif...');
    intervalPengingat = setInterval(async () => {
        try {
            const { jadwalHarian, todoList } = await fetchNotionData();
            const sekarang = new Date();
            const items = [
                ...jadwalHarian.map(i => ({ id: i.id, tipe: 'Jadwal', nama: i.kegiatan, waktu: i.waktuMulai, waktuSelesai: i.waktuSelesai })),
                ...todoList.map(i => ({ id: i.id, tipe: 'To Do List', nama: i.tugas, waktu: i.tenggat, waktuSelesai: null }))
            ];
            for (const item of items) {
                if (!item.waktu) continue;

                // --- AUTO HAPUS JIKA SUDAH TERLEWAT ---
                const waktuBatas = item.waktuSelesai ? item.waktuSelesai : item.waktu;
                const terlewatMenit = Math.round((sekarang.getTime() - waktuBatas.getTime()) / 60000);
                
                // Menghapus item jika sudah lewat 60 menit dari jadwal agar kegiatan yang sedang berjalan tidak hilang tiba-tiba
                if (terlewatMenit >= 60) {
                    await deleteNotionData(item.id);
                    console.log(`[Auto Delete] Menghapus ${item.tipe} yang sudah kedaluwarsa: ${item.nama}`);
                    continue; // Lanjut ke item berikutnya karena ini sudah dihapus
                }

                const mn = Math.round((item.waktu.getTime() - sekarang.getTime()) / 60000);
                let wr = null;
                if (mn >= 29 && mn <= 31 && !sudahDiingatkan.has(`${item.id}-30`)) wr = 30;
                else if (mn >= 14 && mn <= 16 && !sudahDiingatkan.has(`${item.id}-15`)) wr = 15;
                else if (mn >= 4 && mn <= 6 && !sudahDiingatkan.has(`${item.id}-5`)) wr = 5;
                if (wr !== null) {
                    sudahDiingatkan.add(`${item.id}-${wr}`);
                    await sock.sendMessage(nomorTujuan, { text: `🔔 *PENGINGAT ${item.tipe.toUpperCase()}*\n\n📌 *${item.nama}*\n⏰ ${wr} menit lagi (${formatJam(item.waktu)}).` });
                }
            }
        } catch (e) { console.error('[Reminder] Error:', e.message); }
    }, 60000);
}

function jalankanLaporanMingguan(sock) {
    if (intervalLaporan) clearInterval(intervalLaporan);
    console.log('📊 Sistem laporan mingguan aktif...');
    intervalLaporan = setInterval(async () => {
        const now = new Date();
        if (now.getDay() === 1 && now.getHours() === 8) await kirimLaporanMingguan(sock);
    }, 3600000);
}

// ================================================================
// INISIALISASI & EVENT HANDLER BAILEYS
// ================================================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys_v4');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[BOT V4] WA Web v${version.join('.')}`);

    const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ['Soni Bot V4', 'Chrome', '1.0.0'] });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { qrcode.generate(qr, { small: true }); console.log('👆 Scan QR Code Bot V4!'); }
        if (connection === 'close') {
            const ok = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (ok) setTimeout(startBot, 2000);
        } else if (connection === 'open') {
            console.log('✅ Bot V4 READY! (Jadwal + Finance + Lead Tracker + AI Advisor)');
            jalankanPengingat(sock);
            jalankanLaporanMingguan(sock);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const pesanTeks = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!pesanTeks) return;

        const senderJid = msg.key.participant || msg.key.remoteJid;
        if (!NOMOR_SONI.some(n => senderJid.startsWith(n))) return;

        const pengirim = msg.key.remoteJid;
        console.log(`[Pesan Masuk] ${pesanTeks}`);
        await sock.sendPresenceUpdate('composing', pengirim);

        // Ambil semua konteks sebelum panggil AI
        const [summary, leads] = await Promise.all([getFinancialSummary(), fetchLeadTracker()]);
        const scoreData = calcFinancialScore(summary);
        const globalWarning = buildGlobalWarning(summary, scoreData);

        const { action, data, financial_warning: warningAI, forced_action } = await analisisPesan(pesanTeks, summary, scoreData, leads);

        const finalWarning = [warningAI, globalWarning].filter(w => w?.trim()).join('\n');

        // Format footer: warning + forced action directive
        const buildFooter = (teks) => {
            let footer = teks;
            if (finalWarning) footer += `\n\n💡 *Financial Advisor:*\n${finalWarning}`;
            if (forced_action && (forced_action.fokus || forced_action.kurangi || forced_action.stop)) {
                footer += `\n\n🎯 *Arahan Minggu Ini:*`;
                if (forced_action.fokus) footer += `\n✅ Fokus: ${forced_action.fokus}`;
                if (forced_action.kurangi) footer += `\n⬇️ Kurangi: ${forced_action.kurangi}`;
                if (forced_action.stop) footer += `\n🛑 Stop: ${forced_action.stop}`;
            }
            return footer;
        };

        // ── ROUTING AKSI ──
        if (action === 'READ_SCHEDULE') {
            const { jadwalHarian, todoList } = await fetchNotionData();
            const rekap = formatRekap(jadwalHarian, todoList);
            await sock.sendMessage(pengirim, { text: buildFooter(data.reply ? `${data.reply}\n\n${rekap}` : rekap) });
        }
        else if (action === 'ADD_SCHEDULE') {
            const ok = await addNotionData(data.kegiatan, data.waktuMulai, data.waktuSelesai, 'Jadwal');
            await sock.sendMessage(pengirim, { text: buildFooter(ok ? `📅 *Jadwal ditambahkan!*\n${data.kegiatan}` : '❌ Gagal tambah jadwal ke Notion.') });
        }
        else if (action === 'ADD_TODO') {
            const ok = await addNotionData(data.tugas, data.tenggat, null, 'To Do List');
            await sock.sendMessage(pengirim, { text: buildFooter(ok ? `📝 *To Do ditambahkan!*\n${data.tugas}` : '❌ Gagal tambah To Do ke Notion.') });
        }
        else if (action === 'RESCHEDULE' || action === 'DELETE') {
            const { jadwalHarian, todoList } = await fetchNotionData();
            const semuaItem = [...jadwalHarian.map(i => ({ id: i.id, nama: i.kegiatan })), ...todoList.map(i => ({ id: i.id, nama: i.tugas }))];
            const target = semuaItem.find(i => i.nama.toLowerCase().includes((data.keywords || '').toLowerCase()));
            if (!target) {
                await sock.sendMessage(pengirim, { text: `❌ Tidak ditemukan item dengan kata kunci: *"${data.keywords}"*` });
            } else if (action === 'DELETE') {
                const ok = await deleteNotionData(target.id);
                await sock.sendMessage(pengirim, { text: buildFooter(ok ? `🗑️ Dihapus: *${target.nama}*` : '❌ Gagal hapus.') });
            } else {
                const ok = await updateNotionWaktu(target.id, data.waktuMulaiBaru, data.waktuSelesaiBaru);
                await sock.sendMessage(pengirim, { text: buildFooter(ok ? `🔄 Di-reschedule: *${target.nama}*` : '❌ Gagal reschedule.') });
            }
        }
        else if (action === 'ADD_FINANCE') {
            const { tanggal, bulan } = getDateInfo();
            const baris = [tanggal, bulan, data.tipe, data.kategori, data.sifat || '', data.nominal, data.effort_jam || 0, data.keterangan || ''];
            const ok = await appendToSheet('Transaksi!A:H', baris);
            if (ok) {
                let teks = `💰 *${data.tipe} Rp${Number(data.nominal).toLocaleString('id-ID')}* tercatat!\nKategori: ${data.kategori}`;
                if (data.tipe === 'Expense') teks += `\nSifat: ${data.sifat}`;
                if (data.tipe === 'Income' && data.effort_jam > 0) teks += `\n⚡ Rp${Math.round(data.nominal / data.effort_jam).toLocaleString('id-ID')}/jam`;
                teks += `\n📊 Score: *${scoreData.score}/100* ${scoreData.label} (${scoreData.mode})`;
                await sock.sendMessage(pengirim, { text: buildFooter(teks) });
            } else {
                await sock.sendMessage(pengirim, { text: '❌ Gagal catat keuangan.' });
            }
        }
        else if (action === 'ADD_DECISION') {
            const { tanggal, bulan } = getDateInfo();
            const ok = await appendToSheet('Decision Log!A:D', [`${tanggal} ${bulan}`, data.keputusan, data.dampak, '']);
            await sock.sendMessage(pengirim, { text: buildFooter(ok ? `🧠 *Keputusan Dicatat!*\nEkspektasi: ${data.dampak}\n_Di-follow-up di laporan mingguan._` : '❌ Gagal catat keputusan.') });
        }
        // [BARU] Evaluasi keputusan lama
        else if (action === 'EVALUATE_DECISION') {
            const decisionRows = await readSheet('Decision Log!A:D');
            const keyword = (data.keywords || '').toLowerCase();
            // Cari baris yang cocok (index sheet adalah 1-based, row index adalah 0-based tapi ada header)
            let targetRowIdx = -1;
            decisionRows.slice(1).forEach((row, i) => {
                if (row[1]?.toLowerCase().includes(keyword)) targetRowIdx = i + 2; // +2: header + 1-indexed
            });
            if (targetRowIdx === -1) {
                await sock.sendMessage(pengirim, { text: `❌ Tidak ditemukan keputusan dengan kata kunci: "${data.keywords}"` });
            } else {
                const ok = await sheets.spreadsheets.values.update({
                    spreadsheetId, range: `Decision Log!D${targetRowIdx}`,
                    valueInputOption: 'USER_ENTERED', requestBody: { values: [[`${data.hasil}: ${data.catatan || ''}`]] }
                }).then(() => true).catch(() => false);
                await sock.sendMessage(pengirim, { text: buildFooter(ok ? `✅ Evaluasi dicatat!\nStatus: *${data.hasil}*\nCatatan: ${data.catatan}` : '❌ Gagal update evaluasi.') });
            }
        }
        // [BARU] Lead tracker actions
        else if (action === 'ADD_LEAD') {
            const { tanggal, bulan } = getDateInfo();
            const ok = await appendToSheet('Lead Tracker!A:F', [`${tanggal} ${bulan}`, data.prospek, data.sumber || '', 'Prospek', data.followUp || '', data.catatan || '']);
            await sock.sendMessage(pengirim, { text: buildFooter(ok ? `🎯 *Lead baru dicatat!*\nProspek: *${data.prospek}*\nSumber: ${data.sumber || '-'}\nFollow Up: ${data.followUp || 'belum dijadwalkan'}` : '❌ Gagal catat lead.') });
        }
        else if (action === 'UPDATE_LEAD') {
            const leadRows = await readSheet('Lead Tracker!A:F');
            const keyword = (data.keywords || '').toLowerCase();
            let targetRowIdx = -1;
            leadRows.slice(1).forEach((row, i) => {
                if (row[1]?.toLowerCase().includes(keyword)) targetRowIdx = i + 2;
            });
            if (targetRowIdx === -1) {
                await sock.sendMessage(pengirim, { text: `❌ Tidak ditemukan lead dengan nama: "${data.keywords}"` });
            } else {
                const ok = await sheets.spreadsheets.values.update({
                    spreadsheetId, range: `Lead Tracker!D${targetRowIdx}:F${targetRowIdx}`,
                    valueInputOption: 'USER_ENTERED', requestBody: { values: [[data.status, '', data.catatan || '']] }
                }).then(() => true).catch(() => false);
                const emoji = data.status === 'Closing' ? '🎉' : data.status === 'Gagal' ? '❌' : '🔄';
                await sock.sendMessage(pengirim, { text: buildFooter(`${emoji} Lead di-update!\n*${data.keywords}* → *${data.status}*`) });
            }
        }
        else if (action === 'READ_LEADS') {
            const allLeads = await fetchLeadTracker();
            await sock.sendMessage(pengirim, { text: buildFooter(formatLeadSummary(allLeads)) });
        }
        else {
            // CHAT — data-aware AI advisor
            await sock.sendMessage(pengirim, { text: buildFooter(data.reply || 'Oke, noted!') });
        }
    });
}

startBot();
