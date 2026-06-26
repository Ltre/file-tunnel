## Step 4 - Device Profile and Direct Tunnel Invites

### Branch

- Work branch: `dev-260625-multi-relay-NEWCODE`
- Staging/commit: not staged, not committed.

### Device Profile Modal

- Reworked the home-page device profile modal into a header-first layout.
- The modal header now places the QR code on the left and the device name on the right.
- The detail area now lists device ID, model, internal IP, external IP, and a clickable device profile link.
- Removed the meaningless tunnel field from the modal.
- Added follow/unfollow behavior to the modal action button.

### Device Lists

- Removed the separate info button from the online device list.
- Device names now open the device profile modal directly.
- Replaced the direct intercom button visual with a loudspeaker-style icon.
- Reused the same device-row layout for followed devices and online devices.

### Device Profile Page

- Adjusted `/device/:deviceId` page layout.
- Moved the QR code into the header near the device identity.
- Added a compact device logo, large device name, and device ID in the header.
- Reused the previous left QR area as a vertical quick-action rail.
- Added large quick action buttons: voice call, intercom, and start tunnel transfer.
- Removed the bottom “enter current tunnel” action.
- Renamed the copy action to “copy device link”.

### Direct Tunnel Invite

- Added a lightweight device tunnel invite event path over Socket.IO.
- The standalone device page keeps a local direct-tunnel pool and reuses the same target device's previous direct tunnel when available.
- The device page can create an invite link with receipt parameters and push it to the target device when online.
- If the target device is offline, the invite is stored in the sender browser's local pending invite queue.
- The home app flushes pending invites after socket connection.
- The receiver gets a confirmation prompt and sends an acknowledgement before entering the invited tunnel.

### Notes

- Voice call and intercom quick actions on the standalone device page currently guide users back to the full home app context, because those media flows depend on the initialized app media controller.
