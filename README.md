# ZAWA SMART COMPETITION

Aplikasi Lomba Cerdas Cermat berbasis Vite dengan slogan “Smart Generation
Empower Ummah”. Beranda difokuskan untuk peserta. State kuis tetap dicache di
`localStorage`, lalu disinkronkan dengan backend SQLite melalui REST dan
polling revision setiap 250 ms agar panel admin, layar kuis, dan peserta dapat
berbagi pembaruan lintas tab maupun perangkat tanpa memuat ulang halaman.

## Menjalankan

### Termux: satu bundel frontend + backend

Salin atau clone folder proyek ini ke perangkat Android. Di Termux, pasang
toolchain SQLite lalu install seluruh dependency dari root proyek:

```sh
pkg update
pkg install nodejs-lts python make clang
npm install
npm run dev
```

Perintah tunggal tersebut menjalankan backend dan Vite pada `0.0.0.0`:
backend di port `3000`, frontend di port `5173`. Buka `http://localhost:5173`
di perangkat yang sama, atau `http://<IP-LAN-ponsel>:5173` dari perangkat lain.
Frontend otomatis memakai hostname yang sama untuk backend; tidak perlu
mengatur IP atau CORS secara manual. Perubahan frontend memakai Vite HMR dan
backend otomatis dimulai ulang saat file sumber berubah. Data SQLite disimpan
di `backend/data/zawa.sqlite`.

Untuk memakai port berbeda, jalankan dengan `PORT=<port-backend>` dan
`FRONTEND_PORT=<port-frontend>`. Untuk jaringan selain localhost/LAN, gunakan
`FRONTEND_ORIGINS` berisi origin frontend yang diizinkan, dipisahkan koma.
Jangan mengekspos server tanpa autentikasi ke jaringan yang tidak tepercaya.

### Menjalankan frontend saja

```sh
npm install
npm run dev:frontend
```

Buka alamat lokal Vite. Rute yang tersedia:

- `/` — beranda
- `/admin` — panel admin (akses langsung; tidak ditampilkan di menu peserta)
- `/quiz` — layar skor dan pertanyaan
- `/player` — pemilihan tim dan buzzer

Frontend mencoba backend pada hostname yang sama dengan port `3000` secara
default dan tetap memakai penyimpanan lokal saat backend offline. Untuk server
lain, atur `VITE_API_URL` sebelum menjalankan Vite atau membuat build. Detail
endpoint dan konfigurasi tersedia di [README backend](./backend/README.md).

## Pengujian end-to-end

```sh
npm run test:e2e
```

Tes ini menjalankan backend dan frontend pada port khusus serta memakai database
SQLite sementara. Cakupannya termasuk klaim lintas tim yang jatuh dalam jendela
adjudikasi 250 ms sebagai seri, klaim yang terlambat di jaringan, dan burst
klik duplikat. Server tetap tidak dapat mengetahui waktu klik fisik yang
sebenarnya dari browser, sehingga klaim yang melewati jendela tidak dapat
dianggap bersamaan secara tepercaya.

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
- Papan skor dan status kuis diperbarui melalui polling REST; tombol buzzer
  muncul di semua halaman peserta saat babak dibuka. Server menampung klaim
  selama jendela adjudikasi 250 ms: klaim satu tim menang, sedangkan klaim dari
  beberapa tim dalam jendela itu dinyatakan seri dan ditampilkan di layar kuis
  serta peserta. Pembawa acara dapat mengumumkan soal tie-break lalu mereset
  buzzer. Klaim hanya dapat dilakukan saat backend tersambung. Waktu tombol
  aktif dijadwalkan server dan disinkronkan ke jam browser.

Data contoh generik dibuat saat aplikasi pertama kali dibuka dan state lama dari
`lcc-local-state-v1` dimigrasikan satu kali ke backend saat tersambung. Sesudah
migrasi berhasil, backend SQLite menjadi sumber data utama dan key lama dihapus;
`lcc-backend-cache-v1` hanya cache/fallback lokal. Browser atau profil berbeda
berbagi data selama terhubung ke backend yang sama. Gunakan tombol reset panel
admin untuk menghapus seluruh data kuis.