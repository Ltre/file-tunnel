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

## 2026-07-02 Async Media Poster Cache

### Send Latency
- Sending single files, split batches, and collections no longer waits for video frame extraction or audio cover parsing before publishing the transfer record.
- Media poster generation now runs in a local background queue after file bytes are cached, then refreshes affected single-file records and collection previews when each poster is ready.
- Poster generation remains a local UI cache only; it is not broadcast as session history and does not affect cross-device record alignment or file-resource synchronization.

## 2026-07-02 Fast Batch Publish Follow-Up

### Batch Send Latency
- Multi-file collection messages now publish from `File` metadata first, before reading every selected file into `ArrayBuffer` and before writing those bytes into IndexedDB.
- Split multi-file sends also publish each transfer record first, then prepare the actual local file asset cache in a background outbound queue.
- The background queue saves file bytes, announces resource availability, refreshes the affected transfer record, and then lets the existing media-poster queue generate video/audio thumbnails.
- Own-device auto cache restore is disabled for these just-published deferred records, avoiding fake self-download progress before the local outbound cache is ready.
## 2026-07-02 Audio Preview and Background Music Player

### Temporary Listening
- Audio file preview no longer renders a plain native audio control. It now shows a cover-first preview card with filename, seek bar, time display, and a centered play/pause control.
- Opening an audio preview starts temporary listening and pauses any active background music queue. Closing the preview restores the previous background queue playback and shows a short toast when restoration succeeds.

### Full Music Player
- Audio previews expose a live music-note button beside the close control. Clicking it promotes the current audio file into the background music queue and opens a fullscreen music player.
- If another track is focused in the background queue, the previewed track is inserted and played immediately. If the same track is already focused, playback continues from the existing position.
- The fullscreen player supports cover art, track title, artist/album placeholders, duration, estimated bitrate, sample-rate placeholder, codec display, seek, play/pause, previous/next, and minimize.
- Once the fullscreen player has been opened, the top bar shows a live music-note button for returning from minimized playback.

## 2026-07-02 Music Queue Player Polish

- Added a half-screen fullscreen-player queue drawer with a YT Music style pull handle; the player compresses into the upper half while the queue is open.
- Persisted the browser music queue, current track index, and playback position in localStorage, then rehydrates cached files from IndexedDB on startup instead of saving blob URLs.
- Changed the topbar music entry to appear whenever a queue exists; the icon animates only while playing, and the current track name scrolls in the topbar only during playback.
- Handed off temporary audio preview playback time into the fullscreen player so entering the player continues from the preview timestamp.
- Kept audio preview controls usable after minimizing or closing the fullscreen player by letting the preview controls target the background track when it is the same audio file.
- Removed the fullscreen player bottom metadata chips so the bottom area is reserved for queue interaction.

## 2026-07-02 Music Player Queue and Media Session Fixes

- Slightly tightened the topbar action spacing so the four left-side icons read as one balanced group.
- Fixed the fullscreen music queue pull handle placement so the visible handle is also the active touch/click target, and lowered the upward drag threshold for mobile.
- Added marquee behavior for long fullscreen player track names while keeping short names static.
- Added Media Session API metadata and controls for mobile system notification drawers, including title, artist, album, artwork, play/pause, previous/next, seek, and position state updates.

## 2026-07-02 Music Player Back Navigation and Metadata

- Added a dedicated fullscreen music player history state so Android back gestures and browser back keys minimize the player to the background instead of leaving the tunnel page.
- Added audio text metadata extraction for ID3v2/ID3v1 MP3, MP4/M4A ilst atoms, and FLAC Vorbis comments, then cached title/artist/album fields in IndexedDB for future opens.
- Updated music queue hydration and Media Session metadata to use parsed track title, artist, and album instead of falling back to file names whenever metadata exists.
- Added a visibility/focus return hook so when background music is playing and the page is brought back from the system media notification, the fullscreen music player is opened.

## 2026-07-03 Music Player Actions, Routing Memory, and Telegram Bot Config

