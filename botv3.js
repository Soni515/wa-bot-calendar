require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- INISIALISASI API ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const spreadsheetId = process.env.SPREADSHEET_ID;

// Autentikasi Google Sheets pakai file credentials.json
const auth = new google.auth.GoogleAuth({
    keyFile: './gen-lang-client-0136086078-4ace5bcc535b.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// --- HELPER FORMAT TANGGAL ---
function getDateInfo() {
    const now = new Date();
    // Tanggal format Soni: "21"
    const tanggal = now.getDate().toString();
    // Bulan format Soni: "Maret-2026"
    const bulanNama = now.toLocaleDateString('id-ID', { month: 'long' });
    const tahun = now.getFullYear();
    const bulan = `${bulanNama}-${tahun}`;
    return { tanggal, bulan };
}

// --- FUNGSI TULIS KE SPREADSHEET ---
async function appendToSheet(range, values) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: range, // Nama sheet (tab), misal: 'Transaksi'
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [values] },
        });
        return true;
    } catch (error) {
        console.error("Gagal menulis ke Sheets:", error);
        return false;
    }
}

// --- FUNGSI AI PARSER (GEMINI) ---
async function prosesPesan(pesan) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const systemPrompt = `Kamu adalah asisten pribadi Soni. Analisa pesan ini: "${pesan}"
    
    ATURAN 1 (JIKA PESAN ADALAH PENGELUARAN / PEMASUKAN):
    Balas HANYA dengan JSON murni (tanpa markdown \`\`\`) format berikut:
    {"is_finance": true, "jenis": "transaksi", "tipe": "Income" atau "Expense", "sifat": "Konsumtif" atau "Netral" atau "Produktif" (kosongkan jika Income), "kategori": "Kategori singkat (misal Makan, Freelance)", "nominal": angka (tanpa titik/koma), "effort_jam": angka (tebak jika ada, default 0), "keterangan": "keterangan singkat"}
    
    ATURAN 2 (JIKA PESAN ADALAH KEPUTUSAN / STRATEGI):
    Balas HANYA dengan JSON murni format berikut:
    {"is_finance": true, "jenis": "keputusan", "keputusan": "Inti keputusan", "dampak": "Ekspektasi dampaknya"}
    
    ATURAN 3 (JIKA PESAN BERTANYA/NGOBROL BIASA/KONSULTASI):
    Balas LANGSUNG dengan teks (JANGAN PAKAI JSON).
    Saat membalas teks biasa, kamu BUKAN lagi asisten ramah biasa. Kamu sekarang adalah FINANCIAL ADVISOR berbasis data yang TEGAS, LOGIS, dan BUKAN MOTIVATOR.
    
    Tugas utama kamu:
    * Menganalisis kondisi keuangan Soni dari data yang ada di chat
    * Memberikan saran yang realistis, spesifik, dan actionable
    * Mengkritisi keputusan keuangannya jika tidak rasional
    * Fokus pada peningkatan income dan efisiensi penggunaan uang
    
    JANGAN DILAKUKAN:
    * Memberikan saran umum tanpa analisis data
    * Menghibur atau menenangkan Soni tanpa alasan logis
    * Menggunakan bahasa normatif seperti "sebaiknya lebih hemat" tanpa angka
    
    1. INPUT DATA: 
    Kamu akan menerima pesan dari Soni. Prioritaskan data dari Spreadsheet. Jika data kurang, JANGAN ASAL MENYIMPULKAN. Minta data tambahan secara spesifik (Income, Expense, Aktivitas, Net worth, dll).
    
    2. ANALISIS WAJIB:
    - Analisis Cashflow: surplus/defisit, % konsumtif vs produktif.
    - Analisis Income Efficiency: income per effort, sumber potensial.
    - Analisis Growth Potential: fase survive atau scale.
    - Analisis Risiko: single income, dana darurat, dll.
    
    3. OUTPUT HARUS TERSTRUKTUR:
    A. Ringkasan Kondisi (2-3 kalimat berbasis data)
    B. Temuan Kritis (Yang paling bermasalah, to the point)
    C. Insight Utama (Apa yang SEBENARNYA terjadi)
    D. Rekomendasi Aksi (maksimal 3, spesifik & terukur)
    E. Pertanyaan Kritis Soni (Untuk memaksa diam berpikir/evaluasi)
    
    4. GAYA KOMUNIKASI:
    Jujur, langsung, berbasis logika. Boleh tegas/kejam. Hindari basa-basi. Gunakan angka.`;

    try {
        const result = await model.generateContent(systemPrompt);
        const responsTeks = result.response.text().trim();

        // Coba baca apakah responsnya berupa JSON
        try {
            const dataJSON = JSON.parse(responsTeks);
            return { isJson: true, data: dataJSON };
        } catch (e) {
            // Jika gagal di-parse, berarti Gemini membalas obrolan biasa
            return { isJson: false, text: responsTeks };
        }
    } catch (error) {
        console.error("Gemini Error:", error);
        return { isJson: false, text: "Maaf Bos, otak AI saya lagi nge-lag. Coba bentar lagi." };
    }
}

