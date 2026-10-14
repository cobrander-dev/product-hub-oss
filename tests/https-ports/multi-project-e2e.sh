#!/usr/bin/env bash
# Two self-hosted projects on one server: Product Hub (this checkout) and Invoice
# Generator (INVOICE_DIR checkout), each installed by its real installer with its
# own HTTPS port. Runs ONLY as root on a disposable GitHub Actions runner.
#
#   usage: sudo -E INVOICE_DIR=... tests/https-ports/multi-project-e2e.sh invoice-first|hub-first
#
#   invoice-first  Invoice on 8443 owns port 80 (relay holder); Product Hub on 9443
#                  gets its certificate through the relay (member).
#   hub-first      Product Hub on the default 443 owns port 80; Invoice on 8443 is
#                  the member.
#
# Certificates come from Pebble (Let's Encrypt's ACME test server) on the shared
# relay network; its mock DNS points every name at this host, so validation reaches
# the real published ports 80/443 exactly like a public CA would. Product Hub images
# are built from this checkout and served by a local registry answering as ghcr.io.
set -Eeuo pipefail

scenario="${1:?usage: multi-project-e2e.sh invoice-first|hub-first}"
hub="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
invoice="${INVOICE_DIR:?INVOICE_DIR must point at an invoice-generator-oss checkout}"
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "$(id -u)" -eq 0 ]] || {
  echo 'refusing to run outside a disposable GitHub Actions runner as root' >&2
  exit 1
}
case "$scenario" in invoice-first | hub-first) ;; *) echo "unknown scenario $scenario" >&2 && exit 2 ;; esac

work="$(mktemp -d)"
chmod 755 "$work"
step() { printf '\n==> %s\n' "$*"; }
fail() {
  echo "MULTI-PROJECT FAIL: $*" >&2
  exit 1
}
expect_failure() {
  local code="$1" output
  shift
  if output="$("$@" 2>&1)"; then
    printf '%s\n' "$output"
    fail "expected failure $code"
  fi
  printf '%s\n' "$output" | tail -n 5
  [[ "$output" == *"$code"* ]] || fail "expected error code $code"
}
fetch() { # URL SHA256 DEST
  curl -fsSL --proto '=https' "$1" -o "$3"
  [[ "$(sha256sum "$3" | awk '{print $1}')" == "$2" ]] || fail "checksum mismatch: $1"
}

invoice_host=invoice.ci.test
hub_host=hub.ci.test
if [[ "$scenario" == invoice-first ]]; then
  invoice_port=8443 hub_port=9443
else
  invoice_port=8443 hub_port=443
fi
origin() { if [[ "$2" == 443 ]]; then printf 'https://%s' "$1"; else printf 'https://%s:%s' "$1" "$2"; fi; }
invoice_origin="$(origin "$invoice_host" "$invoice_port")"
hub_origin="$(origin "$hub_host" "$hub_port")"

step 'Pebble ACME test server on the shared relay network'
mkdir -p "$work/pebble"
pebble_base=https://github.com/letsencrypt/pebble
fetch "$pebble_base/releases/download/v2.10.1/pebble-linux-amd64.tar.gz" \
  4f2fcb5bca8c85c9cf73ad140fccfc0d2be40bd81ab99879c79b7b8a0b4f70ed "$work/pebble.tar.gz"
fetch "$pebble_base/releases/download/v2.10.1/pebble-challtestsrv-linux-amd64.tar.gz" \
  e93a5aa25ecdf3af2f9fbb2de32b0173e64a2eae81002a4ccfe35fa6f4f60b92 "$work/challtestsrv.tar.gz"
