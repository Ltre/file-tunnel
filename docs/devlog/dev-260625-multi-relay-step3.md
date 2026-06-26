# dev-260625-multi-relay step3

## UI Theme System

- Added three homepage themes: Classic, Graphite, and Atelier.
- Themes adjust more than color: page background, panel material, border radius, shadow depth, accent colors, and desktop column proportions.
- Added a desktop theme switcher in the main header.
- Added a mobile topbar theme cycle button so mobile/PWA users can switch themes while the desktop header is hidden.
- Theme choice is saved in localStorage as `uiTheme`.

## Device Profile And Follow

- Upgraded device-name interaction from a temporary detail toast to a profile modal.
- Profile modal shows device ID, model, internal IP, external IP, tunnel identity, profile link, and QR code.
- Added a Follow button to store a device as a local contact.
- Added a local `contacts` IndexedDB store and memory fallback support.
- Added a contacts panel under the connected-device list.

## Contacts

- Added a followed-device list with profile, voice-call, and intercom actions.
- Contact records are keyed by `deviceId` and include name, model, IP summary, session ID, short code, profile URL, followed time, and last-seen time.
- Contacts are loaded during app startup after IndexedDB is ready.

## Cross-Tunnel Contact Calls

- Added global contact call signaling independent of the current tunnel room.
- New socket events: `contact-call-request`, `contact-call-accepted`, `contact-call-rejected`, `contact-call-ended`, and `contact-media-signal`.
- Added `contactVoice` media kind in the browser media controller.
- Caller sees a dialing overlay; callee sees an incoming-call overlay with Answer and Reject buttons.
- Accepted calls show an active call overlay with call duration and a Hang Up button.
- Offline contact targets now immediately return an `offline` rejection instead of leaving the caller stuck dialing.

## Notes

- File payloads and media streams still do not persist on the server.
- Contact data is currently local to the browser profile.
- Cross-tunnel contact calls rely on the target device being online and registered in the server's `deviceSockets` map.
