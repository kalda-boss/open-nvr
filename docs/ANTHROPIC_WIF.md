# Claude without an API key: Workload Identity Federation

With `LLM_PROVIDER=anthropic` (see `docker-compose.anthropic.yml`), every
Claude call (the camera agent, the `claudevlm` caption adapter, Footage
Search's query parser) authenticates with `ANTHROPIC_API_KEY` by default.
Workload Identity Federation (WIF) replaces that long-lived key with
short-lived credentials:

1. The `anthropic-issuer` container signs a JWT for each workload every
   2 minutes (ES256, valid 10 minutes, `sub` = `opennvr:<workload>`) and
   writes it to the `opennvr_anthropic_identity` volume.
2. Each workload mounts that volume read-only. The Anthropic SDK reads its
   token file, exchanges it at `api.anthropic.com/v1/oauth/token` for an
   access token (1 hour by default), and repeats before that expires.
3. Anthropic checks the signature against the issuer's public key, which
   you register **inline** in the Claude Console. Anthropic never fetches
   anything from this machine, and the issuer container has no network.

The signing key never leaves the `opennvr_anthropic_issuer_key` volume.
Anyone who could read that volume could mint tokens, as anyone holding an
API key could call the API. The difference is that nothing in `.env` or
in the workloads' environment is worth stealing, and a leaked token dies
in minutes.

## One-time setup

You need an Anthropic organization admin for the Console steps.

1. **Start the issuer once to create its key and print the public key:**

   ```bash
   docker compose -f docker-compose.yml --profile anthropic-wif up -d anthropic-issuer
   docker exec opennvr_anthropic_issuer python issuer.py jwks
   ```

   Copy the `keys` array from the output.

2. **In the Claude Console, open Settings → Workload identity**
   (`platform.claude.com/settings/workload-identity-federation`):

   - **Service account:** create one named for example `opennvr`, with
     organization role `developer`.
   - **Issuer:** issuer URL `https://opennvr.local/anthropic-wif` (or the
     value of `ANTHROPIC_WIF_ISSUER` if you set one; it is compared with
     the token's `iss` as a string and never fetched). For JWKS choose
     **inline**, then paste the `keys` array from step 1.
   - **Rule:** issuer from above, subject `opennvr:*`, audience
     `https://api.anthropic.com`, target the service account, one
     workspace, scope `workspace:inference`.

3. **In `.env`:** remove the `ANTHROPIC_API_KEY` value (a set key wins
   over federation) and fill in:

   ```bash
   ANTHROPIC_FEDERATION_RULE_ID=fdrl_...
   ANTHROPIC_ORGANIZATION_ID=<organization UUID, Settings → Organization>
   ANTHROPIC_SERVICE_ACCOUNT_ID=svac_...
   ANTHROPIC_WORKSPACE_ID=        # only if the rule spans several workspaces
   ```

4. **Restart:** `./start.sh up` (or `scripts/deploy.sh` on the fork). Then
   delete or deactivate the old API key in the Console.

## Checking it works

- `docker logs opennvr_anthropic_issuer` shows the issuer URL, key ID and
  workloads.
- The caption adapter's hardware evaluation (AI Models page) reports
  `credential: federation`.
- Every exchange, accepted or refused, appears under **Authentication
  history** on the Console's Workload identity page, with the reason for
  any refusal (a `401 Authentication failed` from the API is deliberately
  opaque).

## Rotating the signing key

Inline keys are not refreshed automatically. To rotate:

```bash
docker compose -f docker-compose.yml --profile anthropic-wif stop anthropic-issuer
docker volume rm <project>_opennvr_anthropic_issuer_key
docker compose -f docker-compose.yml --profile anthropic-wif up -d anthropic-issuer
docker exec opennvr_anthropic_issuer python issuer.py jwks
```

Paste the new key into the issuer in the Console. Workloads keep their
current access token until it expires (at most an hour), then use the new
key.