### Music Player
- Added a horizontally scrollable action strip between the fullscreen player's artist/album line and seek bar.
- Added favorite/unfavorite, locate-file, share, and download actions for the current track. Favorites are stored locally and also mirrored onto the cached file record as `mediaFavorite`.
- Random queue continuation now appends a non-duplicate cached audio track when playback reaches the queue tail. If favorites exist, the random pool prefers favorites; otherwise it falls back to cached audio in the current tunnel.
- Queue rows now keep title and artist/duration left-aligned and automatically scroll the active track into view when the queue drawer opens.
- Removed the previous visibility/focus heuristic that reopened the fullscreen player whenever the browser regained focus. This avoids accidental player opens after file picker use or app switching; Media Session controls continue to handle playback actions.
- Normalized fullscreen player close/minimize/back behavior so returning from a player opened via audio preview keeps the file preview layer in place instead of dropping to the collection grid or transfer list.

### Telegram Bot Configuration
- Moved Telegram bot token and webhook secret out of `tunnel.config.json`. Runtime now reads/writes `.tunnel-data/telegram-bot.json`.
- Added `/tgbot` as an admin configuration page and added an admin-page entry link.
- Added `/api/telegram/config` endpoints for reading status and saving bot settings. Token and webhook secret values are not returned in full; leaving sensitive fields empty keeps existing values unless the operator explicitly clears them.

### Route Page
- Added a joined-tunnel selector to the route page, sorted by tunnel ID, with the recent tunnel highlighted in the option label.
- Added a "remember my choice" checkbox. Remembered tunnel selection auto-enters only for root/PWA launches without a hash, and is cleared when the user manually switches, joins by code, creates a tunnel, or opens a hash URL.

## 2026-07-03 Music Player and Route Page Follow-up

### Music Player
- Fixed next-track behavior at the queue tail so manually pressing next also attempts to append a random non-duplicate cached audio track from the local media pool.
- Increased queue drawer drag thresholds and smoothed the drawer/body transitions so the drawer no longer jumps open from a tiny gesture.
- Hid the fullscreen player's action strip while the queue drawer is open, then restored it when the queue closes.
- Decoupled audio preview controls from the background player. Returning from fullscreen playback now resets temporary-listening controls instead of letting the preview seek bar mirror background playback.
- Closing an audio preview or handing it off to fullscreen playback resets temporary-listening progress to zero; pressing preview play again creates a fresh temporary listener and pauses background music.

### Route Page
- Removed the remembered-tunnel checkbox and storage logic. Root/PWA launches now resume the most recent local tunnel directly when possible.
- Removed the explicit "join tunnel" button. Entering all 5 short-code characters automatically looks up and opens the tunnel.
- Adjusted route-page action colors so entering the selected tunnel reads as primary while creating a new tunnel remains secondary.

## 2026-07-03 Regression Follow-up

### Music Player
- Scoped persisted music queues by device and tunnel so switching tunnels no longer keeps another tunnel's background music queue alive.
- Filtered the random continuation pool to the current tunnel's locally favorited audio files, using both the favorite ID list and the cached file `mediaFavorite` marker.
- Kept queue-tail random continuation active for manual next-track presses as well as natural playback completion.

### Tunnel Metadata
- Persisted tunnel remarks into the server infra SQLite store and restored them when an in-memory session is recreated.
- Included tunnel remarks in the admin/session list payload so server-side tunnel metadata and client-side display stay aligned.

### Collections and Mobile UI
- Made visible collection preview tiles in the transfer list open their file preview directly while preserving collection-aware file actions.
- Hardened mobile three-panel navigation by normalizing the active panel after page visibility, resize, orientation, and pointer-cancel edge cases.

## 2026-07-04 Music Player Cover and Queue Focus Fix

