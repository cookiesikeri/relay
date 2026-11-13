SHIP WITH CONDITIONS

# Relay notes

## Results

The README says 400 req/s and the handoff says 150, so I tested at 400.

400 req/s for 5 minutes on kind:

```
total: sent=119993 status[201:113884 409:6109] errors[-] p50=6ms p95=10ms p99=24ms
```

Rolling restart during a 400 req/s test: 0 errors.

## 1. What I changed (most important first)

1. **Removed leaked passwords.** The staging DB password was in `app/.env` and the prod DB password in `terraform/variables.tf`. They are still in git history, so they must be rotated.
2. **Made it start.**
   - The image build failed: `npm ci` had no lockfile.
   - The app listened on 8080, but the probe and Service used 3000.
   - The Deployment read secret key `database-url`, but the Secret had `DATABASE_URL`.
   - Logs went to a file instead of stdout.
3. **Fixed duplicate detection.** It was kept in each pod's memory, so with more than one pod a retry could reach a different pod and get a 500 instead of a 409. With the original code at 3 pods I saw `500:273` in 60 seconds. The map also had no size limit, which explains the OOM restarts. Postgres now handles it with `ON CONFLICT`.
4. **DB connections.** 25 per pod × 10 pods = 250, but the DB allows 100. It's now 8 per pod: 88 at most, counting the extra pod during a rollout.
5. **Memory.** The heap was 512 MB inside a 256 Mi limit. It's now a 320 MB heap inside a 448 Mi limit.
6. **Health checks and deploys.**
   - Liveness no longer checks the DB, so a DB blip doesn't restart every pod. Readiness checks the DB.
   - The app now shuts down gracefully.
   - Rollouts never take a pod away before the new one is ready.
7. **Migrations.** They now run once, safely: in an init container, inside a transaction, with a lock so pods don't run them at the same time.
8. **Scaling.**
   - Added CPU requests, without which the HPA can't work.
   - Minimum 3 pods across zones, a PDB, and the pod runs as non-root.
9. **S3 archive.** A failed upload no longer returns 500 after the row is already saved.
10. **CI.**
    - Checks run on every PR.
    - It uses OIDC instead of AWS keys, and images are tagged with the commit SHA.
    - It no longer deploys the local Postgres and test Secret to prod, and it rolls back if a deploy fails.
11. **Terraform** (validated only, not applied).
    - The node firewall allowed 8080, but the ALB sends to 30080, so prod would get no traffic. Fixed.
    - Nodes are now in private subnets across 2 zones.
    - Removed open SSH and the bastion.
    - The node role had `s3:*` and `secretsmanager:*`; now only the relay pod can write to the archive bucket.
    - Added HTTPS, encrypted disks and IMDSv2.
    - The DB password is no longer in code.

## 2. What I found and left

- **No metrics or alerts yet.** First thing I would add next.
- **S3 archive can still miss an event** if a pod crashes right after saving. The fix is an outbox table and a worker.
- **Migration 3 locks the table** on large data. It should use `CREATE INDEX CONCURRENTLY` in a pre-deploy Job.
- **No authentication or rate limiting** on a public endpoint.
- **No TLS to the database.**
- **No image scanning**, and actions are pinned to tags, not SHAs.
- **Secrets remain in git history.** Rotating them is enough.

## 3. Friday

Ship with conditions. Before Friday:

1. Rotate the leaked passwords.
2. The data team confirms 88 connections is fine and tells us whether migrations already ran.
3. The platform team provides the TLS certificate, secret delivery to the cluster, ECR and CI access, and a network policy for port 8080.
4. Apply in staging and repeat the 400 req/s test against the real DB.
5. Add basic alerts for errors and restarts.

If items 1 to 3 are not done, do not ship.

## 4. Questions

1. Is peak traffic 150 or 400 req/s?
2. Must every event be archived to S3, or is it best effort?
3. Who calls `/events`, and what authentication is expected?
4. Have staging or prod already run these migrations? How big is the table?
5. Should a retry return the original signature, or just the id?
