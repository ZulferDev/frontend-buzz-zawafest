# Backend Go ZAWA

Backend LAN mandiri memakai Go, Gorilla WebSocket, dan SQLite. HTTP tetap
menyediakan API state yang dipakai panel admin; `/ws` mengirim perubahan state,
kalibrasi waktu, dan adjudikasi klaim buzzer. File SQLite memakai tabel
`competition_state` yang sama dengan backend lama, sehingga database lama dapat
dipakai langsung.

## Jalankan lokal

Perlu Go 1.24+, compiler C untuk `go-sqlite3`, dan dependency Go yang bisa
diunduh saat build:

```sh
cd backend-go
go run ./cmd/server
```

Server mendengarkan pada `0.0.0.0:3000`; Vite dapat dijalankan terpisah dari
root proyek dengan `npm run dev:frontend`. Buka alamat LAN mesin server pada
port `5173` dari perangkat peserta. `npm run dev` menjalankan Go backend dan
Vite sekaligus.

Variabel yang umum digunakan:

| Variabel | Default | Kegunaan |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Alamat bind server |
| `PORT` | `3000` | Port HTTP dan WebSocket |
| `FRONTEND_PORT` | `5173` | Port frontend yang diizinkan untuk koneksi lokal |
| `SQLITE_PATH` | `../backend/data/zawa.sqlite` | Database SQLite |
| `BUZZER_START_DELAY_MS` | `2000` | Jeda persiapan ronde |
| `FRONTEND_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origin tambahan, dipisahkan koma |

`docker build -t zawa-backend backend-go` membuat image mandiri. Jalankan dengan
`docker run --rm -p 3000:3000 -v "$PWD/data:/data" zawa-backend`; container
menyimpan database di `/data/zawa.sqlite`.

## Adjudikasi dan waktu

WebSocket menerima `SYNC_TIME` dan membalas `SYNC_ACK` dengan waktu server.
Klien mengukur RTT memakai `performance.now()` dan menggunakan offset untuk
menjadwalkan tampilan ronde. Klaim `BUZZ` diputuskan oleh server: lock SQLite
menjadikan klaim valid pertama yang diproses pemenang, lalu hasil tersimpan
sebelum `WINNER`/`STATE` disiarkan. Timestamp klien dicatat sebagai metadata
protokol tetapi **tidak** mengubah urutan pemenang; jam klien dan waktu paket
tiba tidak dapat membuktikan urutan sentuhan fisik. REST `/api/buzzer` tetap
tersedia untuk kompatibilitas.

WebSocket memakai ping/pong dan klien melakukan reconnect dengan backoff.
Endpoint tidak memiliki autentikasi admin; gunakan hanya pada LAN tepercaya
atau tambahkan autentikasi sebelum membuka akses lebih luas.
