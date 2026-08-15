upstream file_tunnel_node_{{id}} {
    server 127.0.0.1:{{serverPort}};
    keepalive 32;
}

map $http_upgrade $file_tunnel_connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen {{nginxListenPort}};
    listen [::]:{{nginxListenPort}};
    server_name {{domain}};
    client_max_body_size 1g;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json application/manifest+json image/svg+xml;

    location /socket.io/ {
        proxy_pass http://file_tunnel_node_{{id}};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $file_tunnel_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://file_tunnel_node_{{id}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
