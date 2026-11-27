# DockerManager

One web interface for every Docker host you run. Install the agent on each server or VM, and the controller shows all hosts, compose projects and containers in one place, live.

```
  browser  ->  controller (web UI, API, database)  <-  outbound WebSocket  <-  agent on host 1  ->  Docker or Podman socket
                                                   <-  outbound WebSocket  <-  agent on host 2  ->  Docker or Podman socket
                                                   <-  ...
```

Agents connect out to the controller, so hosts behind NAT work and no agent port is opened. The controller keeps the accounts, the hosts, the stacks and the audit log. Agents keep their own credentials, the stack folders and the firewall rules of their host.

DockerManager is young. Try it on hosts you can afford to break before you trust it with production.

## Features

**Hosts and containers**

- Every host, compose project and container in one tree, with live state on every page
- Hosts join with a one time command (`curl ... | sudo sh`) that installs the agent as a systemd service
- Docker and Podman, rootful or rootless, detected on their own
- Start, stop, restart and remove containers, follow their logs live
- Container details: health, restarts, image, ports with their bind address, mounts, networks and environment variable names (never their values)
- Published ports marked public or local, and every program listening on the host

**Monitoring**

- CPU, memory, load, network, disk I/O and filesystems for every host and container, sampled every 10 seconds
- History charts from 1 hour to 1 year, with a crosshair readout and a table view
- Image, container, volume and build cache sizes
- NVMe SMART health and wear, and Linux software RAID state

**Compose stacks**

- Write the compose file and .env in the browser, with checks while you type
- Every save is a version with a diff, and any old version can be restored
- Deploy, start, stop, restart, pull and take down with live output
- Deploys wait for healthchecks and fail when a container is unhealthy, crashes or keeps restarting
- Projects already running on a host can be adopted where they are

**Image updates**

- New builds of `:latest` and newer versions of pinned tags such as `4.5.1`, found without using Docker Hub's pull limit
- Updates change only the image line of the compose file, so comments and formatting stay
- Automatic rollback when the new version does not become healthy
- A policy per service, with optional automatic patch or minor updates

**Backups and transfers**

- Named volumes, folders, stack files and PostgreSQL, MariaDB, MySQL and MongoDB dumps
- Encrypted on the host before upload, to S3 compatible storage, a local folder, SMB or NFS
- A schedule and retention per stack, with verify and restore
- A recovery key that decrypts backups without the controller
- Moving a stack to another host in one step, with its volumes and its backup plan

**Firewall**

- Rules for the host and for published container ports, written one per line
- A preview of what every port gets before anything is applied
- Changes undo themselves after 90 seconds unless you keep them, so a mistake cannot lock you out
- Its own nftables table, which works next to Docker, Podman, ufw and firewalld

**Alerts**

- Offline hosts, high CPU or memory, full filesystems, degraded RAID, failing drives, unhealthy or crashed containers, failed backups and deploys, new image versions
- Sent to ntfy, Discord, email or a signed webhook

**Security**

- Mandatory authenticator codes, a guarded first run setup and an audit log of every action
- Agents connect out to the controller, so no port is opened on the hosts
- Secrets and .env files encrypted at rest

## Roadmap

- Web terminal into containers
- Roles for operators and read only viewers
- Transfers of adopted stacks and stacks with bind mounted folders

## Requirements

- Bun 1.4 or newer to build or run from source. Released Linux executables do not need Bun
- Hosts: Linux with systemd and Docker or Podman. For Podman enable its API socket first: `systemctl enable --now podman.socket`
- For the firewall: the `nft` tool (package `nftables`), installed on current Debian, Ubuntu, Fedora and RHEL servers
- For NVMe health: `smartctl` from the `smartmontools` package on each agent host. RAID status comes from the kernel and needs no extra package
- The controller needs one address both browsers and agents can reach, ideally HTTPS behind a reverse proxy

## Install

Run this on the server that should host the controller:

```bash
curl -fsSL https://github.com/Rabbit-Company/DockerManager/releases/latest/download/install.sh | sudo sh
```

