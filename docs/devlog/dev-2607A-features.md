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
- Deleting a file or collection now clears progress UI items for the removed file IDs and drops stale queue snapshots when no real progress item remains, preventing empty drawers such as `1 个任务 · 1 个等待`.

### Media Thumbnails
- Single video file records no longer create `<video>` elements in the transfer list. They use cached generated posters when available, or a lightweight video placeholder.
- Video records and collection video tiles show a video badge in the lower-right corner.
- Audio records and collection audio tiles try to extract embedded MP3 ID3/APIC cover art and cache it locally. When no cover is available, they use a lightweight audio placeholder.
- Audio thumbnails show a music badge in the lower-right corner.

### PWA Shared Files
- Android/PWA share-target imports now collect all pending shared files first.
- If more than one file is shared into the app, the same `以合辑发送 / 拆分成多条` dialog used by normal multi-file selection is shown before publishing.

### Tunnel Switcher and Remarks
- The mobile tunnel tab still opens the switcher only when the tunnel tab is already focused.
- The switcher can be dismissed by clicking the transparent backdrop.
- The close control moved to the switcher dialog's top-right as an `X` button.
- The current tunnel is scrolled into view when the switcher opens, as close to vertical center as practical.
- The switcher includes slim top/bottom scroll helper buttons for long tunnel lists.
- Switching away from a tunnel now warns when transfer tasks appear active, because switching will stop the current page's transfer work.
- The device connection panel now shows `隧道名称` above the session ID when the current tunnel has a remark.

### Mobile Layout and Editor Height
- Mobile workspace panels now sit in a horizontal track and animate between `连接 / 隧道 / 协同`, giving a smoother folder-switching feel than hide/show toggling.
- Horizontal swipe navigation is allowed from the collaborative editor area; only clear horizontal gestures switch panels, so normal typing and caret placement remain unaffected.
- Collaborative editor height is fixed with viewport-aware constraints on desktop and mobile, keeping the rich-text send controls reachable without scrolling the whole page to the bottom.

### Telegram Bot Intake
- Telegram file handling now checks the update-provided `file_size` first and also checks `getFile.file_size` before downloading the full file.
- Oversized Telegram files are rejected before the server downloads their content whenever Telegram provides size metadata.
