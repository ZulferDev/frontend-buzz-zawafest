# LCC Lokal

Aplikasi lomba cerdas cermat berbasis Vite untuk satu browser. Panel admin,
layar kuis, dan buzzer peserta berbagi data melalui `localStorage` dan tetap
tersinkron saat dibuka pada beberapa tab di browser/origin yang sama.

## Menjalankan

```sh
npm install
npm run dev
```

Buka alamat lokal Vite. Rute yang tersedia:

- `/` — beranda
- `/admin.php` — panel admin
- `/quiz.php` — layar skor dan pertanyaan
- `/player.php` — pemilihan tim dan buzzer

## Fitur

- Menambah/menghapus tim, mengunggah nada buzzer MP3/WAV, dan mengubah skor
  dengan tombol `+10` / `−5`.
- Menambah, memilih, menghapus, memfilter, mengimpor, serta mengekspor soal.
  Impor/ekspor menggunakan berkas Excel `.xlsx`; kolomnya adalah Kelompok,
  Teks Soal, Jawaban, dan Poin.
- Membuka/menutup babak rebutan, mengatur tampilan standby, mereset buzzer,
  dan mereset seluruh data.
- Papan skor dan buzzer peserta diperbarui antar-tab tanpa backend.

Data contoh generik dibuat saat aplikasi pertama kali dibuka. Semua data tetap
berada di penyimpanan browser; browser atau profil berbeda tidak berbagi data.
Gunakan tombol reset panel admin untuk menghapus seluruh data kuis.