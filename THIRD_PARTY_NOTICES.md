# Third-party notices

Product Hub is released under the MIT License (see `LICENSE`). It depends on and
redistributes third-party software under their own licenses. Exact versions are
pinned in `pnpm-lock.yaml`, `Dockerfile` and each release manifest.

## npm production dependencies

As of v1.0.0 the 221 production packages use only permissive licenses compatible
with MIT distribution: MIT (incl. MIT/X11), Apache-2.0, ISC, BSD-3-Clause, 0BSD,
Unlicense and Zlib. Notable packages include Next.js and React (MIT), Prisma
(Apache-2.0), Better Auth (MIT), sharp (Apache-2.0), lucide-react (ISC), ExcelJS
(MIT) and csv-parse (MIT). `jszip` is dual-licensed (MIT OR GPL-3.0-or-later)
and is used under MIT. Regenerate the list with
`pnpm licenses list --prod` before each release.

## Software inside the published container images

| Component                                          | License                          | Notes                                                                       |
| -------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Node.js runtime (`node:24-bookworm-slim`)          | MIT and bundled licenses         | Upstream base image                                                         |
| Debian 12 base packages                            | Various (GPL, LGPL, BSD, MIT, …) | Unmodified Debian packages; sources at <https://sources.debian.org>         |
| libvips (via `@img/sharp-libvips-linux-x64`)       | LGPL-3.0-or-later                | Dynamically linked by sharp; source at <https://github.com/libvips/libvips> |
| Caddy v2.11.7 (Runner image, optional HTTPS proxy) | Apache-2.0                       | Built unmodified from the official tag with Go 1.26.9                       |
| Docker CLI 29.9.0 (Migrator/installer image)       | Apache-2.0                       | Official `docker:29.9.0-cli` binary                                         |
| Docker Compose v5.6.0 (Migrator/installer image)   | Apache-2.0                       | Built unmodified from the official tag with Go 1.26.9                       |
| PostgreSQL 18 (pinned digest, not rebuilt)         | PostgreSQL License               | Official image                                                              |

Each image also carries a BuildKit SPDX SBOM and SLSA provenance attestation
listing every package it contains.
