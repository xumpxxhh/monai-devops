# Deploy the server and export the web assets

The only long-running application container is `devops-server`. It joins the existing Docker network via `APP_DOCKER_NETWORK` and connects to PostgreSQL through `DATABASE_URL`. The frontend is a static `dist` directory for the existing Nginx container; there is no frontend service in Compose.

1. Copy `.env.compose.example` to `.env`; set the existing Docker network, database URL and release tag.
2. Build, migrate and start the server:

   ```bash
   docker compose config --quiet
   docker compose build devops-server
   docker compose --profile tools run --rm devops-migrate
   docker compose up -d --no-build devops-server
   docker compose ps
   ```

3. Mount the shared static directory into the existing Nginx container once:

   ```yaml
   volumes:
     - /opt/monai-infra/www:/usr/share/nginx/html:ro
   ```

   Recreate Nginx once to apply the mount. Future frontend applications only need a new subdirectory under `www/` and a route in Nginx; the mount stays unchanged.

4. Export this application's frontend files directly to `www/devops/` without starting a web container:

   ```bash
   sudo mkdir -p /opt/monai-infra/www/devops
   sudo docker build --target web-dist --output type=local,dest=/opt/monai-infra/www/devops .
   ```

   `www/devops/` contains `index.html`, `assets/` and other static files. The image is built with Vite base `/devops/` and browser API base `/api/v1/devops`.

5. Configure the existing Nginx gateway to serve `/devops/` from its shared root:

   ```nginx
   location = /devops { return 301 /devops/; }
   location /devops/ {
       root /usr/share/nginx/html;
       try_files $uri $uri/ /devops/index.html;
   }
   ```

   Proxy `/api/v1/devops/` to `http://devops-server:3000` over their shared Docker network. Preserve the API request path, forward WebSocket upgrade headers, and disable proxy buffering for SSE. Validate and reload Nginx.
6. Check `GET /api/v1/devops/healthz`, open `/devops/`, and exercise a workflow run with live events.

Protect both routes with HTTPS and authentication before public access. Back up the database before migrations and plan restarts around active workflow runs.