The script picks the build for x86_64 or ARM64, checks the download against its checksum and installs the controller as a systemd service. It asks for the address browsers and agents will use, then prints the link and the setup token to finish in the browser: choose a username and password and scan the code with an authenticator app. No Bun or Docker is needed.

- Use `https://your.domain` when a reverse proxy serves DockerManager. The controller then listens on `127.0.0.1:3000` for the proxy. With a plain `http://` address it listens on port 3000 of every interface.
- Skip the question with `curl ... | sudo DOMAIN=https://docker.example.com sh`. Install a given release with `VERSION=v0.1.0`.
- Run the same command again to update. Your settings are kept.
- Remove it with `curl ... | sudo sh -s -- --uninstall`. Settings and data stay until you delete them.

Settings live in `/etc/dockermanager/controller.env`, all of them listed in `.env.example`. The database and the encryption key live in `/var/lib/dockermanager`, so back up that folder. Logs: `journalctl -u dockermanager-controller`.

`TZ` sets the time zone of backup schedules, job output and container logs. The installer takes it from the system.

### With Docker

```bash
docker compose up -d --build
docker compose logs controller | grep "setup token"
```

Set `DOMAIN` and `TZ` in `docker-compose.yml` first.

### From source

```bash
bun install
bun run dev        # http://localhost:3000, data in data/controller.sqlite
```

The first start prints a setup token in the log. Open `/setup` and enter it.

## Adding a host

1. Click Add host, give it a name.
2. Run the command shown on the server as root. It downloads the agent binary from the controller, enrolls with the one time token and starts the `dockermanager-agent` service.
3. The page switches to the host as soon as the agent connects.

The token works once and expires after an hour. To move an agent to a reinstalled machine, open the host's settings and create a new join command.

Running the agent from a source checkout instead:

```bash
bun run agent enroll --url https://docker.example.com --token dmj_...
bun run agent
```

The agent finds the socket at `/var/run/docker.sock`, `/run/podman/podman.sock` or the rootless Podman socket of the user running it. `CONTAINER_SOCKET` overrides that. Its credentials live in `/etc/dockermanager/agent.json` (mode 600) when run as root.

If the controller uses a certificate from a private CA, point the agent at it with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## Metrics

The agent samples every 10 seconds, also while the controller is unreachable. It keeps up to two hours of samples and sends them when it reconnects.

- Containers are read from their cgroup v2 files and network namespace in `/proc`, which is cheap even with many containers. On cgroup v1 hosts the agent falls back to the engine's stats endpoint.
- Host traffic counts physical interfaces only, so bridge and veth traffic is not counted twice. Disk traffic counts whole disks, not partitions, LVM or RAID devices.
- Container CPU is shown as a share of the whole host, like the host itself. 100% means every core is busy.
- History is keyed by container name, so it continues when compose recreates a container.

The controller keeps raw samples for 24 hours, minute averages for 14 days and hourly averages for a year. Each average also keeps the peak. Change this with `METRICS_RAW_HOURS`, `METRICS_MINUTE_DAYS` and `METRICS_HOUR_DAYS`. With 50 containers per host, raw samples take about 430,000 rows per host per day.

## Storage health

The Storage tab shows each NVMe controller's SMART health, temperature, spare capacity, rated life used, media errors, lifetime writes and power-on hours. It also shows Linux MD RAID member counts and rebuild activity. The agent checks every five minutes. The Alerts page can notify you when a mirror is degraded, SMART reports trouble, drive wear reaches 90% or health cannot be read. Install `smartmontools` on each host and run the agent as root to read the drives. SMART data helps identify trouble but cannot predict every failure, so keep separate backups.

## Stacks

A stack is a compose project the controller manages. Each save of the compose file or the .env file creates a new version, and a deploy sends the current version to the agent, which:

