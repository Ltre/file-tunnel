[Unit]
Description=Drop2Tunnel {{id}}
After=network.target

[Service]
Type=simple
WorkingDirectory={{remotePath}}/current
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