### Music Player
- Kept automatic queue-tail preloading as a background-only action. When the player preloads the next random audio track, it no longer focuses or scrolls the queue to that preloaded track.
- Added a current-track intent timestamp so background preloading preserves the active song unless the user explicitly changes tracks during the preload window.
- Forced the fullscreen player cover DOM to resync with the current track after opening from either the audio preview layer or the topbar music entry. This prevents the first-open cover from staying on the placeholder while the queue data already has the audio poster.
- When a cached audio poster is generated or refreshed for the current track, the active fullscreen cover is forced to repaint instead of waiting for a later open/close cycle.
- Added `currentTrackId` as the authoritative active-song identity alongside `currentIndex`. Queue rendering now normalizes the index from the active file ID before highlighting or scrolling, so a preloaded next track cannot become the visible queue anchor while another song is actually playing.
- Reopening the fullscreen player from the topbar or from an audio preview resets the queue drawer open state. The queue drawer will only focus the active song when the user opens it deliberately.
- Fixed persistence for tracks automatically appended at the queue tail. Auto-picked library tracks are created from full IndexedDB file-cache records, so their `fileInfo` is now sanitized before saving the queue to localStorage; this prevents large cached file payloads from breaking queue persistence.
- Queue-tail append now forces an immediate music-player state save, and player state is also saved on `pagehide`/hidden visibility transitions for better PWA/mobile reliability.
- Added a durable IndexedDB-backed copy of the music player queue under the current session record. Restore now compares localStorage and the session copy; if localStorage only contains a subset of the more complete session queue, the session queue wins.
- Automatic queue-tail appends now wait for the durable session copy to be written, so songs inserted by random continuation are not dependent on delayed localStorage-only persistence.
- Decoupled the fullscreen player's `-` and `X` buttons from asynchronous history back handling. When the queue drawer is open, these buttons now close the drawer state synchronously, clear the music-player history marker, and immediately minimize or close the player instead of waiting for a `popstate` callback.
- Persisted an explicit `queueOrder` for every music queue item and normalized queue restore order from that value.
- Hardened restore merging when localStorage and the IndexedDB session copy contain the same songs in different orders. If the active track appears at the first position in one copy but later in the other, the restore path keeps the non-leading order to avoid a queue-tail song jumping to the front after refresh.
- During queue restore, the active track is resolved by file ID after filtering unavailable cached files; the player no longer falls back to index `0` unless the active file is genuinely missing from the restored queue.

## 2026-07-05 Preview, Backup, Mount, Mobile, and Telegram Follow-up

### File Preview and Transfer List
- Reduced the audio-preview play/pause control opacity and blur so album artwork remains visible beneath the control.
- Replaced file-preview action labels with compact `i`, `↓`, `🧲🔗`, `🧹释放空间` / `☁↓ 还原文件`, and `✖删除` controls.
- Kept all file-preview actions on one horizontally scrollable row on narrow mobile screens.
- Added the file name below poster artwork for single audio and video records in the transfer list, including records refreshed after a cache arrives.
- Added an `🖴 外部文件` source marker to single-file and collection views for files supplied from a local filesystem handle.

### Transfer History Backup and Restore
- Added metadata-only and full-data JSON backup exports for the current tunnel's transfer history.
- Added import placement choices for preserving original timestamps or appending records at the current tunnel tail while retaining their original order.
- Metadata backups retain source server, source tunnel, short code, owner/provider IDs, and per-asset source-session information.
- Added cross-tunnel asset lookup: imported metadata requests providers from the original tunnel while reusing the existing P2P and Socket.IO transfer paths. This requires the source deployment and at least one source-tunnel provider to be online.
- Full-data imports register the importing device as a current-tunnel provider immediately, allowing other devices to fetch restored assets.

### Tunnel Routing and Mobile Workspace
- Added a compact local session-directory cache so the route selector can render immediately without waiting for a full IndexedDB scan or network response.
- Rendered the locally known current short code immediately, then allowed the server response to reconcile it later.
- Hardened tunnel exit by suppressing late session rewrites and deleting messages, file caches, editor state, session metadata, compact-directory entries, and filesystem mounts before redirecting to `/?leave=1`.
- Reworked the mobile three-panel track around a single explicit workspace index and viewport-width panels. Visibility, resize, orientation, pointer cancellation, programmatic file location, and tab selection all normalize through the same state path.
- File and progress-anchor location now scrolls only the transfer-record container instead of using document-level `scrollIntoView`, preventing horizontal workspace displacement and stale bottom-tab focus.

