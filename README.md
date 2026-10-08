# EMDX photo frame

Every morning, this little service on the NAS picks a photo from a shared Google Photos album, crops it to the Samsung EMDX e-paper display, dithers it to the panel's six inks, and pushes it to the display. It also serves a small web page on the NAS where you can see what's on the frame (simulated), skip to the next photo, or send a test pattern.

It runs as a single Docker container. It was written for a Synology NAS (tested on a DS420+ with a 32" EM32DX hung in portrait), but any always-on Docker host on the same network as the display will do.

- **Shuffle without repeats:** every photo in the album is shown once before anything repeats. Photos added to the album later join the current round.
- **Odd shapes get paired:** on a portrait frame, landscape and square photos are shown two at a time, stacked, preferably two taken around the same time. Portrait photos fill the frame on their own, smart-cropped around the most interesting part.
- **Dithering on the NAS:** colours are mapped into the gamut of the measured Spectra 6 inks, then dithered with a blue-noise mask. Greys use only black and white, skin only white/red/yellow, and you get no worm or streak artefacts.

## 1. What you need

| | Where to find it |
|---|---|
| **Album share link** | Google Photos → the album → Share → *Create link*. It looks like `https://photos.app.goo.gl/…` (the full `https://photos.google.com/share/…?key=…` address works too). Anyone with this link can view the album. |
| **Display IP address** | Router or the Samsung E-Paper app. Give the display a fixed DHCP lease. |
| **Display MAC address** | Router/app. Lets the NAS wake the display (Wake-on-LAN). |
| **Display PIN** | The 6-digit device security PIN you set when configuring the display in the Samsung E-Paper app. |
| **NAS IP address** | DSM → Control Panel → Network. |

On the display (via the Samsung E-Paper app): set **Orientation** to match how it hangs (`.env.example` assumes portrait) and turn **Network Standby** on. Network Standby keeps it reachable between updates, at some battery cost.

## 2. Install on a Synology NAS (Container Manager)

1. Copy this folder to the NAS, e.g. `/volume1/docker/emdx-photo-frame` (File Station, a mapped drive, or `git clone`). Keep the empty `data` folder: Container Manager won't start the project if it's missing.
2. In that folder, copy `.env.example` to `.env` and fill in `ALBUM_URLS`, `EMDX_HOST`, `EMDX_PIN`, `EMDX_MAC` and `SERVER_HOST`.
3. DSM → **Container Manager** → **Project** → **Create**. Choose the folder; it picks up `docker-compose.yml`. Let it build and start. The first build takes a few minutes. (Over SSH instead: `cd /volume1/docker/emdx-photo-frame && sudo docker compose up -d --build`.)
4. If the DSM firewall is on, allow TCP **8321** from your LAN. The display downloads each image from that port.

The container uses host networking and restarts automatically. Its state, the current image and previews live in `./data`.

## 3. First run

Open `http://<NAS-IP>:8321`.

1. Press **Show test pattern** and walk over to the display. The panel takes 20–50 s to redraw.
   - **"▲ TOP"** must be at the top and all four corner marks visible. If it is sideways or upside down, set `ROTATE=90`, `180` or `270` in `.env` and restart the project.
   - The **six swatches** should be the six inks.
   - Compare the two sets of colour bands. If the **"Dithered by the NAS"** bands look clean and the 1-px patterns look like even grey, the display shows our pixels as sent. If the display's own processing (the **"Smooth"** bands) looks better to you, set `DITHER=device`.
2. Press **Next photo now**.

From then on it updates every day at 06:00 (`SCHEDULE`). If the display can't be reached, it retries 3× at 20-minute intervals.

## 4. Try it on a laptop first (optional)

No display needed. Leave `EMDX_HOST` empty for a dry run:

```bash
cp .env.example .env    # set ALBUM_URLS
docker build -t emdx-photo-frame .
docker run --rm --env-file .env emdx-photo-frame node src/index.js check-album
docker run --rm -p 8321:8321 --env-file .env -e EMDX_HOST= -v "$PWD/data:/data" emdx-photo-frame
```

Then open http://localhost:8321 and press **Next photo now** a few times to preview the album. To render one of your own files: `docker run --rm --env-file .env -v "$PWD/data:/data" -v "/path/photo.jpg:/in.jpg:ro" emdx-photo-frame node src/index.js render /in.jpg`. The result lands in `data/render-test/`.

Other commands (`docker exec emdx-photo-frame node src/index.js <cmd>` on the NAS):

- `check-album`: read the album and print what was found.
- `display-info`: connect to the display and print its name and battery. Changes nothing on the display.
- `once`: show the next photo now.
- `test-pattern`: send the test pattern.

## 5. Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `ALBUM_URLS` | — | One or more share links, comma-separated |
| `PHOTO_DIR` | — | Extra source: a NAS folder mounted at `/photos` (see `docker-compose.yml`) |
| `PANEL` / `ORIENTATION` / `ROTATE` | EM32DX / landscape / 0 | EM13DX also known; or set `PANEL_WIDTH`/`PANEL_HEIGHT` |
| `SCHEDULE`, `TZ` | `0 6 * * *`, Europe/Brussels | Cron syntax |
| `ODD_PHOTOS` | pair | `pair`, `crop` (smart-crop to fill) or `fit` (white margin) |
| `DITHER` | local | `device` sends the toned photo and lets the display dither |
| `DITHER_METHOD` | bluenoise | `diffusion` for classic error diffusion (`DITHER_KERNEL`: floyd-steinberg, stucki, jarvis, sierra, atkinson) |
| `SATURATION`, `CONTRAST`, `GAMMA`, `SHARPEN` | 1.3, 0.25, 1.0, 0.8 | Tone tweaks before dithering |
| `PALETTE` | measured Spectra 6 | JSON of measured ink colours, if you photograph/measure your own panel |
| `OUTPUT_COLORS` | device | `measured` writes the measured RGB values into the PNG instead of pure colours |
| `UI_PASSWORD` | — | Protects the web page (basic auth) |

## 6. How it works

1. **Album.** Google closed the Photos Library API for existing albums in March 2025. The official alternatives are the Picker API (pick by hand) and the Ambient API (partner program only). So this reads the album the way its public web page does: the first page of items is embedded in the HTML, and later pages come from the same endpoint the page uses. This is unofficial and may break if Google changes the page. The last good list is cached, so the frame keeps going meanwhile. Videos are skipped.
2. **Crop/layout.** libvips' attention-based smart crop (sharp) is used, with EXIF orientation honoured. Pairs split the frame in proportion to the photos' shapes, so both lose about the same amount.
3. **Tone.** Gentle auto-levels, an S-curve and a saturation boost are applied in Oklab.
4. **Gamut.** The image's white and black are mapped to the paper white and ink black. Colours the inks can't make are pulled toward grey until they fit inside the convex hull of the six measured ink colours, which is everything dithering can reproduce.
5. **Dither.** Each colour is written as an exact mix of at most five inks: a grey from black and white, plus the hull face around its hue. A 64×64 blue-noise mask then picks one ink per pixel in those proportions. The PNG sent to the display uses pure colours (#FF0000 etc.). The preview on the web page uses the measured colours.
6. **Push.** The NAS sends Wake-on-LAN, connects with Samsung MDC (TLS + PIN) and sends command `0xC7` with a URL. The display then downloads a small JSON schedule and the PNG from this container. This trick comes from [node-samsung-emdx](https://github.com/WeeJeWel/node-samsung-emdx), and the MDC client from [@weejewel/samsung-mdc](https://github.com/WeeJeWel/node-samsung-mdc), both by Emile Nijssen.

The measured palette comes from [epdoptimize](https://github.com/paperlesspaper/epdoptimize). The album item format follows [google-photos-album-image-url-fetch](https://github.com/yumetodo/google-photos-album-image-url-fetch) and [gphotos-scraper](https://github.com/jmsalazardev/gphotos-scraper).

## 7. Troubleshooting

- **"accepted the command but never downloaded"**: the display can't reach `http://SERVER_HOST:HTTP_PORT`. Check `SERVER_HOST`, the DSM firewall, and that the display and the NAS are on the same network.
- **"Incorrect PIN"**: check `EMDX_PIN`. After several wrong PINs the display may block MDC for a while.
- **"Could not connect"**: the display is asleep or offline. Set `EMDX_MAC` for Wake-on-LAN, check Network Standby, or raise `WAKE_WAIT_SEC`.
- **Album errors**: run `check-album`. If it fails while the link opens fine in a browser, Google probably changed the page format. The frame keeps using the cached list in the meantime.
- **Photos too dark or flat on the panel**: try `GAMMA=1.15`, `CONTRAST=0.35` or `SATURATION=1.5`.
- **Project won't start, `./data` not found**: create an empty `data` folder next to `docker-compose.yml`.

Logs: Container Manager → Container → emdx-photo-frame → Log.

## Development

```bash
npm install
npm test     # unit tests + an end-to-end run against a fake EMDX and a mock album (needs openssl)
```

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Samsung or Google.