raw=https://raw.githubusercontent.com/letsencrypt/pebble/v2.10.1/test/certs
fetch "$raw/pebble.minica.pem" 0c502e52627ff7de972c7e9e065640103b4589b4e2d23d3fcf21bef1e3c8c67c "$work/pebble/minica.pem"
fetch "$raw/localhost/cert.pem" c87fb918d9bac8db11aa54493b5f0cf6e0725a3fe73f617d1c64737e1ab4caf9 "$work/pebble/cert.pem"
fetch "$raw/localhost/key.pem" 0977979255b0e0721c17335c056b627f66a43cf56e5a52f3cda81fb111ecf00e "$work/pebble/key.pem"
tar -xzf "$work/pebble.tar.gz" -C "$work"
tar -xzf "$work/challtestsrv.tar.gz" -C "$work"
install -m 0755 "$(find "$work" -type f -name pebble -path '*linux/amd64*' | head -n 1)" "$work/pebble/pebble"
install -m 0755 "$(find "$work" -type f -name pebble-challtestsrv -path '*linux/amd64*' | head -n 1)" "$work/pebble/challtestsrv"
chmod 644 "$work/pebble/"*.pem
# Short certificate lifetime so renewal through the relay can be exercised.
cat >"$work/pebble/pebble.json" <<'EOF'
{"pebble":{"listenAddress":"0.0.0.0:14000","managementListenAddress":"0.0.0.0:15000","certificate":"/p/cert.pem","privateKey":"/p/key.pem","httpPort":80,"tlsPort":443,"ocspResponderURL":"","externalAccountBindingRequired":false,"certificateValidityPeriod":300}}
EOF
docker pull -q busybox:1.37 >/dev/null
docker network create --label oss.https-relay=1 oss-https-relay >/dev/null
gateway="$(docker network inspect oss-https-relay --format '{{(index .IPAM.Config 0).Gateway}}')"
docker run -d --name ci-challtestsrv --network oss-https-relay -v "$work/pebble:/p:ro" busybox:1.37 \
  /p/challtestsrv -defaultIPv4 "$gateway" -defaultIPv6 '' -dnsserver :8053 -http01 '' -https01 '' \
  -tlsalpn01 '' -doh '' -management :8055 >/dev/null
dns="$(docker inspect --format '{{(index .NetworkSettings.Networks "oss-https-relay").IPAddress}}' ci-challtestsrv)"
docker run -d --name ci-pebble --network oss-https-relay --network-alias pebble -p 127.0.0.1:15000:15000 \
  -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 -v "$work/pebble:/p:ro" busybox:1.37 \
  /p/pebble -config /p/pebble.json -dnsserver "$dns:8053" >/dev/null
for _ in $(seq 1 30); do curl -fsk https://127.0.0.1:15000/roots/0 -o "$work/pebble-root.pem" && break; sleep 1; done
[[ -s "$work/pebble-root.pem" ]] || fail 'Pebble did not start'
acme_ca=https://pebble:14000/dir

step 'release artifacts: Invoice bundles and Product Hub images'
docker build -q -t invoice-generator:ci-a "$invoice" >/dev/null
printf 'FROM invoice-generator:ci-a\nLABEL ci.release=b\n' | docker build -q -t invoice-generator:ci-b - >/dev/null
docker pull -q caddy:2.11.4-alpine >/dev/null
for spec in a:v0.0.1-ci.1 b:v0.0.1-ci.2; do
  IG_ALLOW_LOCAL_IMAGES=1 "$invoice/scripts/build-installer-bundle.sh" "${spec#*:}" "invoice-generator:ci-${spec%%:*}" \
    caddy:2.11.4-alpine "$work/invoice-${spec%%:*}" >/dev/null
done
# PostgreSQL is pinned by the published release; resolve it before ghcr.io is redirected.
curl -fsSL https://github.com/cobrander-dev/product-hub-oss/releases/download/v0.9.0-rc.2/product-hub-release.manifest \
  -o "$work/rc2.manifest"
postgres="$(awk -F= '$1 == "postgres" {print $2}' "$work/rc2.manifest")"
[[ "$postgres" =~ ^postgres@sha256:[0-9a-f]{64}$ ]] || fail 'postgres digest'
docker pull -q "$postgres" >/dev/null
docker pull -q registry:2.8.3 >/dev/null

step 'local registry answering as ghcr.io'
mkdir -p "$work/registry"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=CI fake registry CA' \
  -keyout "$work/registry/ca.key" -out "$work/registry/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=ghcr.io' -keyout "$work/registry/ghcr.key" -out "$work/registry/ghcr.csr" 2>/dev/null
