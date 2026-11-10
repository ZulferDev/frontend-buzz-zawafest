# ZAWA SMART COMPETITION backend

Backend Hono + SQLite yang menjadi bagian dari bundel frontend. Jalankan
`npm install` dan `npm run dev` dari root proyek untuk menyalakan keduanya
sekaligus.

## Konfigurasi

| Variabel | Default | Kegunaan |
| --- | --- | --- |
| `PORT` | `3000` | Port API backend |
| `HOST` | `127.0.0.1` | Alamat bind; runner gabungan mengatur `0.0.0.0` |
| `FRONTEND_PORT` | `5173` | Port frontend yang origin IP/LAN-nya diizinkan |
| `BUZZER_START_DELAY_MS` | `2000` | Waktu persiapan sebelum buzzer dibuka serentak |
| `SQLITE_PATH` | `./data/zawa.sqlite` | Lokasi database |
| `FRONTEND_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origin tambahan yang diizinkan, dipisahkan koma |

Selain origin yang dikonfigurasi, CORS otomatis menerima origin HTTP/HTTPS pada
port frontend untuk `localhost`, alamat loopback, alamat IPv4 privat, dan
alamat IPv6 lokal. Karena itu frontend yang dibuka melalui IP LAN ponsel tidak
membutuhkan pengaturan origin manual.

## API

- `GET /health` — pemeriksaan kesehatan.
- `GET /api/state` — state lengkap beserta `revision`. Tambahkan
  `?since=<revision>` untuk polling; jika belum berubah, server membalas
  `204 No Content`.
- `PUT /api/state` — menyimpan state memakai `expectedRevision`; konflik
  mengembalikan HTTP 409 dan snapshot terbaru.
- `GET /api/teams` dan `GET /api/questions` — membaca koleksi domain.
- `POST /api/buzzer` — klaim buzzer diproses atomik.

Saat babak dibuka atau buzzer direset, backend menetapkan `buzzerOpensAt`
berdasarkan jam server dan mengirimkannya ke seluruh peserta. Klien menunggu
waktu tersebut sebelum menampilkan tombol aktif; backend juga menolak klaim
yang datang lebih awal. Penyelarasan ini mengurangi pengaruh fase polling dan
perbedaan jam perangkat, tetapi latensi jaringan/perangkat tetap dapat
menimbulkan selisih kecil yang tidak bisa dihilangkan sepenuhnya.

Backend tidak menyediakan autentikasi admin. Jangan mengeksposnya ke jaringan
yang tidak tepercaya tanpa menambahkan autentikasi dan HTTPS.
