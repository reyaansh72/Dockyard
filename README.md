# Dockyard

**A local-first control center for Docker Engine.** Dockyard uses Node.js built-ins and the Docker Engine API over its Unix socket. There are no npm runtime dependencies and no Docker-in-Docker layer.

## Project map

```text
config/images.json   Editable image catalog
public/              HTML, CSS, and browser JavaScript
src/server.js        Node HTTP server and Docker API proxy
```

Add objects to the `images` array in `config/images.json` to change the Pull Image catalog. Each entry needs an `image` reference; `name`, `category`, `description`, `tags`, and `color` are optional. The dialog reloads the manifest whenever it opens.

## Run

Requirements: Node.js 20+ and a running Docker Engine. The Node process must be able to access the Docker socket, usually `/var/run/docker.sock`.

```sh
npm start
```

Open <http://127.0.0.1:3000>. During development, `npm run dev` restarts the server on source changes; `npm run check` validates the JavaScript files.

### Sign-in

For password-protected sign-in, configure credentials before launch:

```sh
DOCKYARD_USER=admin DOCKYARD_PASSWORD='replace-with-a-strong-secret' npm start
```

If `DOCKYARD_PASSWORD` is unset, the sign-in screen explicitly enters local preview mode: it creates a local session but does not authenticate users. Use that mode only on a trusted machine. Opt-in remembered profiles save usernames only in this browser; passwords are never saved. Standard sessions expire after eight hours; “Remember me” sessions expire after 30 days. Sessions are held in server memory, so restarting the server signs users out. Cookies are HttpOnly and SameSite.

### Server options

Set `DOCKER_SOCKET`, `DOCKER_API_VERSION`, `PORT`, and `HOST` to use a different Engine socket, API version, port, or bind address. The server binds to `127.0.0.1` by default. Docker socket access is effectively root-equivalent on many hosts; do not expose Dockyard to an untrusted network.

## Workspace

- **Containers:** create with environment, ports, mounts, networks, resource limits, restart policy, labels, and startup options; start, stop, restart, pause, resume, kill, rename, duplicate, inspect, view/follow/download logs, bulk manage, and export CSV.
- **Images:** search the editable catalog, filter categories, favorite and revisit images, pull with per-layer progress or cancel, tag, inspect, view history, remove, and launch containers.
- **Networks and volumes:** create, inspect, attach/detach containers, remove, and prune unused resources.
- **Resource monitor:** inspect live CPU, memory, and network counters per running container; filter, sort, and optionally refresh every five seconds.
- **Docker Events:** browse the last hour, 6 hours, day, or week; filter by resource type or search, inspect an event, and export the window as JSON.
- **Cleanup and Activity:** prune unused Docker resources and review this browser’s recent successful actions.
- **Profiles and sessions:** pick from up to eight remembered usernames, keep an opted-in session for up to 30 days, clear saved profiles, and switch accounts.
- **Material appearance:** system/light/dark mode, accent presets or custom color, surface shape, density, sidebar width, reduced motion, and refresh cadence.
- **About:** runtime and Docker diagnostics, auth/socket status, and keyboard help.

Press `Ctrl+K` or `⌘K` to search pages and common actions such as creating containers, pulling images, refreshing data, and switching color mode. Press `/` to focus the current page’s search and `Esc` to close a dialog or palette.