printf 'subjectAltName=DNS:ghcr.io\n' >"$work/registry/ext"
openssl x509 -req -in "$work/registry/ghcr.csr" -CA "$work/registry/ca.crt" -CAkey "$work/registry/ca.key" \
  -CAcreateserial -days 2 -extfile "$work/registry/ext" -out "$work/registry/ghcr.crt" 2>/dev/null
chmod 644 "$work/registry/"*
# Own bridge network: the registry listens on 443 of its container address only, so the host's
# port 443 stays free for the projects under test.
docker network create --subnet 172.30.99.0/24 ci-fake-ghcr >/dev/null
docker run -d --name ci-fake-ghcr --network ci-fake-ghcr --ip 172.30.99.10 -v "$work/registry:/certs:ro" \
  -e REGISTRY_HTTP_ADDR=0.0.0.0:443 -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/ghcr.crt \
  -e REGISTRY_HTTP_TLS_KEY=/certs/ghcr.key registry:2.8.3 >/dev/null
printf '172.30.99.10 ghcr.io\n' >>/etc/hosts
install -d /etc/docker/certs.d/ghcr.io
install -m 0644 "$work/registry/ca.crt" /etc/docker/certs.d/ghcr.io/ca.crt

hub_release() { # VERSION -> manifest at $work/hub-VERSION.manifest
  local version="$1" commit name local_image digest line
  (cd "$hub" && scripts/build-production-artifacts.sh "$version" >/dev/null)
  commit="$(git -C "$hub" rev-parse HEAD)"
  printf 'schema=product-hub-release/v1\nversion=%s\nsource_commit=%s\ndistribution_commit=%s\nplatform=linux/amd64\n' \
    "$version" "$commit" "$commit" >"$work/hub-$version.manifest"
  for line in runner:product-hub:product-hub-oss-app migrator:product-hub-migrator:product-hub-oss-migrator \
    worker:product-hub-hard-delete-worker:product-hub-oss-hard-delete-worker; do
    IFS=: read -r key local_image name <<<"$line"
    docker tag "$local_image:$version" "ghcr.io/cobrander-dev/$name:$version"
    digest="$(docker push "ghcr.io/cobrander-dev/$name:$version" | awk '/digest: sha256:/ {print $3}' | tail -n 1)"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "push $name"
    printf '%s=ghcr.io/cobrander-dev/%s@%s\n' "$key" "$name" "$digest" >>"$work/hub-$version.manifest"
  done
  printf 'postgres=%s\nworkflow_run=1\npublished_at=2026-10-14T00:00:00.000Z\n' "$postgres" >>"$work/hub-$version.manifest"
}
hub_release v0.9.1-ci.1
# A second release (new commit, same code) for the upgrade check. Local commit only.
git -C "$hub" -c user.name=ci -c user.email=ci@example.invalid commit -q --allow-empty -m 'CI upgrade target'
hub_release v0.9.1-ci.2

invoice_password="TEST-invoice-$(openssl rand -hex 12)"
hub_password="TEST-hub-$(openssl rand -hex 12)"
printf '%s' "$invoice_password" >"$work/invoice-password"
chmod 600 "$work/invoice-password"

install_invoice() { # PORT
  IG_NONINTERACTIVE=1 IG_BUNDLE_FILE="$work/invoice-a/invoice-generator-installer.tar.gz" IG_ACCESS_HOST="$invoice_host" \
    IG_HTTPS_PORT="$1" IG_ACME_CA="$acme_ca" IG_ACME_CA_ROOT="$work/pebble/minica.pem" IG_ADMIN_USERNAME=ci-admin \
    IG_ADMIN_PASSWORD_FILE="$work/invoice-password" bash "$work/invoice-a/install.sh"
}
install_hub() { # PORT (interactive wizard driven through a PTY)
  printf '%s' '[["域名或", "hub.ci.test"], ["管理员用户名", "ci_admin"], ["管理员显示名称", "CI Admin"], ["管理员密码", "env:HUB_PASSWORD"], ["再次输入管理员密码", "env:HUB_PASSWORD"]]' \
    >"$work/hub-answers.json"
  HUB_PASSWORD="$hub_password" PRODUCT_HUB_RELEASE_MANIFEST="$work/hub-v0.9.1-ci.1.manifest" PRODUCT_HUB_HTTPS_PORT="$1" \
    PRODUCT_HUB_ACME_CA="$acme_ca" PRODUCT_HUB_ACME_CA_ROOT="$work/pebble/minica.pem" \
    python3 "$invoice/tests/installer/drive-tty.py" "$work/hub-answers.json" -- sh "$hub/setup.sh" | tee "$work/hub-setup.log"
}

