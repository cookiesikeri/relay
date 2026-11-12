SHIP WITH CONDITIONS

# relay: production readiness notes

## Summary

`make up` now gives a working 3-replica service. At 400 req/s for 5 minutes on kind (README says 400, handoff says 150; I tested the higher number) there were zero errors:

```
total: sent=119993 status[201:113884 409:6109] errors[-] p50=6ms p95=10ms p99=24ms
```

A rolling restart under 400 req/s also completed with zero errors:

```
total: sent=47987 status[201:45546 409:2441] errors[-] p50=6ms p95=11ms p99=19ms
```

The code is ready. Friday depends on the conditions in section 3, most of which belong to other teams.

## 1. What I changed, in priority order

1. **Removed committed credentials** (`app/.env`: staging DB password and signing secret; `terraform/variables.tf`: prod DB password as a default). Both are still in git history, so they must be rotated whatever else happens.
2. **Made the service start at all.**
   - The image build failed: `npm ci` with no lockfile in the build context (`The command '/bin/sh -c npm ci --omit=dev' returned a non-zero code: 1`).
   - The app listened on 8080, but the containerPort, probe and Service targeted 3000.
   - The Deployment read secret key `database-url`, but the Secret had `DATABASE_URL`.
   - Logs went to a file inside the container, so `make logs` showed nothing. They now go to stdout.
3. **Moved idempotency into Postgres** (`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`, then return the existing id with a 409).
   - The in-memory Map was per pod, so with more than one replica a replay landing on another pod hit the unique index and returned 500.
   - Reproduced with the original code at 3 replicas and 150 req/s: `status[201:8530 409:194 500:273]`. The logs showed `duplicate key value violates unique constraint "events_idempotency_key"`.
   - The Map was also unbounded by default, which is the likely cause of the staging OOMs.
4. **Kept within the DB connection budget.** 25 per pod × 10 pods = 250 against `max_connections` 100. The pool is now 8: 10 pods plus 1 surge × 8 = 88 at worst.
5. **Fixed memory.** The 512 MB heap sat inside a 256 Mi limit. It's now a 320 MB heap inside a 448 Mi limit, with a 256 Mi request.
6. **Fixed probes and made deploys genuinely zero-downtime.**
   - Liveness (`/livez`) no longer touches the DB, so a DB blip no longer restarts every pod.
   - Readiness (`/health`) checks the DB. A startup probe was added.
   - The app now handles SIGTERM: it fails readiness, waits 5s, sends `Connection: close` and drains. Node now runs as PID 1 instead of `sh`.
   - The rollout uses `maxUnavailable: 0`.
   - Before the keep-alive fix, a rollout under load gave `ECONNRESET:8`; after it, zero.
7. **Made migrations safe.** They no longer run on every container start. They run in an init container, each in a transaction, under a Postgres advisory lock (so concurrent pods don't race), and retry until the DB is reachable.
8. **Made scaling and availability real.**
   - Added CPU requests (the HPA couldn't compute utilisation without them).
   - Set min replicas to 3, spread across zones, and added a PDB (`maxUnavailable: 1`).
   - The pod runs non-root with a read-only root filesystem and drops all capabilities.
9. **Took S3 archiving out of the request path.** Previously a failed S3 PUT returned 500 after the row was committed, so the client's retry got a 409 and the payload was never archived. A failure is now logged instead (see the gaps in section 2).
10. **CI.**
    - Checks now run on PRs: `npm ci`, `npm audit`, `terraform validate`, kubeconform and a Docker build.
    - It uses OIDC instead of static AWS keys, and actions pinned to versions instead of `@master`.
    - Images are tagged with the git SHA instead of `:latest`.
    - The deploy uses a GitHub `production` environment, applies only the app manifests (previously it applied the local Postgres and dev Secret to prod), and runs `rollout status` with an automatic undo.
11. **Terraform** (validated, not applied).
    - The node security group allowed 8080, but the ALB forwards to NodePort 30080, so the ALB could never reach the pods. It now allows the NodePort from the ALB only.
    - Nodes were in one AZ in public subnets. They are now in private subnets across 2 AZs, each with its own NAT.
    - Removed SSH from 0.0.0.0/0 and the bastion, in favour of SSM.
    - The node role had `s3:*` and `secretsmanager:*` on `*`. It now has none. The relay pod gets `s3:PutObject` on `events/*` only, through EKS Pod Identity.
    - IMDSv2 is required with hop limit 1, so pods can't borrow the node role.
    - EBS is encrypted. The bucket now has a public access block, KMS encryption and versioning.
    - Added an HTTPS listener with TLS 1.3 and an HTTP→HTTPS redirect.
    - The EKS API is restricted to given CIDRs and the control-plane audit logs are enabled.
    - The provider is pinned, there's an S3 backend, and the DB password is a sensitive variable with no default.

## 2. Found and deliberately left

- **No metrics, dashboards or alerts.** This is the first thing I'd do after launch-blocking work: `prom-client` RED metrics plus pool usage, and alerts on 5xx rate, p99, pool saturation and archive failures. Left only for time.
- **Archive is fire-and-forget.** A pod crash between commit and PUT loses the archive copy; the DB row is safe. The proper fix is an outbox table with a worker. Whether it's needed depends on whether the archive is compliance-critical (see question 2).
- **Migration 3 on a large table.** `CREATE UNIQUE INDEX` locks writes and fails if staging/prod already hold duplicate keys. It should be `CONCURRENTLY` and run as a pre-deploy Job. Migration 2's full-table `UPDATE` has the same issue. I can't judge either without knowing the production data size.
- **No authentication or rate limiting** on a public endpoint (see question 3). Not mine to invent before launch, but it's a risk.
- **DB connection without TLS** (`sslmode`). It needs the data team's CA bundle.
- **Supply chain.** Actions are pinned to tags rather than SHAs, and there's no image scan or SBOM. ECR repo creation isn't in this Terraform.
- **Removing secrets from git history.** Rotation makes the history harmless, and rewriting it is disruptive.
- **The HPA didn't scale at 400 req/s** (29% CPU across 3 pods on kind). Headroom looks fine, but kind isn't EKS: this needs repeating in staging against the real DB.

## 3. My call: ship with conditions

Ship on Friday only if all of these are done:

1. **Credential rotation:** the staging DB password, the staging signing secret and the prod DB password are rotated.
2. **Data team:**
   - confirms the 88-connection budget for relay, and whether staging/prod already ran migrations 1–3;
   - confirms there are no duplicate idempotency keys;
   - confirms the expected table size.
3. **Platform team:**
   - an ACM certificate ARN;
   - how `relay-secrets` reaches the cluster (External Secrets from Secrets Manager);
   - the ECR repo and CI OIDC role;
   - a NetworkPolicy allowing 8080.
4. **Staging verification:** one staging run of `terraform apply` plus a 400 req/s load test against the real managed DB, with Pod Identity confirmed by an object landing in S3.
5. **Basic alerting** in place: 5xx rate and pod restarts at minimum.

If items 1–3 aren't done by Friday, my answer is DO NOT SHIP. The service code is no longer the risk.

## 4. Questions I would have asked

1. Is peak traffic 150 or 400 req/s? I sized and tested for 400.
2. Is the S3 archive required for every event (audit/compliance), or best effort? That decides whether an outbox is a launch blocker.
3. Who calls `/events`? Is it meant to be public, and with what authentication?
4. Has staging already applied these migrations, and how many rows does production start with?
5. Should replays return the original response body (the signature) rather than just the id?
6. Who owns secret delivery and the ECR/OIDC setup in production?