1. writes `compose.yaml` and `.env` (mode 600) to `/opt/dockermanager/stacks/<name>/`, or for an adopted stack back to the folder it came from,
2. runs `docker compose config --quiet`, the full check,
3. runs `docker compose up --detach --remove-orphans`.

The output streams to the browser and is kept with the deploy. The agent uses Docker Compose v2, `podman compose` or the old `docker-compose`, whichever it finds first, against the same socket it reads containers from. A run keeps going if the controller connection drops.

The editor checks the file while you type: valid YAML, a services map, an image or build for every service, port mappings, and volumes, networks and services that are used but not declared. "Check on host" runs `compose config` on the host without changing anything.

.env contents are encrypted on the controller with AES-256-GCM. The key is `SECRETS_KEY`, or a key created in `data/secret.key` on first use. Back it up with the database, because the stack .env files cannot be read without it. Diffs show which keys changed, never values.

Projects started by hand appear under "Running projects not managed here" on the Stacks tab. Adopting one works when it uses a single compose file, because the agent finds the file through the labels compose puts on its containers. Removing a stack can take it down first and, for stacks the controller created, delete their folder. Adopted folders are never deleted.

## Image updates

Every few hours (`UPDATE_CHECK_HOURS`, default 6) the controller asks the registries about every image the stacks use, once per image for all hosts:

- the digest the tag points to now, with a HEAD request that does not count against Docker Hub's pull limit, which shows a new build of `:latest` or of a tag that was pushed again,
- the repository's tags, to find newer versions of the same shape. `4.5.1-alpine` only moves to `x.y.z-alpine`, `17.2` to `17.x` or `18.x`, and release candidates and betas are skipped unless the current tag is one.

Each service has a policy for which updates to offer (patch, minor, all, or none, default minor) and can apply patch or minor updates on its own. An update changes only the image line of the compose file, so comments and formatting stay, saves that as a new version and deploys it with a pull first. When the containers do not run and pass their healthchecks within `HEALTH_TIMEOUT_SECONDS` (default 120), the version that ran before is saved again and deployed. Updates wait while a stack has saved changes that are not deployed.

Private registries need a login under Updates, Registry logins. The password or token is stored encrypted like .env files. Registries reached over plain HTTP are listed in `REGISTRY_INSECURE`.

Registries that need no login work as they are, also when their token service lives elsewhere, as for lscr.io. A stored login is only sent to the registry itself, to Docker Hub's auth service, to ghcr.io for lscr.io, to gitlab.com for registry.gitlab.com, or to an HTTPS origin listed in `REGISTRY_AUTH_REALMS` as `registry.example.com=https://auth.example.com`. When a check fails with "untrusted authentication origin", the message names the origin to add.

## Backups

A backup holds the items chosen for a stack: its named volumes, folders it mounts, its compose file and .env, and dumps of PostgreSQL, MariaDB or MySQL and MongoDB containers (`pg_dumpall`, `mariadb-dump` or `mysqldump`, `mongodump`, run inside the container with its own credentials).

The agent streams each item through `tar`, gzip and AES-256-GCM encryption straight to the destination, so nothing is written unencrypted and no temporary copy is needed:

- **S3 compatible storage** with Bun's built in S3 client and multipart uploads: AWS, Cloudflare R2, Backblaze B2, MinIO, Wasabi.
- **A folder on the host**, which can also be a share mounted there.
- **SMB and NFS**, mounted by the agent to a private folder only while a job runs. This needs `cifs-utils` or `nfs-common`/`nfs-utils` and the agent running as root. SMB credentials go to a mode 600 file, never on the command line.

Each destination has its own random 256 bit key, stored encrypted on the controller. Every file gets a key derived from it with HKDF and a random salt, and is cut into 1 MiB frames whose nonce numbers them and marks the last one, so a changed, reordered or truncated file fails to decrypt. **Save the recovery key** the destination shows when it is created. With it, a backup can be read without the controller:

```bash
dockermanager-agent decrypt --key <recovery key> volume-shop_data-1a2b3c4d.tar.gz.dmbak | tar -xz -C /restore/here
dockermanager-agent decrypt --key <recovery key> dump-db.gz.dmbak | gunzip > db.sql
```