// --- INISIALISASI BOT BAILEYS ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys_finance');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Bot Finance Soni', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(startBot, 2000);
        } else if (connection === 'open') {
            console.log('✅ Soni Finance Bot READY!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const pesanTeks = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!pesanTeks) return;

        const pengirim = msg.key.remoteJid;

        // Nomor Soni: 082136111625 -> Format WA: 6282136111625
        const allowedNumber = "6282136111625";
        const senderJid = msg.key.participant || msg.key.remoteJid;
        if (!senderJid.startsWith(allowedNumber)) {
            console.log(`[Abaikan]: Pesan dari nomor tidak dikenal (${senderJid})`);
            return;
        }

        console.log(`[Pesan Masuk]: ${pesanTeks}`);

        // Kirim status "Sedang mengetik..."
        await sock.sendPresenceUpdate('composing', pengirim);

        // Lempar pesan ke Gemini
        const hasil = await prosesPesan(pesanTeks);

        if (hasil.isJson && hasil.data.is_finance) {
            const data = hasil.data;
            const { tanggal, bulan } = getDateInfo();

            if (data.jenis === 'transaksi') {
                // Susun array sesuai urutan kolom di Sheet "Transaksi"
                const barisBaru = [
                    tanggal, bulan, data.tipe, data.kategori,
                    data.sifat || "", data.nominal, data.effort_jam || "", data.keterangan
                ];

                const sukses = await appendToSheet('Transaksi!A:H', barisBaru);
                if (sukses) {
                    let balasan = `✅ *${data.tipe} Rp${data.nominal.toLocaleString('id-ID')}* berhasil dicatat!\n`;
                    balasan += `Kategori: ${data.kategori}\n`;
                    if (data.tipe === 'Expense') balasan += `Sifat: ${data.sifat}\n`;
                    if (data.tipe === 'Income' && data.effort_jam > 0) {
                        const perJam = Math.round(data.nominal / data.effort_jam);
                        balasan += `⚡ Valuasi Waktu: Rp${perJam.toLocaleString('id-ID')}/jam`;
                    }
                    await sock.sendMessage(pengirim, { text: balasan });
                } else {
                    await sock.sendMessage(pengirim, { text: "❌ Gagal nulis ke Spreadsheet. Coba cek log." });
                }
            }
            else if (data.jenis === 'keputusan') {
                // Susun array sesuai urutan kolom di Sheet "Decision Log"
                const barisBaru = [tanggal + " " + bulan, data.keputusan, data.dampak, ""];

                const sukses = await appendToSheet('Decision Log!A:D', barisBaru);
                if (sukses) {
                    await sock.sendMessage(pengirim, { text: `🧠 *Keputusan Dicatat!*\n\nEkspektasi: ${data.dampak}\n_Jangan lupa dievaluasi bulan depan, Soni!_` });
                }
            }
        } else {
            // Jika bukan transaksi (ngobrol biasa / nanya evaluasi)
            await sock.sendMessage(pengirim, { text: hasil.text });
        }
    });
}

startBot();