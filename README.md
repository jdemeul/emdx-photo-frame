# EMDX photo frame

Every morning, this little service on the NAS picks a photo from a shared Google Photos album, crops it to the Samsung EMDX e-paper display, dithers it to the panel's six inks, and pushes it to the display. It also serves a small web page on the NAS where you can see what's on the frame (simulated), skip to the next photo, or send a test pattern.

It runs as a single Docker container. It was written for a Synology NAS (tested on a DS420+ with a 32" EM32DX hung in portrait), but any always-on Docker host on the same network as the display will do.

- **Shuffle without repeats:** every photo in the album is shown once before anything repeats. Photos added to the album later join the current round.
- **Odd shapes get paired:** on a portrait frame, landscape and square photos are shown two at a time, stacked, preferably two taken around the same time. Portrait photos fill the frame on their own, smart-cropped around the most interesting part.
- **The display does the final dithering:** the NAS crops, tones and sends the photo, and the panel's own algorithm turns it into ink dots. A NAS-side ditherer (gamut mapping plus blue noise) is included as `DITHER=local`, but on the EM32DX the panel's own processing looked clearly better side by side (see [Findings](#findings-nas-vs-panel-dithering)).
- **Sleeps between updates:** two minutes after each photo, the NAS powers the display off. Only its Wi-Fi listener stays on, so the next update can wake it with Wake-on-LAN (see [Sleep and battery](#6-sleep-and-battery)).

## 1. What you need

| | Where to find it |
|---|---|
| **Album share link** | Google Photos → the album → Share → *Create link*. It looks like `https://photos.app.goo.gl/…` (the full `https://photos.google.com/share/…?key=…` address works too). Anyone with this link can view the album. |
| **Display IP address** | Router or the Samsung E-Paper app. Give the display a fixed DHCP lease. |
| **Display MAC address** | Router/app. Lets the NAS wake the display from sleep (Wake-on-LAN). |
| **Display PIN** | The 6-digit device security PIN you set when configuring the display in the Samsung E-Paper app. |
| **NAS IP address** | DSM → Control Panel → Network. |

On the display (via the Samsung E-Paper app): set **Orientation** to match how it hangs (`.env.example` assumes portrait) and turn **Network Standby** on. Network Standby is the Wi-Fi listener that lets Wake-on-LAN wake the display; the NAS also switches it on each time it puts the display to sleep.

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
   - The two sets of colour bands compare the NAS ditherer (`DITHER=local`) with the display's own processing (**"Smooth"**, the default `DITHER=device`). On an EM32DX the display's own looked better. If the NAS bands look better on your panel, set `DITHER=local`.
2. Press **Next photo now**.
3. Check that the NAS can wake the display: over SSH, run `sudo docker exec emdx-photo-frame node src/index.js sleep-test`. It puts the display to sleep, waits until it stops answering, then wakes it with Wake-on-LAN and puts it back to sleep (under a minute when it works).

From then on it updates every day at 06:00 (`SCHEDULE`), and two minutes after each update the display goes back to sleep. If the display can't be reached at 06:00, it retries 3× at 20-minute intervals.

## 4. Try it on a laptop first (optional)

No display needed. Leave `EMDX_HOST` empty for a dry run:

```bash
cp .env.example .env    # set ALBUM_URLS
docker build -t emdx-photo-frame .
docker run --rm --env-file .env emdx-photo-frame node src/index.js check-album
docker run --rm -p 8321:8321 --env-file .env -e EMDX_HOST= -v "$PWD/data:/data" emdx-photo-frame
```

Then open http://localhost:8321 and press **Next photo now** a few times to preview the album. To render one of your own files: `docker run --rm --env-file .env -v "$PWD/data:/data" -v "/path/photo.jpg:/in.jpg:ro" emdx-photo-frame node src/index.js render /in.jpg`. The result lands in `data/render-test/`.

Other commands (`sudo docker exec emdx-photo-frame node src/index.js <cmd>` on the NAS):

- `check-album`: read the album and print what was found.
- `display-info`: connect to the display and print its name, battery and Network Standby. Changes nothing on the display.
- `sleep [standby|deep]`: put the display to sleep now (default: `SLEEP_MODE`).
- `sleep-test [standby|deep]`: check that Wake-on-LAN wakes the display from that kind of sleep (see [First run](#3-first-run) and [Sleep and battery](#6-sleep-and-battery)).
- `once`, `test-pattern`: show the next photo or the test pattern. These start their own web server, so use them only while the service is stopped (e.g. with `docker run --rm`); while it runs, use the buttons on its web page.

## 5. Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `ALBUM_URLS` | — | One or more share links, comma-separated |
| `PHOTO_DIR` | — | Extra source: a NAS folder mounted at `/photos` (see `docker-compose.yml`) |
| `PANEL` / `ORIENTATION` / `ROTATE` | EM32DX / landscape / 0 | EM13DX also known; or set `PANEL_WIDTH`/`PANEL_HEIGHT` |
| `SCHEDULE`, `TZ` | `0 6 * * *`, Europe/Brussels | Cron syntax |
| `ODD_PHOTOS` | pair | `pair`, `crop` (smart-crop to fill) or `fit` (white margin) |
| `DITHER` | device | The display dithers. `local` dithers on the NAS instead (see [Findings](#findings-nas-vs-panel-dithering)) |
| `SATURATION`, `CONTRAST` | 1.0, 0.1 | Tone tweaks before sending. With `DITHER=local` the defaults are 1.3, 0.25 |
| `GAMMA`, `SHARPEN` | 1.0, 0.8 | Midtone lift and sharpening before sending |
| `DITHER_METHOD` | bluenoise | `DITHER=local` only. `diffusion` for classic error diffusion (`DITHER_KERNEL`: floyd-steinberg, stucki, jarvis, sierra, atkinson) |
| `PALETTE` | measured Spectra 6 | `DITHER=local` only. JSON of measured ink colours, if you photograph/measure your own panel |
| `OUTPUT_COLORS` | device | `DITHER=local` only. `measured` writes the measured RGB values into the PNG instead of pure colours |
| `SLEEP_MODE` | standby | After each update: `standby`, `deep` or `off` (see [Sleep and battery](#6-sleep-and-battery)) |
| `SLEEP_DELAY_SEC` | 120 | Time for the panel to redraw before it is sent to sleep |
| `WOL_BROADCAST`, `WOL_PORT` | 255.255.255.255, 9 | Where the Wake-on-LAN packet goes. Try your network's broadcast address (e.g. 192.168.1.255) if the display doesn't wake |
| `UI_PASSWORD` | — | Protects the web page (basic auth) |

## 6. Sleep and battery

E-paper keeps its picture without power, but a display that stays awake on Wi-Fi uses battery. So once the panel has redrawn (`SLEEP_DELAY_SEC`), the NAS powers the display off. `SLEEP_MODE` picks how deeply it sleeps:

| | `standby` (default) | `deep` | `off` |
|---|---|---|---|
| After an update | Network Standby on, power off | Network Standby off, power off | nothing: the display follows its own settings |
| What wakes it for the next update | the NAS, with Wake-on-LAN (needs `EMDX_MAC`) | only Wake-on-LAN, if it still gets through without Network Standby | the NAS, with Wake-on-LAN |
| Battery with one update a day (Samsung's figures for its sleep and deep sleep modes) | up to 70 days | up to 80 days | depends on its settings |

Samsung's battery figures are for the 32" EMDX, from pre-release lab tests ([product page](https://www.samsung.com/au/business/smart-signage/others/color-e-paper-emdx-a-lh32emdiagbxxy/)).

Deep sleep would buy roughly ten extra days per charge, but the display must still be woken for the next update. With Network Standby off, its Wi-Fi listener is off too, so Wake-on-LAN may not get through. And there is no known way to make it wake itself on a schedule over MDC: the EM32DX refuses the "on-timer" command (`0x25`) listed in some notes. To find out whether `deep` works on yours, run `sudo docker exec emdx-photo-frame node src/index.js sleep-test deep`. If Wake-on-LAN doesn't wake it, press the display's power button, run `sleep standby`, and keep the default.

The sleep commands (MDC `0x11` power, `0xB5` Network Standby) follow the EMDX command notes in [taylorRichie/node-samsung-emdx](https://github.com/taylorRichie/node-samsung-emdx/blob/main/docs/MDC-COMMANDS.md).

## 7. How it works

1. **Album.** Google closed the Photos Library API for existing albums in March 2025. The official alternatives are the Picker API (pick by hand) and the Ambient API (partner program only). So this reads the album the way its public web page does: the first page of items is embedded in the HTML, and later pages come from the same endpoint the page uses. This is unofficial and may break if Google changes the page. The last good list is cached, so the frame keeps going meanwhile. Videos are skipped.
2. **Crop/layout.** libvips' attention-based smart crop (sharp) is used, with EXIF orientation honoured. Pairs split the frame in proportion to the photos' shapes, so both lose about the same amount.
3. **Tone.** Gentle auto-levels, an S-curve and (optionally) a saturation boost are applied in Oklab.
4. **Dither.** By default the NAS sends the toned photo as a PNG at the panel's native resolution and the display dithers it. With `DITHER=local` the NAS does it instead:
   - *Gamut:* the image's white and black are mapped to the paper white and ink black. Colours the inks can't make are pulled toward grey until they fit inside the convex hull of the six measured ink colours, which is everything dithering can reproduce.
   - *Dither:* each colour is written as an exact mix of at most five inks: a grey from black and white, plus the hull face around its hue. A 64×64 blue-noise mask then picks one ink per pixel in those proportions. The PNG uses pure colours (#FF0000 etc.); the web preview uses the measured colours.
5. **Push.** The NAS sends Wake-on-LAN, connects with Samsung MDC (TLS + PIN) and sends command `0xC7` with a URL. The display then downloads a small JSON schedule and the PNG from this container. This trick comes from [node-samsung-emdx](https://github.com/WeeJeWel/node-samsung-emdx), and the MDC client from [@weejewel/samsung-mdc](https://github.com/WeeJeWel/node-samsung-mdc), both by Emile Nijssen.

## 8. Troubleshooting

- **"accepted the command but never downloaded"**: the display can't reach `http://SERVER_HOST:HTTP_PORT`. Check `SERVER_HOST`, the DSM firewall, and that the display and the NAS are on the same network.
- **"Incorrect PIN"**: check `EMDX_PIN`. After several wrong PINs the display may block MDC for a while.
- **"Could not connect"**: the display is asleep or offline. Set `EMDX_MAC` for Wake-on-LAN, run `sleep-test`, try `WOL_BROADCAST` set to your network's broadcast address, or raise `WAKE_WAIT_SEC`. In `deep` sleep, press its power button and go back to `SLEEP_MODE=standby`.
- **"the display refused MDC command …"**: this firmware doesn't support that command. Please open an issue with the full message.
- **Album errors**: run `check-album`. If it fails while the link opens fine in a browser, Google probably changed the page format. The frame keeps using the cached list in the meantime.
- **Photos too dark or flat on the panel**: try `SATURATION=1.15`, `CONTRAST=0.2` or `GAMMA=1.15`.
- **Project won't start, `./data` not found**: create an empty `data` folder next to `docker-compose.yml`.

Logs: Container Manager → Container → emdx-photo-frame → Log.

## Findings: NAS vs panel dithering

The test pattern shows the same colour bands twice: dithered on the NAS, and left to the display. Zoomed in on a phone photo of an EM32DX (left: NAS, right: panel; rows: dark grey, green/blue, red/orange):

![NAS dithering (left) vs the panel's own (right)](docs/dither-nas-vs-panel.jpg)

- **Colour:** the panel trades lightness for saturation. It shows a real orange, a dark green and an actual blue, where the NAS version keeps the original lightness and comes out pale (salmon, grey-teal, hardly any blue).
- **Texture:** in dark greys the NAS mixes only black and white, which leaves bright specks on black. The panel mixes black with blue, a much quieter texture.
- **Brightness:** the two grey ramps are about equally bright, and the display shows the NAS image pixel for pixel (the blue-noise pattern is visible). So the difference is the algorithm: Samsung's is tuned to its own inks.

Beating it on the NAS would take a chroma-preserving gamut mapping, low-contrast ink pairs for dark tones, and calibration against photos of the panel.

## Credits

The measured palette comes from [epdoptimize](https://github.com/paperlesspaper/epdoptimize). The album item format follows [google-photos-album-image-url-fetch](https://github.com/yumetodo/google-photos-album-image-url-fetch) and [gphotos-scraper](https://github.com/jmsalazardev/gphotos-scraper).

## Development

```bash
npm install
npm test     # unit tests + an end-to-end run against a fake EMDX and a mock album (needs openssl)
```

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Samsung or Google.