In "stop the containers" mode the dumps run first, then the containers of the stack stop, the folders are saved and the containers start again, also when the backup fails. "Keep them running" has no downtime but files that change while they are read can be inconsistent, so rely on the dumps for databases.

Plans run on a cron schedule in the controller's time zone (Bun's cron parser, so `@daily`, `MON-FRI` and the like work). Retention keeps the newest backup, then the newest of each of the last N days, weeks and months, so two backups on one day count as one daily backup. Verify decrypts every file and checks it against the hash taken when it was written.

Restore stops the stack, unpacks each chosen folder next to the old one and swaps it in only when it is complete, then starts the stack again. Database dumps are not loaded automatically, so a restore never replaces a running database by surprise. Load one by hand, for example `gunzip < db.sql.gz | docker exec -i shop-db-1 psql -U postgres`.

Each backup is a full copy. That keeps restores simple and independent of other backups, at the cost of more storage than an incremental tool.

## Transfer between hosts

Open a managed stack and choose **Transfer**. Pick another online host and a backup destination both hosts can reach. DockerManager checks the target, stops the source, backs up the stack files and named volumes, verifies and restores them on the target, then starts the target and waits for its healthchecks. It then removes the stopped source containers without removing their volumes or stack files. This prevents a restart policy from starting the old copy after a host reboot. If a step fails, DockerManager stops the target and tries to restart the source. The backup is kept either way.

After a successful transfer the backup plan belongs to the stack on the new host, so scheduled backups follow the data, and the update settings of each service are copied. The old stack stays listed with a link to the new copy. Deploying, starting or restarting it is refused, so two copies never run at once. Remove it when the old volumes are no longer needed.

Database files in a named volume are included while the database container is stopped. A database stored only in a container's writable layer is not transferable this way. The transfer checks that recognized database containers have a named volume at their usual data path and that the target mounts the same named volumes. Databases with a custom data path need a manual check. Stacks with bind mounted folders, adopted stacks and transfers between Docker and Podman cannot be transferred. If the controller stops during a transfer, check both hosts before starting either stack.

## Alerts

Every 30 seconds the controller looks at what the agents report. A condition has to hold for the rule's minutes before it fires, and the channels hear about it once when it starts and once when it clears:

| Rule                                   | Default                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| Host offline                           | 2 minutes without the agent                                                   |
| Host CPU or memory high                | above 90% for 10 minutes                                                      |
| Filesystem almost full                 | above 90%                                                                     |
| Container unhealthy                    | failing healthcheck for 2 minutes                                             |
| Container restarting                   | restarting for 1 minute                                                       |
| Container crashed                      | a container of a deployed stack exited with an error, not stopped by a signal |
| Container near its memory limit        | above 95% of its own limit for 5 minutes                                      |
| Backup failed, deploy or update failed | once per run                                                                  |
| Image update available                 | once per new version                                                          |
| Firewall rules undone                  | when new rules were not kept in time                                          |

Each rule can be turned off, given another threshold or duration, and sent to some channels only, on the Alerts page. Alerts of a host whose agent is offline stay open, because there is no data to say they are over. Right after the controller starts, offline hosts are reported only after 3 minutes, so agents have time to reconnect.

Channels:

- **ntfy** on ntfy.sh or your own server, with priority and a link to the page. On ntfy.sh anyone who knows the topic can read it, so pick a long topic or use an access token.
- **Discord** through a channel webhook.
- **Email** through your SMTP server, with STARTTLS, TLS or neither.
- **Webhook**: a JSON POST with `event` (`alert.firing`, `alert.resolved`, `alert.event`, `alert.test`) and `alert` (`rule`, `severity`, `title`, `detail`, `link`, `host`, `at`). The header `X-DockerManager-Signature: sha256=<hex>` is the HMAC-SHA256 of the body with the channel's secret, so a receiver can check it came from here.

