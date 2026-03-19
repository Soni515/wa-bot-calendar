require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { Client } = require('@notionhq/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- INISIALISASI API (Pastikan file .env sudah diisi) ---
const notion = new Client({ auth: process.env.NOTION_SECRET });
const databaseId = process.env.NOTION_DATABASE_ID;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- HELPER FORMAT TANGGAL ---
function formatTanggal(date) {
    const hari = date.toLocaleDateString('id-ID', { weekday: 'long' });
    const tanggal = date.getDate().toString().padStart(2, '0');
    const bulan = date.toLocaleDateString('id-ID', { month: 'long' });
    const tahun = date.getFullYear();
    return `${hari}, ${tanggal} - ${bulan} - ${tahun}`;
}

function formatJam(date) {
    if (!date) return '';
    const jam = date.getHours().toString().padStart(2, '0');
    const menit = date.getMinutes().toString().padStart(2, '0');
    return `${jam}.${menit}`;
}

// --- FUNGSI AMBIL DATA DARI NOTION ---
async function fetchNotionData() {
    let jadwalHarian = [];
    let todoList = [];

    try {
        const response = await notion.databases.query({
            database_id: databaseId,
        });

        response.results.forEach(page => {
            const properties = page.properties;

            // 1. Ambil Judul dari kolom "Name"
            let judul = "Tanpa Judul";
            if (properties['Name']?.title?.length > 0) {
                judul = properties['Name'].title[0].plain_text;
            }

            // 2. Ambil Waktu dari kolom "Date"
            let waktuMulai = null;
            let waktuSelesai = null;
            if (properties['Date']?.date?.start) {
                waktuMulai = new Date(properties['Date'].date.start);
            }
            if (properties['Date']?.date?.end) {
                waktuSelesai = new Date(properties['Date'].date.end);
            }

            // 3. Ambil Kategori dari kolom "Select"
            const kategori = properties['Select']?.select?.name;

            // Masukkan ke Array yang Tepat
            if (waktuMulai) {
                if (kategori === 'Jadwal') {
                    jadwalHarian.push({ id: page.id, kegiatan: judul, waktuMulai, waktuSelesai });
                } else if (kategori === 'To Do List') {
                    todoList.push({ id: page.id, tugas: judul, tenggat: waktuMulai });
                }
            }
        });

        // Urutkan dari waktu terdekat
        jadwalHarian.sort((a, b) => a.waktuMulai - b.waktuMulai);
        todoList.sort((a, b) => a.tenggat - b.tenggat);

    } catch (error) {
        console.error("Gagal mengambil data dari Notion:", error);
    }

    return { jadwalHarian, todoList };
}

// --- FUNGSI TAMBAH DATA KE NOTION ---
async function addNotionData(judul, waktuMulai, waktuSelesai, kategori) {
    try {
        const properties = {
            'Name': { title: [{ text: { content: judul } }] },
            'Select': { select: { name: kategori } }
        };

        if (waktuMulai) {
            properties['Date'] = {
                date: {
                    start: waktuMulai,
                    end: waktuSelesai || null
                }
            };
        }

        await notion.pages.create({
            parent: { database_id: databaseId },
            properties: properties
        });
        return true;
    } catch (error) {
        console.error("Gagal tambah ke Notion:", error);
        return false;
    }
}

// --- FUNGSI UPDATE WAKTU KE NOTION (RESCHEDULE) ---
async function updateNotionWaktu(pageId, waktuMulai, waktuSelesai) {
    try {
        await notion.pages.update({
            page_id: pageId,
            properties: {
                'Date': {
                    date: {
                        start: waktuMulai,
                        end: waktuSelesai || null
                    }
                }
            }
        });
        return true;
    } catch (error) {
        console.error("Gagal update ke Notion:", error);
        return false;
    }
}

// --- FUNGSI HAPUS DATA DARI NOTION (DELETE) ---
async function deleteNotionData(pageId) {
    try {
        await notion.pages.update({
            page_id: pageId,
            archived: true
        });
        return true;
    } catch (error) {
        console.error("Gagal menghapus dari Notion:", error);
        return false;
    }
}

// --- FUNGSI REKAP JADWAL & TODO (Sesuai Formatmu) ---
function formatRekap(jadwalHarian, todoList) {
    let teksBalasan = 'Tentu, mari saya tunjukkan jadwalmu.\n\n';

    teksBalasan += 'Jadwal =\n';
    if (jadwalHarian.length === 0) {
        teksBalasan += '- Kosong, selamat bersantai!\n';
        teksBalasan += '\n';
    } else {
        let jadwalGrouped = {};
        jadwalHarian.forEach(item => {
            const tglString = formatTanggal(item.waktuMulai);
            if (!jadwalGrouped[tglString]) jadwalGrouped[tglString] = [];
            jadwalGrouped[tglString].push(item);
        });

        for (const [tgl, kegiatans] of Object.entries(jadwalGrouped)) {
            teksBalasan += `${tgl} =\n`;
            kegiatans.forEach(k => {
                const jamMulai = formatJam(k.waktuMulai);
                const jamSelesai = k.waktuSelesai ? ` - ${formatJam(k.waktuSelesai)}` : '';
                teksBalasan += `- ${jamMulai}${jamSelesai}: ${k.kegiatan}\n`;
            });
            teksBalasan += '\n';
        }
    }

    teksBalasan += 'To Do List =\n';
    if (todoList.length === 0) {
        teksBalasan += '- Kosong, selamat bersantai!\n';
    } else {
        todoList.forEach((todo, index) => {
            const tglTenggat = formatTanggal(todo.tenggat);
            const jamTenggat = formatJam(todo.tenggat);
            teksBalasan += `${index + 1}. ${todo.tugas} ( ${tglTenggat} - ${jamTenggat} )\n`;
        });
    }

    return teksBalasan;
}

// --- FUNGSI ANALISIS PESAN (GEMINI) ---
async function analisisPesan(pesan) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        const prompt = `Kamu adalah asisten AI pribadi bernama Soni Bot.
Tugas utama: Menganalisa pesan Soni dan menentukan aksinya.

Waktu saat ini: ${now} (WIB) // Gunakan ini sebagai patokan jika Soni berkata "besok", "nanti", "lusa", dsb.

Kategori aksi:
1. READ_SCHEDULE: Soni menanyakan jadwal/agenda/to-do list (misal: "eh jadwalku apa aja", "hari ini ngapain").
2. ADD_SCHEDULE: Soni ingin menambahkan jadwal agenda dengan waktu spesifik (misal: "tambah jadwal ngopi jam 8 malam").
3. ADD_TODO: Soni menambahkan to-do list tugas/pekerjaan (misal: "catat: beli beras besok siang").
4. RESCHEDULE: Soni mengubah waktu/mengundur jadwal/to-do list (misal: "undur rapat besok jadi jam 2 siang", "tugas kimia undur tanggal 30").
5. DELETE: Soni menghapus/membatalkan jadwal/to-do list (misal: "hapus jadwal ngopi", "coret tugas matematika", "batal rapat besok").
6. CHAT: Obrolan biasa atau di luar aksi di atas.

Output HANYA dalam format JSON valid (tanpa backtick markdown \`\`\`) seperti ini:
{
  "action": "READ_SCHEDULE" | "ADD_SCHEDULE" | "ADD_TODO" | "RESCHEDULE" | "DELETE" | "CHAT",
  "data": {
     // Jika ADD_SCHEDULE: isi "kegiatan", "waktuMulai" (Format ISO8601, cth: "2026-03-25T10:00:00+07:00"), "waktuSelesai" (Format ISO8601/null)
     // Jika ADD_TODO: isi "tugas", "tenggat" (Format ISO8601/null)
     // Jika RESCHEDULE: isi "keywords" (String, 1-2 kata kunci untuk mencari nama kegiatannya), "waktuMulaiBaru" (Format ISO8601), "waktuSelesaiBaru" (Format ISO8601/null)
     // Jika DELETE: isi "keywords" (String, 1-2 kata kunci untuk mencari nama kegiatannya)
     // Jika CHAT ATAU READ_SCHEDULE: isi "reply" (String balasan AI yang natural)
  }
}

Pesan Soni: "${pesan}"`;

        const result = await model.generateContent(prompt);
        let teks = result.response.text().trim();

        // Bersihkan formatting markdown JSON jika ada
        if (teks.startsWith('\`\`\`json')) teks = teks.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
        else if (teks.startsWith('\`\`\`')) teks = teks.replace(/\`\`\`/g, '').trim();

        return JSON.parse(teks);
    } catch (error) {
        console.error("Gemini Error:", error);
        return { action: "CHAT", data: { reply: "Maaf, sistem AI sedang sibuk. Coba lagi nanti ya 😅" } };
    }
}

// --- LOGIC PENGINGAT (REMINDER) ---
let sudahDiingatkan = new Set();
let intervalPengingat = null;

function jalankanPengingat(sock) {
    const nomorTujuan = '6282136111625@s.whatsapp.net';

    if (intervalPengingat) clearInterval(intervalPengingat);
    console.log("⏰ Sistem pengingat otomatis aktif...");

    intervalPengingat = setInterval(async () => {
        try {
            const dataNotion = await fetchNotionData();
            const sekarang = new Date();

            const semuaItem = [
                ...dataNotion.jadwalHarian.map(i => ({ ...i, tipe: 'Jadwal', nama: i.kegiatan, waktu: i.waktuMulai })),
                ...dataNotion.todoList.map(i => ({ ...i, tipe: 'To Do List', nama: i.tugas, waktu: i.tenggat }))
            ];

            for (const item of semuaItem) {
                if (!item.waktu) continue;

                const selisihMs = item.waktu.getTime() - sekarang.getTime();
                const selisihMenit = Math.round(selisihMs / 60000);

                let waktuReminder = null;
                // Ingatkan H-30mnt, H-15mnt, dan H-5mnt
                if (selisihMenit >= 29 && selisihMenit <= 31 && !sudahDiingatkan.has(`${item.id}-30`)) waktuReminder = 30;
                else if (selisihMenit >= 14 && selisihMenit <= 16 && !sudahDiingatkan.has(`${item.id}-15`)) waktuReminder = 15;
                else if (selisihMenit >= 4 && selisihMenit <= 6 && !sudahDiingatkan.has(`${item.id}-5`)) waktuReminder = 5;

                if (waktuReminder !== null) {
                    sudahDiingatkan.add(`${item.id}-${waktuReminder}`);
                    const pesanReminder = `🔔 *PENGINGAT ${item.tipe.toUpperCase()}*\n\nSiap-siap ya! Kamu ada ${item.tipe}:\n📌 *${item.nama}*\n⏰ Kira-kira ${waktuReminder} menit lagi (${formatJam(item.waktu)}).`;
                    await sock.sendMessage(nomorTujuan, { text: pesanReminder });
                }
            }
        } catch (error) {
            console.error("Error pada sistem pengingat:", error);
        }
    }, 60000); // Jalan setiap 60 detik
}

// --- INISIALISASI BAILEYS ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Menggunakan WA Web versi v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Bot Jadwal Soni', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('👆 Silakan scan QR Code di atas!');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Error:', lastDisconnect.error?.message, 'Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => startBot(), 2000);
            }
        } else if (connection === 'open') {
            console.log('✅ Client is ready! Bot terhubung ke Notion & Gemini.');
            jalankanPengingat(sock);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const pesanTeks = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!pesanTeks) return;

        const pengirim = msg.key.remoteJid;

        // BOT HANYA AKTIF UNTUK NOMOR INI
        const nomorAkses = '6282136111625';
        if (!pengirim.includes(nomorAkses)) {
            console.log(`Pesan diabaikan dari: ${pengirim} (Bukan nomor aktif bot)`);
            return;
        }

        console.log(`Pesan masuk dari ${pengirim}: ${pesanTeks}`);

        // PROSES PESAN DENGAN GEMINI UNTUK TAU INTENSINYA
        await sock.sendMessage(pengirim, { text: '⏳ *Merespons...*' });
        const analisis = await analisisPesan(pesanTeks);
        const action = analisis.action;
        const data = analisis.data;

        if (action === 'READ_SCHEDULE') {
            const dataNotion = await fetchNotionData();
            let balasan = formatRekap(dataNotion.jadwalHarian, dataNotion.todoList);
            if (data.reply) balasan = data.reply + "\n\n" + balasan;
            await sock.sendMessage(pengirim, { text: balasan });
        }
        else if (action === 'ADD_SCHEDULE') {
            const sukses = await addNotionData(data.kegiatan, data.waktuMulai, data.waktuSelesai, 'Jadwal');
            if (sukses) {
                await sock.sendMessage(pengirim, { text: `✅ Berhasil menambahkan Jadwal:\n*${data.kegiatan}*` });
            } else {
                await sock.sendMessage(pengirim, { text: `❌ Gagal menambahkan jadwal ke Notion.` });
            }
        }
        else if (action === 'ADD_TODO') {
            const sukses = await addNotionData(data.tugas, data.tenggat, null, 'To Do List');
            if (sukses) {
                await sock.sendMessage(pengirim, { text: `✅ Berhasil menambahkan To Do List:\n*${data.tugas}*` });
            } else {
                await sock.sendMessage(pengirim, { text: `❌ Gagal menambahkan To Do List ke Notion.` });
            }
        }
        else if (action === 'RESCHEDULE' || action === 'DELETE') {
            const dataNotion = await fetchNotionData();
            const semuaItem = [
                ...dataNotion.jadwalHarian.map(i => ({ id: i.id, tipe: 'Jadwal', nama: i.kegiatan })),
                ...dataNotion.todoList.map(i => ({ id: i.id, tipe: 'To Do List', nama: i.tugas }))
            ];

            const keyword = data.keywords ? data.keywords.toLowerCase() : '';
            // Cari item terdekat yang namanya mengandung keyword yang ditangkap Gemini
            const target = semuaItem.find(item => item.nama.toLowerCase().includes(keyword));

            if (!target || !keyword) {
                await sock.sendMessage(pengirim, { text: `❌ Maaf, saya tidak menemukan jadwal/tugas yang berkaitan dengan "${data.keywords}".` });
            } else {
                if (action === 'DELETE') {
                    const sukses = await deleteNotionData(target.id);
                    if (sukses) await sock.sendMessage(pengirim, { text: `✅ Berhasil menghapus ${target.tipe}:\n*${target.nama}*` });
                    else await sock.sendMessage(pengirim, { text: `❌ Gagal memproses hapus di Notion.` });
                } else if (action === 'RESCHEDULE') {
                    const sukses = await updateNotionWaktu(target.id, data.waktuMulaiBaru, data.waktuSelesaiBaru);
                    if (sukses) await sock.sendMessage(pengirim, { text: `✅ Berhasil mengubah tanggal/jam ${target.tipe}:\n*${target.nama}*` });
                    else await sock.sendMessage(pengirim, { text: `❌ Gagal memproses ubah jadwal di Notion.` });
                }
            }
        }
        else {
            // ACTION === 'CHAT' ATAU LAINNYA
            await sock.sendMessage(pengirim, { text: data.reply || "Oke!" });
        }
    });
}

startBot();