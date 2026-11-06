# ZAWA SMART COMPETITION

Aplikasi Lomba Cerdas Cermat berbasis Vite dengan slogan “Smart Generation
Empower Ummah”. Beranda difokuskan untuk peserta. State kuis tetap dicache di
`localStorage`, lalu disinkronkan dengan backend SQLite melalui REST dan
WebSocket agar panel admin, layar kuis, dan peserta dapat berbagi pembaruan
lintas tab maupun perangkat.

## Menjalankan

```sh
npm install
npm run dev
```

Buka alamat lokal Vite. Rute yang tersedia:

- `/` — beranda
- `/admin` — panel admin (akses langsung; tidak ditampilkan di menu peserta)
- `/quiz` — layar skor dan pertanyaan
- `/player` — pemilihan tim dan buzzer

Backend Hono dijalankan terpisah di `/workspaces/backend-buzz-zawafest` dengan
`npm install && npm run dev`. Frontend mencoba `http://localhost:3000/api`
secara default dan tetap memakai penyimpanan lokal saat backend offline. Untuk
server lain, atur `VITE_API_URL` sebelum menjalankan Vite atau membuat build.
Detail endpoint dan konfigurasi tersedia di README backend.

## Pengujian end-to-end

```sh
npm run test:e2e
```

Tes ini menjalankan backend dan frontend pada port khusus serta memakai database
SQLite sementara. Jalankan dari direktori frontend; backend harus tersedia di
`../backend-buzz-zawafest`.

Untuk menguji server dev yang sudah berjalan di `localhost:3000` dan
`localhost:5173`, gunakan `npm run test:e2e:dev`. Screenshot tersimpan di
`test-results/e2e-evidence/` dan video alur tiap halaman di
`test-results/e2e-evidence/videos/`.

## Fitur

- Menambah/menghapus tim, mengunggah nada buzzer MP3/WAV, dan mengubah skor
  dengan tombol `+10` / `−5`.
- Menambah, memilih, menghapus, memfilter, mengimpor, serta mengekspor soal.
  Impor/ekspor menggunakan berkas Excel `.xlsx`; kolomnya adalah Kelompok,
  Teks Soal, Jawaban, dan Poin.
- Membuka/menutup babak rebutan, mengatur tampilan standby, mereset buzzer,
  dan mereset seluruh data.
- Papan skor dan status kuis didorong melalui WebSocket; klaim buzzer diproses
  secara atomik di backend agar hanya satu tim yang menang.

Data contoh generik dibuat saat aplikasi pertama kali dibuka dan state lama dari
`lcc-local-state-v1` dimigrasikan satu kali ke backend saat tersambung. Sesudah
migrasi berhasil, backend SQLite menjadi sumber data utama dan key lama dihapus;
`lcc-backend-cache-v1` hanya cache/fallback lokal. Browser atau profil berbeda
berbagi data selama terhubung ke backend yang sama. Gunakan tombol reset panel
admin untuk menghapus seluruh data kuis.