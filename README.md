# ZAWA SMART COMPETITION

Aplikasi Lomba Cerdas Cermat berbasis Vite dengan backend Go, Gorilla WebSocket,
dan SQLite. REST tetap digunakan untuk perubahan state admin; WebSocket
menyiarkan state, menyinkronkan jam tampilan, dan menangani klaim buzzer.

## Menjalankan

### Termux: satu bundel frontend + backend

Salin atau clone folder proyek ini ke perangkat yang memiliki Node.js, Go, dan
toolchain C yang diperlukan oleh SQLite. Di Termux, pasang toolchain yang
sesuai lalu install dependency frontend dari root:

```sh
pkg update
pkg install nodejs-lts golang python make clang
npm install
npm run dev
```

Perintah tunggal tersebut menjalankan Go backend dan Vite pada `0.0.0.0`:
backend HTTP/WebSocket di port `3000`, frontend di port `5173`. Buka `http://localhost:5173`
di perangkat yang sama, atau `http://<IP-LAN-ponsel>:5173` dari perangkat lain.
Frontend otomatis memakai hostname yang sama untuk backend; tidak perlu
mengatur IP atau CORS secara manual. Perubahan frontend memakai Vite HMR. Data
SQLite disimpan di `backend/data/zawa.sqlite`, dan dapat dipakai langsung oleh
backend Go maupun backend Node lama.

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
endpoint dan konfigurasi tersedia di [README backend Go](./backend-go/README.md).

## Pengujian end-to-end

```sh
npm run test:e2e
```

Tes ini menjalankan backend Go dan frontend pada port khusus serta memakai
database SQLite sementara. Cakupannya termasuk sinkronisasi dan distribusi
WebSocket, lock pemenang, feedback klik instan, serta klaim yang tertunda di
jaringan. Server menetapkan pemenang berdasarkan klaim valid pertama yang
diproses; waktu klien tidak digunakan sebagai bukti urutan sentuhan fisik.

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
- Papan skor, status kuis, dan hasil buzzer disiarkan lewat WebSocket. Server
  menyimpan satu pemenang secara atomik; klik lokal langsung dikunci dan
  menampilkan status terkirim sambil menunggu konfirmasi server. Jika koneksi
  terputus, klien mencoba menyambung ulang dan kembali memakai polling HTTP
  selama WebSocket belum tersambung. Kalibrasi jam menyelaraskan tampilan waktu
  mulai ronde, bukan menentukan pemenang.

Data contoh generik dibuat saat aplikasi pertama kali dibuka dan state lama dari
`lcc-local-state-v1` dimigrasikan satu kali ke backend saat tersambung. Sesudah
migrasi berhasil, backend SQLite menjadi sumber data utama dan key lama dihapus;
`lcc-backend-cache-v1` hanya cache/fallback lokal. Browser atau profil berbeda
berbagi data selama terhubung ke backend yang sama. Gunakan tombol reset panel
admin untuk menghapus seluruh data kuis.