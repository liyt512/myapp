# 留白 API

API service for the Android app. It uses SQLite for accounts, friend requests,
posts, likes, and comments. Uploaded media stays in a persistent data directory
outside the repository.

Online music search and playback default to the iTunes Search API for
Chinese songs (30-second previews). No API key is needed. The server searches
the TW storefront first (CN returns empty results from this API) and falls
back to HK. Each result returns a 30-second `previewUrl`, artist credit and
an Apple Music track page; the app displays all three. Full songs are not
provided — use local audio upload for full tracks you have rights to.

Jamendo remains available as a legacy source via
`GET /api/music/search?source=jamendo`. Create an app in the Jamendo
Developer Portal and set its client ID as `JAMENDO_CLIENT_ID` in the
private server environment file if you want to keep it. Do not commit that
value to Git. The catalog is for non-commercial use under the API terms;
the app displays artist credits and a direct link to each Jamendo track page.

## Local development

Use a supported Node.js release, then run `npm install` and `npm start` from this
directory. Set `JWT_SECRET` to a random value of at least 32 bytes. The API binds
to `127.0.0.1:8080` by default; place a TLS reverse proxy in front of it for
remote clients.

## Routes

- `POST /api/register`, `POST /api/login`, `GET /api/me`
- `GET /api/users?q=...`, `GET /api/friends`
- `POST /api/friend-requests`, `POST /api/friend-requests/:id/accept`
- `DELETE /api/friend-requests/:id`, `DELETE /api/friends/:userId`
- `GET /api/posts`, `POST /api/posts`, `DELETE /api/posts/:id`
- `GET /api/music/search?q=...&offset=...&source=itunes` (authenticated search, default `itunes`; `jamendo` for legacy)
- `GET /api/music/tracks/:id/audio?source=itunes` (resolves the current stream / preview URL)
- `POST|DELETE /api/posts/:id/like`
- `GET|POST /api/posts/:id/comments`
- `GET /api/media/:filename` (short-lived, signed URL)

Media uploads are limited to 50 MB per file (20 MB for audio). Supported types
are common JPEG/PNG/WebP/GIF images, MP4/WebM/MOV videos, and MP3/M4A/AAC/WAV/OGG
audio files.
