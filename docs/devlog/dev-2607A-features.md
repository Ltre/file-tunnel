## 2026-07-02 Preview, Tunnel Switcher, Media Cache, and Share Intake

### Media Preview Gestures
- Fullscreen image/video preview can now be closed by clicking the transparent empty area around the media, not only the top-right close button.
- File preview supports double-click on cached image/video media to enter fullscreen.
- Touch gestures in file preview now distinguish horizontal and vertical intent: horizontal swipes switch adjacent collection files, upward swipes enter fullscreen for cached image/video, and downward swipes close the file preview.
- Fullscreen preview supports downward swipe to exit while preserving horizontal swipe for previous/next navigation.

### Collection Navigation
- Collection child preview keeps the existing previous/next buttons and keyboard navigation, and now captures touch gestures more reliably on Android Chrome by listening during the capture phase and disabling default media touch handling.
- Returning from a child preview to the collection grid keeps the grid-only state, so the fullscreen button remains hidden when the grid itself is shown.

### Transfer Record Anchors and Progress Cleanup
- Transfer record scrolling now stores the current visible message anchor in the local `sessions` record.
- Reloading a tunnel attempts to restore that anchor instead of always jumping to the bottom; while the page is still settling, DOM updates preserve the pinned anchor to reduce jumpiness.
- Deleting a file or collection now clears progress UI items for the removed file IDs and drops stale queue snapshots when no real progress item remains, preventing empty drawers such as `1 涓换鍔?路 1 涓瓑寰卄.

### Media Thumbnails
- Single video file records no longer create `<video>` elements in the transfer list. They use cached generated posters when available, or a lightweight video placeholder.
- Video records and collection video tiles show a video badge in the lower-right corner.
- Audio records and collection audio tiles try to extract embedded MP3 ID3/APIC cover art and cache it locally. When no cover is available, they use a lightweight audio placeholder.
- Audio thumbnails show a music badge in the lower-right corner.

### PWA Shared Files
- Android/PWA share-target imports now collect all pending shared files first.
- If more than one file is shared into the app, the same `浠ュ悎杈戝彂閫?/ 鎷嗗垎鎴愬鏉 dialog used by normal multi-file selection is shown before publishing.

### Tunnel Switcher and Remarks
- The mobile tunnel tab still opens the switcher only when the tunnel tab is already focused.
- The switcher can be dismissed by clicking the transparent backdrop.
- The close control moved to the switcher dialog's top-right as an `X` button.
- The current tunnel is scrolled into view when the switcher opens, as close to vertical center as practical.
- The switcher includes slim top/bottom scroll helper buttons for long tunnel lists.
- Switching away from a tunnel now warns when transfer tasks appear active, because switching will stop the current page's transfer work.
- The device connection panel now shows `闅ч亾鍚嶇О` above the session ID when the current tunnel has a remark.

### Mobile Layout and Editor Height
- Mobile workspace panels now sit in a horizontal track and animate between `杩炴帴 / 闅ч亾 / 鍗忓悓`, giving a smoother folder-switching feel than hide/show toggling.
- Horizontal swipe navigation is allowed from the collaborative editor area; only clear horizontal gestures switch panels, so normal typing and caret placement remain unaffected.
- Collaborative editor height is fixed with viewport-aware constraints on desktop and mobile, keeping the rich-text send controls reachable without scrolling the whole page to the bottom.

### Telegram Bot Intake
- Telegram file handling now checks the update-provided `file_size` first and also checks `getFile.file_size` before downloading the full file.
- Oversized Telegram files are rejected before the server downloads their content whenever Telegram provides size metadata.

## 2026-07-02 鍥炲綊淇琛ュ厖

### Tunnel Switcher
- Tunnel switcher scroll helper buttons are now shown only when the tunnel list actually overflows its visible container.
- The focused/current tunnel still scrolls into view after layout settles.

### Mobile Workspace Gestures
- Mobile `杩炴帴 / 闅ч亾 / 鍗忓悓` panels now use a drag-following horizontal track: the track follows the finger during the gesture and snaps to the nearest/next panel on release, closer to Telegram-style folder switching.
- Mobile panel widths are fixed to the viewport (`100vw` per panel) to prevent the collaborative editor area from shrinking to an apparent partial-width layout.

### File Preview Gestures
- File preview and fullscreen touch gestures now use pointer capture and lower movement thresholds, improving Android Chrome reliability.
- Collection child previews support horizontal swipe on the preview media itself to switch adjacent files.
- Fullscreen downward swipe requires a shorter, clearer downward movement to exit.

### Transfer Record Anchor
- Transfer record anchor restore now keeps a longer post-load stabilization window.
- If the saved anchor is unavailable, the transfer list pins to the bottom during initial settling so later DOM work does not visibly push the viewport around before the user scrolls.

### Collaborative Editor Height
- The collaborative editor panel is now a fixed viewport-aware flex column. The editor body scrolls internally and the send controls stay reachable on desktop and mobile.

### Telegram Bot Tunnel Mode
- Telegram bot supports `/tunnel 12345` to bind the current Telegram chat to a tunnel relay mode.
- While bound, forwarded files and text messages are sent directly into that tunnel; formatted Telegram text is converted to simple rich text when entities are present.
- Telegram bot supports `/leave_tunnel` to leave relay mode and clear pending unbound files for that chat.

## 2026-07-02 Gesture and Anchor Follow-Up

### Mobile Workspace Swipe
- The collaborative editor body now declares horizontal gesture intent with `touch-action: pan-y`, so mobile browsers keep horizontal movement available for the workspace track while preserving vertical editor scrolling.
- Workspace drag starts with a smaller movement threshold and no longer cancels an active drag just because the pointer leaves the moving track, improving the "finger attached to page" feel inside the rich-text editor.

### Transfer Record Anchor
- Transfer record restore now pins against the actual message DOM element after initial scroll restoration and keeps correcting its viewport position during the page settling window.
- If the saved message DOM cannot be found, the transfer list pins to the bottom during settling instead of letting later DOM growth push the view around.
- Scroll-anchor saves also run after pointer interaction and when the page is hidden, making the next load more likely to restore the last browsed record.

### Collection Preview Swipe
- Collection child preview horizontal swipe threshold is lower, making adjacent-file switching more responsive on Android Chrome while still checking horizontal intent.

## 2026-07-02 Audio Cover Cache

### Audio Poster Extraction
- Audio thumbnail extraction now supports MP3 ID3 `APIC`/legacy `PIC` frames, including common ID3v2.2/2.3/2.4 frame layouts.
- M4A/MP4 audio files now scan the metadata atom tree for `covr/data` artwork and cache JPEG/PNG/GIF covers when present.
- FLAC files now scan native metadata blocks for `PICTURE` artwork and cache the embedded cover.
- Audio detection now falls back to common filename extensions such as `.mp3`, `.m4a`, `.aac`, `.alac`, `.flac`, `.ogg`, and `.opus`, so files with weak browser MIME detection can still show cached covers in single-file records and collection grids.