### Local Filesystem Mounts
- Added IndexedDB persistence for read-only local directory and file handles.
- Added `挂载本机目录` and `关联本机文件` actions to the resource browser.
- Mounted files are published without duplicating their payload into browser storage. When another device requests a file, the provider reads the authorized local handle and sends it through the existing transfer strategy; receivers cache it normally.
- If a local handle becomes unavailable, the record remains recoverable from another online device that already cached the same asset.
- Directory publishing currently limits one traversal to 500 files. File System Access API support and a secure browser context are required.

### Telegram Bot Relay
- Removed Telegram token and webhook-secret fields from `tunnel.config.json`; runtime secrets are stored only in `.tunnel-data/telegram-bot.json`.
- `/tgbot` now validates the token, generates a webhook secret, persists the configuration, registers the webhook, and registers the `tunnel` and `leave_tunnel` bot commands.
- Telegram webhooks acknowledge immediately and process downloads asynchronously to reduce duplicate retries.
- Added persistent bound/unbound reply-keyboard states, bare `/tunnel` short-code prompting, `/leave_tunnel`, pending-content cancellation, and follow-up short-code handling for text, rich text, files, and collections.
- Caption text is treated as a short code only when the code resolves to a real tunnel, preventing unrelated five-character caption words from producing misleading invalid-code errors.
- Telegram `media_group_id` updates are buffered, ordered by message ID, and published as one collection in both bound and unbound modes.
- Added Telegram voice, animation, and video-note file recognition alongside document, photo, video, and audio handling.

## 2026-07-05 Filesystem Handle Source State

- Split filesystem-handle readability from browser-cache completeness in the file preview state model.
- On secure Chromium contexts, the normal click-to-select path now uses `showOpenFilePicker()` so newly sent local files can retain a real `FileSystemFileHandle`; unsupported browsers keep the existing `<input type=file>` cache path.
- Drag-and-drop attempts `DataTransferItem.getAsFileSystemHandle()` and falls back to the original `File` transfer whenever a persistent handle is unavailable.
- A file is treated as a handle-only local source only when IndexedDB contains no binary payload and the current handle permission plus `getFile()` read both succeed.
- Handle-only local sources show `💾` before the file name in preview layer G and omit both `释放空间` and `还原文件` actions.
- Permission denial, missing source files, and handle read failures remove the valid-source icon and fall back to the existing missing-file and restore flow with a more specific status label.
- Files that have both a valid handle and an actual browser-cache payload retain the normal cache-release behavior.
- Video/audio poster and metadata extraction may read a handle-backed file transiently, but strips that transient `File` before saving metadata so the original binary is not copied into IndexedDB.
- Handle validity is now persisted after preview checks and all `外部文件` badges are derived from the current local handle-only state instead of the message's historical `isExternalFile` flag.
- Completing a remote restore clears stale cache/restore flags, revokes the previous handle-backed object URL, and refreshes the transfer-list record, collection tiles, and active preview without requiring a page reload.

## 2026-07-05 PWA Share, Routing, and Handle-State Fixes

- Confirmed the current server and service worker both support `/share` and `/share/` share-target entry routes; direct browser GET and PWA POST both redirect into `/?share=1`.
- Normal file-send entry points now auto-detect a single `.tunnel-backup` / `.tunnel-backup.json` history backup and import it instead of publishing the backup JSON as a file record.
- Exiting a tunnel now removes the compact local session-directory entry, and the landing route selector ignores/rebuilds away stale sessions that do not have a valid five-character short code.
- Mobile workspace tab clicks and swipes are marked as user-selected, and history rendering now re-settles the current workspace instead of forcing the view back to transfer records.
- Visible handle-backed file records are revalidated when the page regains focus/visibility; if the source handle becomes unreadable, stale object URLs are revoked and the flat record, collection tiles, and preview actions fall back to the restore flow immediately.
