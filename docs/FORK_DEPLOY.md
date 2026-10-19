# Running this fork

This fork (`kalda-boss/open-nvr`) adds its own features on top of upstream
OpenNVR (`open-nvr/open-nvr`), so it builds its own core image instead of
running upstream's `ghcr.io/open-nvr/core`.

```
feature branch ──PR──▶ kalda-boss/open-nvr main ──scripts/deploy.sh──▶ live stack
                                  ▲
           open-nvr/open-nvr main ┘ (merged in when you want upstream changes)
```

## Images and tags

| Variable        | Selects                                             | Set by                |
|-----------------|-----------------------------------------------------|-----------------------|
| `FORK_CORE_TAG` | `ghcr.io/kalda-boss/open-nvr-core` (this fork's core) | `scripts/deploy.sh`   |
| `CORE_TAG`      | upstream images on core's cadence (`detect-pipeline`) | you; keep it `main`   |

`CORE_TAG` must keep naming a tag upstream publishes: a fork-only value
would send `detect-pipeline` looking for an image that doesn't exist.

Core is `pull_policy: missing` with a `build:` block, so Compose uses the
local image when present and otherwise builds from the checkout. The
installer's `docker compose pull --ignore-buildable` skips it.

## One-time setup of the live checkout

In the checkout the stack runs from (the one with `.env`):

```sh
git remote rename origin upstream          # if origin is open-nvr/open-nvr
git remote add origin https://github.com/kalda-boss/open-nvr.git
git fetch origin
git checkout -B main --track origin/main   # must fast-forward from what's checked out
```

Then set `CORE_TAG=main` in `.env` and run `scripts/deploy.sh`.

## Deploying

```sh
scripts/deploy.sh --check    # what a deploy of origin/main would do; changes nothing
scripts/deploy.sh            # deploy origin/main (asks to confirm)
scripts/deploy.sh --ref <sha> --yes
```

It builds the image from the committed tree, backs up the database to
`~/opennvr-backups/` (newest 10 kept; override with `OPENNVR_BACKUP_DIR`),
fast-forwards the checkout, sets `FORK_CORE_TAG`, runs `./start.sh up`, and
waits for core to report healthy. If any of that fails, it rolls back:
previous commit and tag, the database restored from the backup if a
migration ran, and `./start.sh up` again. See the header of
`scripts/deploy.sh` for details.

## Footage is never the price of a deploy

MediaMTX writes every camera's footage, so anything that restarts or
reconfigures it leaves a hole in all of them: 17 s per camera when the RTCP
fix (PR #6) was deployed. Restarting core does not stop recording, and the
segments written while it is down are indexed by its reconciler when it
returns. `scripts/deploy.sh` therefore:

1. **Refuses an update that would touch the recorder** unless it is run with
   `--allow-recorder-restart`:
   - its Compose definition: Compose's own config hash, rendered from the
     target tree with the arguments `./start.sh up` uses, against the
     running container's label;
   - `mediamtx.docker.yml`, which MediaMTX hot-reloads;
   - the core code that provisions its paths at startup:
     `mediamtx_startup_service.py`, `mediamtx_admin_service.py`,
     `stream_service.py`.

   Run those deploys when a short gap is acceptable. A change under
   `docker/mediamtx-build` is flagged but not deployed, because the script
   never rebuilds the recorder's image.
2. **Notes which cameras are recording** before it changes anything.
3. **Checks the footage afterwards**, after a rollback too, by reading the
   segment files on disk:
   - the recorder is the same process;
   - every camera that was recording still is;
   - there is no gap over 3 s between segments since the deploy began.

   If any of that fails it exits with status 2.

`--check` runs steps 1 and 2 and the target checks, then stops.

## Taking upstream changes

In a development clone (not the live checkout):

```sh
git fetch upstream
git checkout -b sync/upstream-YYYY-MM-DD origin/main
git merge upstream/main          # resolve conflicts, run the tests
git push -u origin HEAD          # PR into the fork's main, merge, deploy
```

Merging every few weeks keeps the conflicts small. Expect them in
`docker-compose.yml` around `opennvr-core` and anywhere a fork feature
touched the same code as upstream.

## Rolling back by hand

`scripts/deploy.sh --ref <older sha>` won't do it: it only moves forward.
To go back to the previous core image when the new one runs but misbehaves:

1. If the newer image added a migration, downgrade first, from the newer
   image: `docker exec opennvr_core sh -c 'cd /app/server && alembic downgrade <revision>'`.
   Or restore the deploy's backup:
   `docker exec -i opennvr_db pg_restore -U <user> -d <db> --clean --if-exists --no-owner --single-transaction < ~/opennvr-backups/<file>.dump`
2. Set `FORK_CORE_TAG` in `.env` to the previous tag (`docker images ghcr.io/kalda-boss/open-nvr-core` lists them).
3. `./start.sh up`.