# Certificate served on 127.0.0.1:PORT for HOST, verified against Pebble's root like a browser would.
certificate() { openssl s_client -connect "127.0.0.1:$2" -servername "$1" </dev/null 2>/dev/null | openssl x509 -noout "${@:3}"; }
expect_trusted() { # HOST PORT
  local issuer=''
  for _ in $(seq 1 60); do
    issuer="$(certificate "$1" "$2" -issuer 2>/dev/null || true)"
    [[ "$issuer" == *Pebble* ]] && break
    sleep 3
  done
  [[ "$issuer" == *Pebble* ]] || fail "$1:$2 serves no ACME certificate ($issuer)"
  curl -fsS --cacert "$work/pebble-root.pem" --resolve "$1:$2:127.0.0.1" -o /dev/null "$(origin "$1" "$2")/" ||
    fail "$1:$2 is not trusted through the ACME chain"
}
expect_redirect() { # HOST PORT: plain HTTP on port 80 (possibly relayed) redirects to the HTTPS origin
  local got
  got="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "Host: $1" http://127.0.0.1/check)"
  [[ "$got" == "308 $(origin "$1" "$2")/check" ]] || fail "HTTP redirect for $1: $got"
}

invoice_login() {
  local jar="$work/invoice.jar" token status
  local curl_=(curl -fsS --cacert "$work/pebble-root.pem" --resolve "$invoice_host:$invoice_port:127.0.0.1" -b "$jar" -c "$jar")
  rm -f "$jar"
  token="$("${curl_[@]}" "$invoice_origin/login" | grep -oE '[a-f0-9]{112}' | head -n 1)"
  jq -n --arg u ci-admin --arg p "$invoice_password" '{username: $u, password: $p}' >"$work/invoice-login.json"
  "${curl_[@]}" -X POST "$invoice_origin/api/auth/login" -H "Origin: $invoice_origin" -H "X-CSRF-Token: $token" \
    -H 'Content-Type: application/json' --data @"$work/invoice-login.json" >/dev/null
  grep -q '#HttpOnly_'"$invoice_host"'.*TRUE.*__Host-ft.sid' "$jar" || fail 'Invoice session cookie must be Secure and HttpOnly'
  "${curl_[@]}" "$invoice_origin/api/customers" | jq -e '.data' >/dev/null || fail 'Invoice API after login'
  token="$("${curl_[@]}" "$invoice_origin/api/auth/csrf" | jq -r .csrfToken)"
  status="$(curl -s --cacert "$work/pebble-root.pem" --resolve "$invoice_host:$invoice_port:127.0.0.1" -b "$jar" -o /dev/null \
    -w '%{http_code}' -X POST "$invoice_origin/api/customers" -H "Origin: $hub_origin" -H "X-CSRF-Token: $token" \
    -H 'Content-Type: application/json' --data '{"id":"x"}')"
  [[ "$status" == 403 ]] || fail "Invoice accepted a write from another origin ($status)"
}
hub_login() {
  local jar="$work/hub.jar" status
  local curl_=(curl -sS --cacert "$work/pebble-root.pem" --resolve "$hub_host:$hub_port:127.0.0.1" -b "$jar" -c "$jar")
  rm -f "$jar"
  jq -n --arg u ci_admin --arg p "$hub_password" '{username: $u, password: $p}' >"$work/hub-login.json"
  status="$("${curl_[@]}" -o /dev/null -w '%{http_code}' -X POST "$hub_origin/api/auth/sign-in/username" \
    -H "Origin: $invoice_origin" -H 'Content-Type: application/json' --data @"$work/hub-login.json")"
  [[ "$status" == 403 ]] || fail "Product Hub accepted a sign-in from another origin ($status)"
  status="$("${curl_[@]}" -o /dev/null -w '%{http_code}' -X POST "$hub_origin/api/auth/sign-in/username" \
    -H "Origin: $hub_origin" -H 'Content-Type: application/json' --data @"$work/hub-login.json")"
  [[ "$status" == 200 ]] || fail "Product Hub sign-in ($status)"
  grep -q '#HttpOnly_'"$hub_host"'.*TRUE.*session_token' "$jar" || fail 'Product Hub session cookie must be Secure and HttpOnly'
  status="$("${curl_[@]}" -o /dev/null -w '%{http_code}' "$hub_origin/admin")"
  [[ "$status" == 200 ]] || fail "Product Hub admin page after login ($status)"
  status="$(curl -sS --cacert "$work/pebble-root.pem" --resolve "$hub_host:$hub_port:127.0.0.1" -o /dev/null \
    -w '%{http_code}' "$hub_origin/admin")"
  [[ "$status" != 200 ]] || fail 'Product Hub admin page without a session'
}
https_container() { # PROJECT SERVICE
  docker ps -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=$2"
}
started() { docker inspect --format '{{.State.StartedAt}}' $(docker ps -q --filter "label=com.docker.compose.project=$1") | sort | tr '\n' ' '; }
role_of() { docker inspect --format '{{index .Config.Labels "oss.https-relay"}}' "$(https_container "$1" "$2")"; }

