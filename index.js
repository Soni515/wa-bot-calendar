const { Client: WAClient, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { Client: NotionClient } = require('@notionhq/client');

// ==========================================
// 1. KONFIGURASI API (WAJIB PAKAI KEY BARU!)
// ==========================================

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const notion = new NotionClient({ auth: process.env.NOTION_SECRET });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// 2. SKEMA AI (Ditambah fitur Target Time)
// ==========================================
const calendarSchema = {
    type: SchemaType.OBJECT,
    properties: {
        action: { type: SchemaType.STRING, description: "Niat: 'create', 'update', 'delete', atau 'read' (jika user minta lihat jadwal/meringkas)" },
        target_title: { type: SchemaType.STRING, description: "UPDATE/DELETE: Kata kunci judul lama. Kosongkan jika mencari murni via jam." },
        target_time: { type: SchemaType.STRING, description: "UPDATE/DELETE: Jam jadwal LAMA (HH:MM)." },
        target_date: { type: SchemaType.STRING, description: "UPDATE/DELETE: Tanggal spesifik jadwal LAMA (YYYY-MM-DD). Wajib diisi jika target_time terisi! " },
        title: { type: SchemaType.STRING, description: "Judul kegiatan BARU. Wajib untuk 'create'. Kosongkan untuk delete." },
        date: { type: SchemaType.STRING, description: "Tanggal kegiatan YYYY-MM-DD" },
        start_time: { type: SchemaType.STRING, description: "Waktu mulai BARU HH:MM (24 jam) atau 'All day'" },
        end_time: { type: SchemaType.STRING, description: "Waktu selesai BARU HH:MM (24 jam)." },
        reply_message: { type: SchemaType.STRING, description: "Balasan santai dari asisten." }
    },
    required: ["action", "reply_message"],
};

const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
        responseMimeType: "application/json",
        responseSchema: calendarSchema,
    },
});

// ==========================================
// 3. INISIALISASI WA
// ==========================================
console.log('Memulai inisialisasi client...');
const client = new WAClient({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Mantap! Bot WhatsApp sudah siap dengan pencarian via Jam.'));

// ==========================================
// 4. FUNGSI PENCARIAN NOTION (JUDUL & JAM)
// ==========================================
async function findNotionEvent(keyword, targetTime, dateStr) {
    if (!keyword && !targetTime) return null;

    try {
        let filterConfig = undefined;

        // 1. Prioritas cari pakai judul
        if (keyword) {
            filterConfig = { property: "Name", title: { contains: keyword } };
        }
        // 2. Kalau nggak ada judul, cari pakai rentang tanggal hari itu
        else if (dateStr) {
            filterConfig = {
                and: [
                    { property: "Date", date: { on_or_after: `${dateStr}T00:00:00.000+07:00` } },
                    { property: "Date", date: { on_or_before: `${dateStr}T23:59:59.000+07:00` } }
                ]
            };
        }

        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            ...(filterConfig && { filter: filterConfig })
        });

        let results = response.results;

        // Jika carinya HANYA pakai jam, saring dari hasil tanggal tadi
        if (!keyword && targetTime) {
            results = results.filter(page => {
                if (!page.properties.Date.date) return false;
                const pageStartDate = page.properties.Date.date.start; // cth: "2026-03-18T15:00:00"
                return pageStartDate.includes(targetTime);
            });
        }

        if (results.length > 0) {
            // Kembalikan ID sekaligus nama jadwal aslinya
            return {
                id: results[0].id,
                title: results[0].properties.Name.title[0]?.text.content || "Jadwal Tanpa Nama"
            };
        }
        return null;
    } catch (error) {
        console.error("[LOG ERROR NOTION]:", error.message);
        return null;
    }
}

