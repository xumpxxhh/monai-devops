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

3. Export the frontend files without starting a web container:

   ```bash
   docker build --target web-dist --output type=local,dest=./web-dist .
   ```

   The output directory contains `index.html`, `assets/` and other static files. Mount or copy that directory into the existing Nginx container at the location serving `/devops/`; a one-time `docker cp` is not persistent across Nginx container recreation. The image is built with Vite base `/devops/` and browser API base `/api/v1/devops`.

4. Configure the existing Nginx gateway to serve `/devops/` from these files and proxy `/api/v1/devops/` to `http://devops-server:3000` over their shared Docker network. Preserve the API request path, forward WebSocket upgrade headers, and disable proxy buffering for SSE. Validate and reload Nginx.
5. Check `GET /api/v1/devops/healthz`, open `/devops/`, and exercise a workflow run with live events.

Protect both routes with HTTPS and authentication before public access. Back up the database before migrations and plan restarts around active workflow runs.