if [[ "$scenario" == invoice-first ]]; then
  step "Invoice Generator on $invoice_port while port 80 is free -> relay holder"
  install_invoice "$invoice_port"
  grep -q '^RELAY_ROLE=holder$' /opt/invoice-generator/config/installer.env || fail 'Invoice must be the holder'
  expect_trusted "$invoice_host" "$invoice_port"
  expect_redirect "$invoice_host" "$invoice_port"

  step 'Product Hub refuses the port Invoice already uses'
  expect_failure HTTPS_PORT_IN_USE env PRODUCT_HUB_RELEASE_MANIFEST="$work/hub-v0.9.1-ci.1.manifest" \
    PRODUCT_HUB_HTTPS_PORT="$invoice_port" sh "$hub/setup.sh"
  [[ ! -e /opt/product-hub ]] || fail 'refused install left files behind'

  step "Product Hub on $hub_port gets its certificate through Invoice's port-80 relay"
  install_hub "$hub_port"
  grep -qx 'role=member' /opt/product-hub/config/access || fail 'Product Hub must be a member'
else
  step "Product Hub on the default port $hub_port while port 80 is free -> relay holder"
  install_hub "$hub_port"
  grep -qx 'role=holder' /opt/product-hub/config/access || fail 'Product Hub must be the holder'
  expect_trusted "$hub_host" "$hub_port"
  expect_redirect "$hub_host" "$hub_port"

  step 'Invoice Generator refuses port 443 owned by Product Hub'
  expect_failure HTTPS_PORT_IN_USE install_invoice 443
  [[ ! -e /opt/invoice-generator/config/installer.env ]] || fail 'refused install left an installation marker'
  rm -rf /opt/invoice-generator

  step "Invoice Generator on $invoice_port gets its certificate through Product Hub's relay"
  install_invoice "$invoice_port"
  grep -q '^RELAY_ROLE=member$' /opt/invoice-generator/config/installer.env || fail 'Invoice must be a member'
fi
grep -q 'Pebble' "$work/hub-setup.log" || fail 'Product Hub setup did not report the ACME certificate'

step 'both projects: trusted HTTPS, redirects, login, cookies and CSRF'
expect_trusted "$invoice_host" "$invoice_port"
expect_trusted "$hub_host" "$hub_port"
expect_redirect "$invoice_host" "$invoice_port"
expect_redirect "$hub_host" "$hub_port"
invoice_login
hub_login
grep -q "^APP_ORIGIN=$invoice_origin$" /opt/invoice-generator/config/app.env || fail 'Invoice APP_ORIGIN'
grep -q "^BETTER_AUTH_URL=$hub_origin$" /opt/product-hub/config/product-hub.env || fail 'Product Hub BETTER_AUTH_URL'
[[ "$(role_of invoice-generator caddy)" =~ ^(holder|member)$ && "$(role_of product-hub-https https)" =~ ^(holder|member)$ ]] ||
  fail 'relay labels'