// ==========================================
// 5. PROSES PESAN MASUK
// ==========================================
client.on('message', async (message) => {
    const allowedNumbers = ['6282136111625@c.us', '96886526599416@lid'];
    if (!allowedNumbers.includes(message.from)) return;

    if (message.body.toLowerCase() === 'ping') {
        await message.reply('pong! Asisten siap sedia.'); return;
    }

    try {
        await message.reply('⏳ Mengurus jadwalmu...');

        const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const todayStr = new Date().toLocaleDateString('id-ID', dateOptions);

        const prompt = `Kamu asisten kalender. Hari ini ${todayStr}.
Panduan:
- Batal/hapus -> "delete"
- Undur/ganti waktu -> "update"
- Buat -> "create"
- Lihat jadwal seminggu/hari ini -> "read"
PENTING: Jika obrolan soal ganti/hapus jadwal, wajib isi target_time dan target_date dari jadwal LAMA. Properti 'date' dan 'start_time' khusus untuk jadwal BARU.
Pesan user: "${message.body}"`;

        const result = await model.generateContent(prompt);
        const eventData = JSON.parse(result.response.text());
        console.log(`[LOG] Action: ${eventData.action} | Target Judul: ${eventData.target_title} | Target Jam: ${eventData.target_time}`);

        let dateProperty = { start: eventData.date };
        if (eventData.start_time && eventData.start_time.toLowerCase() !== 'all day' && eventData.date) {
            dateProperty.start = `${eventData.date}T${eventData.start_time}:00.000+07:00`;
            if (eventData.end_time && eventData.end_time.trim() !== "") {
                dateProperty.end = `${eventData.date}T${eventData.end_time}:00.000+07:00`;
            }
        }

        // --- BUAT JADWAL ---
        if (eventData.action === 'create') {
            await notion.pages.create({
                parent: { database_id: NOTION_DATABASE_ID },
                properties: {
                    "Name": { title: [{ text: { content: eventData.title } }] },
                    "Date": { date: dateProperty }
                }
            });
            await message.reply(`${eventData.reply_message}\n\n[Sistem] ✅ *Jadwal Dibuat!*\n📅 ${eventData.title}\n⏰ ${eventData.start_time || ''}`);
        }

        // --- HAPUS / RESCHEDULE ---
        else if (eventData.action === 'update' || eventData.action === 'delete') {
            if (!eventData.target_title && !eventData.target_time) {
                await message.reply(`Hmm, aku bingung mau ${eventData.action === 'delete' ? 'hapus' : 'ubah'} jadwal yang mana. Sebutin judul atau jamnya ya!`);
                return;
            }

            // Panggil fungsi pencarian baru, utamakan target_date jika ada
            const searchDate = eventData.target_date || eventData.date;
            const targetEvent = await findNotionEvent(eventData.target_title, eventData.target_time, searchDate);

            if (!targetEvent) {
                let alasan = eventData.target_title ? `judul *"${eventData.target_title}"*` : `jam *${eventData.target_time}*`;
                await message.reply(`Waduh, dicari pakai ${alasan} kok nggak ketemu di kalender. Coba cek lagi! ❌`);
                return;
            }

            if (eventData.action === 'delete') {
                await notion.pages.update({ page_id: targetEvent.id, archived: true });
                await message.reply(`${eventData.reply_message}\n\n[Sistem] 🗑️ *Jadwal Dihapus!*\nKegiatan *"${targetEvent.title}"* berhasil dihapus.`);
            }
            else if (eventData.action === 'update') {
                const finalTitle = eventData.title || targetEvent.title; // Pakai nama lama kalau nggak ada nama baru
                await notion.pages.update({
                    page_id: targetEvent.id,
                    properties: {
                        "Name": { title: [{ text: { content: finalTitle } }] },
                        "Date": { date: dateProperty }
                    }
                });
                await message.reply(`${eventData.reply_message}\n\n[Sistem] 🔄 *Jadwal Diubah!*\nKegiatan *"${targetEvent.title}"* diubah jadi:\n📅 ${finalTitle}\n⏰ ${eventData.start_time || ''}`);
            }
        }

        // --- BACA JADWAL SEMINGGU ---
        else if (eventData.action === 'read') {
            const today = new Date();
            const day = today.getDay(); // 0 is Minggu
            const diff = today.getDate() - day + (day === 0 ? -6 : 1);
            const startOfWeek = new Date(today);
            startOfWeek.setDate(diff);
            startOfWeek.setHours(0, 0, 0, 0);

            const endOfWeek = new Date(startOfWeek);
            endOfWeek.setDate(startOfWeek.getDate() + 6);
            endOfWeek.setHours(23, 59, 59, 999);

            // Supaya format timezone tepat (WIB)
            const addLeadingZero = (n) => n < 10 ? '0' + n : n;
            const toTzIso = (d) => `${d.getFullYear()}-${addLeadingZero(d.getMonth() + 1)}-${addLeadingZero(d.getDate())}T${addLeadingZero(d.getHours())}:${addLeadingZero(d.getMinutes())}:00.000+07:00`;

            const response = await notion.databases.query({
                database_id: NOTION_DATABASE_ID,
                filter: {
                    and: [
                        { property: "Date", date: { on_or_after: toTzIso(startOfWeek) } } /* Batas Awal Mulai Senin 00:00 */,
                        { property: "Date", date: { on_or_before: toTzIso(endOfWeek) } } /* Batas Akhir Minggu 23:59 */
                    ]
                },
                sorts: [{ property: "Date", direction: "ascending" }]
            });

            const daysLocal = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
            let scheduleMap = { 'Senin': [], 'Selasa': [], 'Rabu': [], 'Kamis': [], 'Jumat': [], 'Sabtu': [], 'Minggu': [] };

            response.results.forEach(page => {
                const title = page.properties.Name.title[0]?.text.content || "Tanpa Judul";
                const dateObj = page.properties.Date.date;
                if (!dateObj) return;

                const startDt = new Date(dateObj.start);
                const dayName = daysLocal[startDt.getDay()];

                let timeStr = "";
                if (dateObj.start.length <= 10) {
                    timeStr = "Seharian";
                } else {
                    const formatTime = (isoString) => {
                        const dt = new Date(isoString);
                        return `${addLeadingZero(dt.getHours())}.${addLeadingZero(dt.getMinutes())}`;
                    };
                    const startTStr = formatTime(dateObj.start);
                    const endTStr = dateObj.end ? formatTime(dateObj.end) : "?";
                    timeStr = dateObj.end ? `${startTStr} - ${endTStr}` : startTStr;
                }

                if (scheduleMap[dayName]) {
                    scheduleMap[dayName].push(`${timeStr} (${title})`);
                }
            });

            let messageLines = [`${eventData.reply_message || 'Ini jadwalmu seminggu ini:'}\n`];
            const order = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
            order.forEach(d => {
                if (scheduleMap[d].length === 0) {
                    messageLines.push(`*${d}* = Kosong`);
                } else {
                    messageLines.push(`*${d}* =\n` + scheduleMap[d].join('\n'));
                }
            });

            await message.reply(messageLines.join('\n\n'));
        }

    } catch (error) {
        console.error("Error:", error);
        await message.reply('❌ Maaf, sistem error. Cek terminal.');
    }
});

client.initialize();