Channel settings are stored encrypted. The header shows how many alerts fire, on every page.

## Firewall

The Firewall tab of a host holds its rules, one per line, first match wins:

```
allow tcp 22 from 10.0.0.0/8 to host        # SSH from the LAN
deny tcp 5432 to containers                 # keep the database private
allow tcp 80,443 to containers
allow any 53 from 2001:db8::/32 to host
```

A rule is allow or deny, tcp, udp or any, up to 15 ports or ranges, then optionally `from` an address or network (IPv4 or IPv6) and `to host` or `to containers`, which is the default. Container rules use the published port, the one people connect to, not the port inside the container. Two settings cover the rest: whether other traffic to the host is blocked (loopback, replies, ping, SSH on the port you give and traffic from container networks still pass) and whether other published ports are open or blocked.

Before anything is applied, the tab shows every published port and every program listening on the host with what the rules do to it, such as "allowed from 10.0.0.0/8, otherwise blocked", and the exact nftables rules.

How it works on the host:

- The agent writes one table, `inet dockermanager`, with an input chain for the host and a forward chain for published ports, for IPv4 and IPv6 at once. The whole table is replaced in one `nft -f` transaction, so rules nft refuses change nothing.
- Tables of other programs stay as they are. Every packet passes each table and a drop in any of them is final, so a block here holds with Docker on iptables or on nftables, with Podman, ufw or firewalld. An allow here does not open what another table blocks.
- Container rules match connections Docker or Podman translated to a container (`ct status dnat`) by the port they were made to (`ct original proto-dst`), so traffic between containers is never touched.
- Applied rules are pending for 90 seconds. Keep them on the page, or they undo themselves, also when the agent restarts in between, and the alert "Firewall rules undone" tells you. If a rule cuts you off, wait and the previous rules come back.
- After a reboot the agent puts the kept rules back when it starts, and every minute it checks that the table is still there. Restarting `nftables.service` runs `flush ruleset`, which removes every table, so the agent writes it again.
- "Remove all rules" deletes the table.

## Security

The agent talks to the Docker socket, which is equal to root on that host. Whoever controls the controller controls every host, so:

- Every account needs a password and an authenticator code. A code can be used once.
- The first run page is guarded by a setup token, so nobody else on the network can create the first account.
- Agent secrets, join tokens and session tokens are stored only as digests.
- Forms carry a CSRF token, writes from other origins are refused and the browser socket checks the origin.
- Environment variable values are never sent to the controller, only their names.
- Every action, sign in and failed sign in is in the audit log.

Put the controller behind HTTPS. Over plain HTTP the agent secret and session cookies cross the network in clear text.

## Development

```bash
bun test                          # in-memory SQLite, includes an end to end test with a fake Docker engine
TEST_DATABASE=postgres bun test   # the same on PGlite
bunx tsc --noEmit -p .
bunx prettier --write src tests scripts
bun run build                     # dist/controller, dist/agent-linux-x64, dist/agent-linux-arm64
```

Layout:

- `src/controller/` the web server. `hub.ts` holds the agent connections, `db/` the queries and migrations for SQLite and PostgreSQL, `routes/` the pages and the agent API, `ssr/` the HTML and the stylesheet. Deploys, backups, transfers, updates, alerts and the firewall each have their own module.
- `src/agent/` the agent. `docker.ts` talks to the Engine API over the unix socket, also for Podman. `connection.ts` is one WebSocket session, `stacks.ts` runs compose, `backup/` streams encrypted backups, `firewall.ts` writes the nftables table, `metrics.ts` and `storage.ts` read the host.
- `src/shared/` code used by the controller, the agent and the browser: the message protocol, compose checks, firewall rules, time formats.
- `src/web/` the browser script: live page regions, charts, the compose editor and the log viewer.
- `tests/` with stand-ins for the Docker Engine API, compose, nft, S3 and the alert receivers.

Pages are rendered on the server. Elements marked `data-live` are fetched again and swapped when the browser socket reports a change.

## License

EUPL-1.2
