# Firestore Security Specification (Phase 0 TDD)

## 1. Master Source of Truth & Data Invariants
- **Master Gate**: `/users/{userId}` is owned strictly by `request.auth.uid == userId` with `request.auth.token.email_verified == true`.
- **No Raw Secrets in Firestore**: OAuth `accessToken` and `refreshToken` never leave the server encrypted vault. Firestore stores non-secret connection status, account ID/handle, job schedule state, and audit errors only.
- **No Unbounded Media**: Firestore documents store job metadata (`mediaCount`), never >1MB binary video/image blobs.
- **Immutability**: `ownerId`, `createdAt`, `uid`, `workspaceId`, and `platform` cannot be mutated after creation.
- **Terminal State Lock**: A `ScheduledJob` whose `status == 'published'` is permanently locked from further updates.
- **Append-Only Audit Log**: `PublishHistoryRecord` entries cannot be updated after creation (`allow update: if false`).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Write**: Creating `/users/u1/scheduledJobs/job_1` with `auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email**: Creating `/users/u1` when `email_verified == false` -> `PERMISSION_DENIED`.
3. **UID Ownership Spoofing**: User `u2` writing `/users/u1/scheduledJobs/job_1` with `ownerId: "u2"` or `"u1"` -> `PERMISSION_DENIED`.
4. **Ghost Field / Shadow Update**: Adding `{ isAdmin: true }` or `{ role: "admin" }` on `/users/u1` create/update -> `PERMISSION_DENIED`.
5. **Privilege Escalation on Profile**: Updating `role` from `"operator"` to `"admin"` on `/users/u1` -> `PERMISSION_DENIED`.
6. **ID Poisoning**: Document ID exceeding 128 chars or containing `$` / `.` characters (`job$poison`) -> `PERMISSION_DENIED`.
7. **Server Timestamp Forgery**: Setting `createdAt` to client `new Date()` string instead of `request.time` -> `PERMISSION_DENIED`.
8. **Immutable Field Hijack**: Updating `ownerId` or `createdAt` or `workspaceId` on an existing `ScheduledJob` -> `PERMISSION_DENIED`.
9. **Terminal State Bypass**: Modifying a `ScheduledJob` after `status` reached `"published"` -> `PERMISSION_DENIED`.
10. **Denial-of-Wallet Oversized String**: Setting `caption` > 2500 chars or `hashtags` > 30 items or non-string first hashtag `[123]` -> `PERMISSION_DENIED`.
11. **Query Trust Bypass**: Listing `/users/u1/scheduledJobs` without matching `ownerId == request.auth.uid` or as user `u2` -> `PERMISSION_DENIED`.
12. **Audit Log Tampering**: Updating an existing `/users/u1/publishHistory/hist_1` record to hide a `"failed"` status -> `PERMISSION_DENIED`.