invoice-generator doctor
product-hub doctor

step 'separate data, configuration and networks; only the proxies share the relay network'
docker volume inspect invoice-generator_data >/dev/null || fail 'Invoice data volume'
[[ -n "$(docker volume ls -q --filter label=com.docker.compose.project=product-hub)" ]] || fail 'Product Hub volumes'
attached="$(docker network inspect oss-https-relay --format '{{range .Containers}}{{.Name}} {{end}}')"
for name in $attached; do
  case "$name" in ci-pebble | ci-challtestsrv | invoice-generator-caddy-* | product-hub-https-https-*) ;;
    *) fail "unexpected container on the relay network: $name" ;;
  esac
done

step 'upgrading Product Hub leaves Invoice running'
before="$(started invoice-generator)"
install -m 0644 "$work/hub-v0.9.1-ci.2.manifest" /opt/product-hub/releases/target.manifest
product-hub update --manifest /opt/product-hub/releases/target.manifest </dev/null
grep -q '^version=v0.9.1-ci.2$' /opt/product-hub/releases/current.manifest || fail 'Product Hub version after upgrade'
grep -qx "port=$hub_port" /opt/product-hub/config/access || fail 'upgrade changed the Product Hub port'
[[ "$(started invoice-generator)" == "$before" ]] || fail 'Product Hub upgrade restarted Invoice'
expect_trusted "$hub_host" "$hub_port"
expect_redirect "$invoice_host" "$invoice_port"
hub_login
invoice_login

step 'upgrading Invoice leaves Product Hub running'
before="$(started product-hub) $(started product-hub-https)"
sha="$(awk '$2 == "invoice-generator-installer.tar.gz" {print $1}' "$work/invoice-b/SHA256SUMS")"
invoice-generator upgrade --bundle "$work/invoice-b/invoice-generator-installer.tar.gz" --sha256 "$sha" --yes
[[ "$(invoice-generator version)" == 'Invoice Generator v0.0.1-ci.2' ]] || fail 'Invoice version after upgrade'
grep -q "^HTTPS_PORT=$invoice_port$" /opt/invoice-generator/config/installer.env || fail 'upgrade changed the Invoice port'
[[ "$(started product-hub) $(started product-hub-https)" == "$before" ]] || fail 'Invoice upgrade restarted Product Hub'
expect_trusted "$invoice_host" "$invoice_port"
expect_redirect "$hub_host" "$hub_port"
invoice_login
hub_login

step 'renewal: both certificates are renewed through the same validation paths'
# Pebble issues 300-second certificates; Caddy renews in the last third of the lifetime.
invoice_serial="$(certificate "$invoice_host" "$invoice_port" -serial)"
hub_serial="$(certificate "$hub_host" "$hub_port" -serial)"
renewed=0
for _ in $(seq 1 60); do
  sleep 10
  # A restart makes Caddy check its certificates at once instead of on its maintenance timer.
  [[ "$(certificate "$invoice_host" "$invoice_port" -serial)" != "$invoice_serial" ]] ||
    docker restart "$(https_container invoice-generator caddy)" >/dev/null
  [[ "$(certificate "$hub_host" "$hub_port" -serial)" != "$hub_serial" ]] ||
    docker restart "$(https_container product-hub-https https)" >/dev/null
  if [[ "$(certificate "$invoice_host" "$invoice_port" -serial 2>/dev/null)" != "$invoice_serial" &&
    "$(certificate "$hub_host" "$hub_port" -serial 2>/dev/null)" != "$hub_serial" ]]; then
    renewed=1
    break
  fi
done
[[ "$renewed" == 1 ]] || fail 'certificates were not renewed'
expect_trusted "$invoice_host" "$invoice_port"
expect_trusted "$hub_host" "$hub_port"
invoice_login
hub_login

printf '\nMULTI-PROJECT PASS (%s)\n' "$scenario"
