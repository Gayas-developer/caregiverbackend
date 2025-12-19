# Caregiver Platform — API Skeleton (TypeScript, Express, Prisma)

This is a **working monorepo skeleton** for your APIs:
- Node.js + Express + TypeScript
- Prisma (PostgreSQL)
- Zod validation
- JWT auth (access + refresh)
- Multi-tenancy scaffolding (org/branch in JWT)
- Swagger docs (`/docs`)
- Sample resources: Auth, Organisations/Branches, Patients, Vitals

## Quick Start

1) **Install dependencies**
```bash
npm install
```

2) **Set environment variables**
Copy and edit:
```bash
cp apps/api/.env.example apps/api/.env
```

3) **Start Postgres** (local or Docker). Example docker:
```bash
docker run --name care-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=care_app -p 5432:5432 -d postgres:16
```

4) **Prisma setup**
```bash
npm -w apps/api run prisma:generate
npm -w apps/api run prisma:migrate
```

5) **Run the API**
```bash
npm run dev
```
Visit:
- Health: http://localhost:4000/health
- Swagger: http://localhost:4000/docs

## Default roles
- `ORG_ADMIN`, `BRANCH_MANAGER`, `CLINICAL_REVIEWER`, `CAREGIVER`

## Notes
- Minimal happy-path validation is included; expand as you go.
- JWT carries `orgId`, optional `branchId`, and `role`.
- Add Azure AD SSO later by swapping the auth module.

