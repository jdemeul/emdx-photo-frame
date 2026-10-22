# EMDX photo frame

A small service for a NAS that shows a different photo every day from a shared Google Photos album on a Samsung EMDX colour e-paper display. It picks the photo, crops it for the frame and sends it to the display over the network. In playlist mode it sends weeks of photos at once and the display changes them itself, so it can stay in deep sleep in between. A web page on the NAS shows what is on the frame and what comes next.

It runs as a single Docker container. It was written for a Synology NAS (a DS420+, with a 32" EM32DX hung in portrait), but any always-on Docker host on the same network as the display will do.

- **Shuffle without repeats:** every photo in the album is shown once before anything repeats. Photos added to the album later join the current round.
- **Odd shapes get paired:** on a portrait frame, landscape and square photos are shown two at a time, preferably two taken around the same time. Portrait photos fill the frame, smart-cropped around the most interesting part.
- **The display does the final dithering:** the NAS crops and tones the photo, and the panel's own algorithm turns it into ink dots. A NAS-side ditherer is included as `DITHER=local`, but on the EM32DX the panel's own processing looked better.
- **Deep sleep between photos:** in playlist mode the display changes the photo itself every night and sleeps deeply in between. It comes online briefly after each change, and that is when the NAS checks the battery and, when needed, sends the next batch of photos.

What we found out about the EM32DX along the way (sleep, wake-up, playlists, dithering): [docs/findings.md](docs/findings.md).

## 1. What you need

| | Where to find it |
|---|---|
| **Album share link** | Google Photos → the album → Share → *Create link*. It looks like `https://photos.app.goo.gl/…` (the full `https://photos.google.com/share/…?key=…` address works too). Anyone with this link can view the album. |
| **Display IP address** | Router or the Samsung E-Paper app. Give the display a fixed DHCP lease. |
| **Display PIN** | The 6-digit device security PIN you set when configuring the display in the Samsung E-Paper app. |
| **Display MAC address** | Router or app. Only needed for Wake-on-LAN (`SLEEP_MODE=standby`). |
| **NAS IP address** | DSM → Control Panel → Network. |

On the display (Samsung E-Paper app), set **Screen Orientation** to match how it hangs (`.env.example` assumes portrait).

## 2. Install on a Synology NAS (Container Manager)

1. Copy this folder to the NAS, e.g. `/volume1/docker/emdx-photo-frame` (File Station, a mapped drive, or `git clone`).
2. In that folder, copy `.env.example` to `.env` and fill in `ALBUM_URLS`, `EMDX_HOST`, `EMDX_PIN` and `SERVER_HOST`.
3. DSM → **Container Manager** → **Project** → **Create**. Choose the folder; it picks up `docker-compose.yml`. Let it build and start; the first build takes a few minutes. (Over SSH instead: `cd /volume1/docker/emdx-photo-frame && sudo docker compose up -d --build`.)
4. If the DSM firewall is on, allow TCP **8321** from your LAN. The display downloads the photos from that port.

The container uses host networking and restarts automatically. Its state (which photos were shown, the planned photos, history) lives in a Docker volume, `frame-data`, so updating by copying a new version of the folder over the old one keeps it. To start over, stop the project and delete the volume over SSH (`sudo docker volume ls` shows its name, ending in `frame-data`; `sudo docker volume rm <name>` removes it).

## 3. First run

Open `http://<NAS-IP>:8321` and press the display's power button to wake it.

1. Press **Show test pattern** and walk over to the display; the panel takes 20–50 s to redraw. **"▲ TOP"** must be at the top with all four corner marks visible: if not, set `ROTATE=90`, `180` or `270` in `.env` and restart the project. The six swatches should be the six inks, and the two sets of colour bands compare the NAS ditherer with the display's own (**"Smooth"**, the default `DITHER=device`).
2. Press the power button again if the display has gone back to sleep, then **Send playlist** (playlist mode) or **Next photo now** (push mode).
3. In playlist mode, the **Playlist** tab shows the coming days. At the next `SCHEDULE` time the frame should change to the next photo by itself, and **After a change** shows that the display came online right after it.

## 4. How the photo changes

### Playlist mode (`UPDATE_MODE=playlist`, best on battery)

Use it with `SLEEP_MODE=deep`.

- The NAS renders the photos for the coming `PLAYLIST_DAYS` (default 7, up to 60) and sends them as the display's own playlist: the photo for now until the next `SCHEDULE` time, then one photo per change. The display changes the photo by itself and sleeps in between, with its Wi-Fi off.
- After each change the EM32DX comes online briefly. The NAS looks for it then (for up to `WAKE_WINDOW_MIN`) and reads its battery. Once fewer than `PLAYLIST_TOPUP_DAYS` (7) days are left on it, the NAS sends a fresh playlist; otherwise it leaves the display alone, and the display goes back to sleep by itself. No button presses needed.
- A fresh playlist starts with the photo already on the frame, so nothing changes on screen. If none arrives in time, the display starts its playlist over, still at the change times. Changes follow `SCHEDULE` in your time zone, also across daylight-saving switches.
- **How long a playlist?** Each photo goes to the display as a full-colour PNG of typically 2–4 MB, so 30 days come to roughly 60–130 MB; the display has 8 GB of storage. What costs battery is the download (Wi-Fi on for as long as it takes), not changing the photo. A long playlist that is only topped up in its last week therefore means a few big downloads instead of many. The page lists the battery for every day.

### Push mode (`UPDATE_MODE=push`, the default, for mains power)

At every `SCHEDULE` time the NAS renders the next photo and sends it, so the display must be reachable then: on USB-C power with `SLEEP_MODE=off`, or with `SLEEP_MODE=standby`, where the NAS wakes it with Wake-on-LAN (needs `EMDX_MAC`). Network standby costs about 1.5% battery an hour, and on battery the EM32DX stops hearing Wake-on-LAN after many hours. An update that can't reach the display is retried 3 times, 20 minutes apart (`RETRIES`, `RETRY_MINUTES`). In deep sleep the photo waits until the display is found awake.

### Sleep

Two minutes after an update (`SLEEP_DELAY_SEC`, time for the panel to redraw), the NAS powers the display off: with network standby off (`deep`), or on (`standby`), or it leaves sleeping to the display's own settings (`off`). It then checks that the display stopped answering, and if not, tries once more and reports it on the page.

Playlist mode with deep sleep is the exception: there the display goes to sleep by itself (its own Sleep After, set in the Samsung app), and the NAS sends no power-off command. After that command the EM32DX stayed asleep but on the Wi-Fi for days (see [findings](docs/findings.md)); going to sleep by itself, it was off the Wi-Fi until the next change.

Every `SLEEP_CHECK_MIN` minutes (30) the NAS also checks, without waking it, that the display is still asleep, and whether it is off the Wi-Fi: a display that is asleep but still on the Wi-Fi (a light sleep, about 1.5% battery an hour) shows in red on the page. A display found awake (someone pressed its button, it is charging) gets what is waiting for it, a photo or a fresh playlist, or is put back to sleep. In playlist mode the display also wakes up by itself and goes back to sleep by itself, so the NAS leaves it alone from 15 minutes before each change until 15 minutes after, and otherwise puts it back to sleep only when it was already awake at the previous check and is not charging.

## 5. The web page

- **Preview**, **Original photos** and **Playlist** (the coming days, the one for now outlined) on the left; **Test pattern** shows the last one sent.
- **New photo for today** (push mode: **Next photo now**) replaces the photo for now; **Send playlist** (**Send again**) sends it to the display now, if it is awake; **Check display** reads its battery and settings.
- **Deep sleep now** (`SLEEP_MODE=deep`): sends the display into deep sleep the way the Samsung E-Paper app does (its *Deep sleep mode* setting again, then its *Sleep* button), then watches it for about 8 minutes: it should stop answering, then drop off the Wi-Fi. The Display row shows how far it got. It sets Sleep After to 10 minutes if it was off. Wake-on-LAN reaches a display in a light sleep, so this also works when the page says it is still on the Wi-Fi.
- **After a change**: when the display came online after its last changes, with the battery. **Battery**: the latest reading and one per day. **Display**: asleep or awake, and whether a sleeping display is off the Wi-Fi. **Sleep checks**: when the display was found awake otherwise. **Recent**: what was sent, and when.

The same status is available as JSON at `/api/status`, with the last requests the display made to the NAS. `UI_PASSWORD` protects the page.

## 6. Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `ALBUM_URLS` | — | One or more share links, comma-separated |
| `PHOTO_DIR` | — | Extra source: a NAS folder mounted at `/photos` (see `docker-compose.yml`) |
| `EMDX_HOST`, `EMDX_PIN` | — | The display's address and MDC PIN. Without `EMDX_HOST` nothing is sent (a dry run, to preview the album) |
| `SERVER_HOST`, `HTTP_PORT` | guessed, 8321 | The address the display downloads from, and the port of the web page |
| `PANEL` / `ORIENTATION` / `ROTATE` | EM32DX / landscape / 0 | EM13DX also known; or set `PANEL_WIDTH`/`PANEL_HEIGHT` |
| `UPDATE_MODE` | push | `playlist` (the display changes the photos itself) or `push` (the NAS sends each photo) |
| `SCHEDULE`, `TZ` | `0 6 * * *`, Europe/Brussels | When the photo changes (cron syntax) |
| `PLAYLIST_DAYS` | 7 | Playlist mode: days per playlist (1–60) |
| `PLAYLIST_TOPUP_DAYS` | 7 | Playlist mode: a fresh playlist goes out once fewer days than this are left on the display |
| `SLEEP_MODE` | standby | After each update: `deep` (network standby off), `standby` (on; Wake-on-LAN wakes it) or `off` |
| `EMDX_MAC`, `WOL_BROADCAST` | —, 255.255.255.255 | For Wake-on-LAN (`SLEEP_MODE=standby`). Try your network's broadcast address (e.g. 192.168.1.255) if it doesn't wake |
| `SLEEP_DELAY_SEC` | 120 | Time for the panel to redraw before the display is sent to sleep |
| `SLEEP_CHECK_MIN` | 30 | How often to check that the display is asleep, and off the Wi-Fi. `0` turns the check off |
| `WAKE_WINDOW_MIN` | 15 | Playlist mode: how long the NAS looks for the display after each change |
| `RUN_ON_START` | false | When the service starts: send a photo right away (push mode), or the playlist if one is due (playlist mode) |
| `RETRIES`, `RETRY_MINUTES` | 3, 20 | Push mode: retries of an update that couldn't reach the display |
| `ODD_PHOTOS` | pair | `pair`, `crop` (smart-crop to fill) or `fit` (white margin) |
| `DITHER` | device | The display dithers. `local` dithers on the NAS instead |
| `SATURATION`, `CONTRAST` | 1.0, 0.1 | Tone tweaks before sending (1.3, 0.25 with `DITHER=local`) |
| `GAMMA`, `SHARPEN` | 1.0, 0.8 | Midtone lift and sharpening |
| `DITHER_METHOD`, `PALETTE`, `OUTPUT_COLORS` | bluenoise, measured, device | `DITHER=local` only: `diffusion` (with `DITHER_KERNEL`), measured ink colours as JSON, and which colours to write into the PNG |
| `UI_PASSWORD` | — | Protects the web page (basic auth) |

## 7. Commands

Run them on the NAS with `sudo docker exec emdx-photo-frame node src/index.js <command>`:

- `check-album`: read the album and print what was found.
- `display-info`: print the display's name, battery and settings (changes nothing; in deep sleep press its power button first).
- `sleep`: put the display to sleep now and wait until it stops answering.
- `sleep-test [minutes]`: for `SLEEP_MODE=standby`, check that Wake-on-LAN wakes the display, optionally after letting it sleep that many more minutes.
- `once`, `test-pattern`: send the next photo (in playlist mode: the playlist) or the test pattern. These start their own web server, so use them only while the service is stopped; while it runs, use the buttons.
- `render <photo>`: render a photo file to `<DATA_DIR>/render-test/` (no display needed).

To try it without a display, leave `EMDX_HOST` empty: `docker build -t emdx-photo-frame . && docker run --rm -p 8321:8321 --env-file .env -e EMDX_HOST= -v "$PWD/data:/data" emdx-photo-frame`, then open http://localhost:8321.

## 8. How it works

1. **Album.** Google closed the Photos Library API for existing albums in March 2025, and its alternatives are pick-by-hand or partner-only. So this reads the album the way its public web page does: the first page of items is embedded in the HTML, and later pages come from the same endpoint the page uses. This is unofficial and may break if Google changes the page; the last good list is cached meanwhile. Videos are skipped.
2. **Layout.** libvips' attention-based smart crop (sharp), with EXIF orientation honoured. Pairs split the frame in proportion to the photos' shapes, so both lose about the same amount.
3. **Tone.** Gentle auto-levels, an S-curve and optionally a saturation boost, in Oklab.
4. **Dither.** By default the display dithers the toned photo itself. With `DITHER=local` the NAS maps colours into the gamut of the six measured inks and dithers with a blue-noise mask, writing pure ink colours into the PNG.
5. **Sending.** The NAS connects with Samsung MDC (TLS + PIN) and points the display at a small JSON manifest on its own web server; the display downloads it and the images in it. A playlist is the same manifest with several images, each with its own display time in milliseconds, as Samsung's E-Paper app sends it. The trick and the MDC client come from [node-samsung-emdx](https://github.com/WeeJeWel/node-samsung-emdx) and [@weejewel/samsung-mdc](https://github.com/WeeJeWel/node-samsung-mdc) by Emile Nijssen; the playlist format from Samsung's Android app.

## 9. Troubleshooting

- **"accepted the command but never downloaded"**: the display can't reach `http://SERVER_HOST:HTTP_PORT`. Check `SERVER_HOST`, the DSM firewall, and that the display and the NAS are on the same network.
- **"Incorrect PIN"**: check `EMDX_PIN`. After several wrong PINs the display may block MDC for a while.
- **"It is in deep sleep, where Wake-on-LAN does not reach it"**: press the display's power button, then the button on the page again (it waits up to 30 s for the display); or leave it to the next sleep check (every `SLEEP_CHECK_MIN` minutes), which sends whatever is waiting. In playlist mode the display also comes online by itself after each change.
- **"Fresh playlist due"** (playlist mode): the display needs a new playlist. It gets one the next time it is online, after its next change or a press on its power button. Until then it keeps playing the playlist it has.
- **The photo didn't change** (playlist mode): press the display's power button, then **Send playlist**. That starts a fresh playlist with the photo for today, so the display and the page agree again. Keep the display's own screen protection time (Samsung E-Paper app) away from the change time.
- **"Asleep, but still on the Wi-Fi"** (deep sleep): the display is in a light sleep and uses about 1.5% battery an hour. Your router's client list shows the same (connected for hours on end). Press **Deep sleep now** (or press its power button, then **Send playlist**, and let it go to sleep by itself); within a few minutes it should drop off the Wi-Fi. If it stays on the Wi-Fi even then, restart the display: hold its power button until the screen goes white, then switch it on again.
- **"Could not connect"** (push mode): the display is asleep or offline. Check `EMDX_MAC`, its battery, and run `sleep-test`; try `WOL_BROADCAST` set to your network's broadcast address.
- **"The display did not go to sleep"**: it took the power-off command but kept answering, so it is using battery. The NAS tries again at every sleep check.
- **Album errors**: run `check-album`. If it fails while the link opens fine in a browser, Google probably changed the page format; the frame keeps using the cached list meanwhile.
- **Photos too dark or flat on the panel**: try `SATURATION=1.15`, `CONTRAST=0.2` or `GAMMA=1.15`.

Logs: Container Manager → Container → emdx-photo-frame → Log.

## Development

```bash
npm install
npm test     # unit tests, and end-to-end runs against a fake EMDX and a mock album (needs openssl)
```

The fake display (`test/helpers/fakeEmdx.js`) speaks MDC over TLS, downloads content like the real one, plays playlists, sleeps, and wakes on Wake-on-LAN or after a playlist change.

## Credits

The measured palette comes from [epdoptimize](https://github.com/paperlesspaper/epdoptimize). The album item format follows [google-photos-album-image-url-fetch](https://github.com/yumetodo/google-photos-album-image-url-fetch) and [gphotos-scraper](https://github.com/jmsalazardev/gphotos-scraper).

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Samsung or Google.
