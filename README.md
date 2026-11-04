# NexaCommand

> **Notice:** This is a **temporary project README** documenting the high-level system architecture, core features, current development status across branches, visual process diagrams, and execution guidelines. Frontend development is scheduled to commence upon completion of the backend core.

---

## 📌 Project Overview

**NexaCommand** is a modern, multi-tenant enterprise business management and ERP platform tailored for Retail, Corporate, and Agency businesses. It provides end-to-end operational capabilities—ranging from branch management, role-based personnel administration, and unified POS/B2B billing to immutable double-entry ledgers, hierarchical e-filing approvals, and AI-driven financial simulations.

---

## 📐 Architecture & Process Diagrams

### 1. High-Level System Architecture & Request Pipeline
```mermaid
flowchart TD
    Client["Client / API Consumer (Web / Mobile)"] --> MW_RL["Rate Limiter (Upstash Redis)"]
    MW_RL --> MW_Auth["User Auth (JWT / Cookie Verification)"]
    MW_Auth --> MW_Tenant["Tenant Isolation (tenantId / tenantCode)"]
    MW_Tenant --> MW_Role["RBAC Gate (restrictTo: OWNER, HR, MANAGER, STAFF)"]
    MW_Role --> Controllers["Application Controllers & Business Logic"]

    subgraph CoreServices ["Core Services & Engines"]
        Controllers --> S_Auth["Auth & Identity Engine"]
        Controllers --> S_Org["Org & Branch Management"]
        Controllers --> S_HR["HR & People Operations"]
        Controllers --> S_Payroll["Payroll & EWA Service"]
        Controllers --> S_Catalog["Universal Catalog & Dead-Stock"]
        Controllers --> S_Billing["Unified Billing & Ledger"]
        Controllers --> S_Workflow["e-Filing & Multi-Level Approvals"]
        Controllers --> S_AI["AI Time-Travel Simulation"]
    end

    subgraph Infrastructure ["Data & Cloud Infrastructure"]
        S_Billing --> DB[("PostgreSQL (Prisma ORM)")]
        S_Payroll --> DB
        S_Org --> DB
        S_Workflow --> DB
        S_Workflow --> Cloudinary["Cloudinary (Soft-File Vault)"]
        S_AI --> Gemini["Google Gemini API"]
        S_Auth --> Redis[("Redis Cache / Locks")]
        S_Org --> Mailer["Nodemailer (Async Email)"]
    end
```

### 2. Multi-Tenant Tenancy & Role Hierarchy
```mermaid
flowchart TD
    SA["Super Admin (Platform Level)"] --> Tenant["Tenant / Company (Unique tenantCode)"]
    Tenant --> Owner["Org Owner (Full Administrative Control)"]
    Owner --> HR["Central HR (Staff Lifecycle, Promotions & Directory)"]
    Owner --> Branches["Branches (e.g., Main Branch, Sub-Branch)"]
    Branches --> Manager["Branch Manager (Local Staff, EWA Approvals)"]
    Manager --> Staff["Staff (POS Checkout, EWA Requests, Submissions)"]
    HR -.-> Staff
```

### 3. Enterprise e-Filing & Hierarchical Approval Flow
```mermaid
flowchart LR
    Upload["Staff Uploads Soft-File"] --> Cloud["Cloudinary Storage (Permanent URL)"]
    Cloud --> InitDB["DB Record Created: DocumentRequest & Step 1"]
    InitDB --> Desk["Assignee Digital Desk (Inbox / Outbox)"]
    Desk --> Decision{"Reviewer Action"}
    Decision -->|"Approve & Forward"| Escalate["Escalate to Senior (Zero-Copy)"]
    Decision -->|"Final Approve"| Closed["Status: APPROVED (Completed)"]
    Decision -->|"Reject"| Rejected["Status: REJECTED (With Remarks)"]
    Escalate --> Desk
```

### 4. Unified Billing & Immutable Ledger Event Flow
```mermaid
flowchart TD
    Cart["Cart / Transaction Request"] --> TypeCheck{"Invoice Type"}
    TypeCheck -->|"POS_RECEIPT"| POS["Mark PAID -> Deduct Stock -> Record POS_REVENUE"]
    TypeCheck -->|"B2B_INVOICE"| B2B["Mark PENDING -> Set Due Date -> On Payment Record B2B_REVENUE"]
    POS --> CheckDead{"Is Dead-Stock (>90d)?"}
    CheckDead -->|"Yes"| Bounty["Award Bounty to Staff -> Record BOUNTY_CREDITED"]
    CheckDead -->|"No"| Ledger[("Immutable Double-Entry Ledger")]
    B2B --> Ledger
    Bounty --> Ledger
```

---

## 🚀 Key Features & Modules

### 1. Multi-Tenant SaaS Foundation
- **Workspace Isolation:** Unique 8-character `tenantCode` per organization for zero-cost, strict tenant isolation.
- **Business Type Adaptability:** Dynamic interface and business logic rendering for `RETAIL`, `CORPORATE`, and `AGENCY` models.
- **Subscription Management:** Tiered plans (`BASIC`, `PRO`, `ENTERPRISE`) with automated billing cycle tracking and access gating.

### 2. Authentication & Zero-Trust Security
- **Authentication Modes:** Standard email/password and Google OAuth (for Owners and Platform Super Admins).
- **Session & Token Management:** HttpOnly cookie-based JWT access and refresh tokens with strict rotation and hijack protection.
- **Zero-Trust Role Enforcement:** Strict role-based access control (RBAC) covering `SUPER_ADMIN`, `ORG_OWNER`, `HR`, `BRANCH_MANAGER`, and `STAFF`.
- **Defensive Engineering:** Redis-powered distributed rate limiting, API spam protection, anti-enumeration password resets, and idempotency key handling on financial mutations.

### 3. Organization & Branch Operations
- **Branch Hierarchy:** Creation and management of physical or logical branches with zero-tolerance name duplication.
- **Personnel Provisioning:** Automated generation of globally unique `staffId` and temporary credentials with fail-safe email rollbacks.
- **Management Assignment:** Atomic promotion, reassignment, and demotion of branch managers.
- **Administrative Kill-Switch:** Instant suspension and session revocation across tenants.

### 4. HR & People Operations
- **Staff Lifecycle:** Centralized onboarding, role promotions, department/designation changes, and branch transfers.
- **Salary & Increments:** Base salary revisions, designation progression tracking, and audit notifications.
- **Central Directory:** Filterable staff registry by branch, department, designation, and status.

### 5. Payroll & Earned Wage Access (EWA)
- **Centralized Payroll Engine:** In-memory, DRY calculation engine computing base salary, commissions, and approved deductions.
- **Staff Self-Service (EWA):** Staff can request salary advances with a strict 50% base salary safety cap.
- **One-Click Disbursement:** Atomic monthly payroll generation with double-entry ledger event recording (`SALARY_PAID`) and commission resets.

### 6. Universal Catalog & Smart Dead-Stock Engine
- **Unified Catalog:** Supports both physical products (`PHYSICAL_GOOD`) and digital services (`DIGITAL_SERVICE`).
- **Dynamic Dead-Stock Detection:** Dynamic query-time evaluation of stagnant stock (>90 days) without scheduled cron overhead.
- **Sales Bounty Automation:** Automatic commission and bounty injection for clearing dead inventory.

### 7. Unified Billing, Expenses & Ledger
- **Omnichannel Billing:** Unified engine for instant retail POS checkout (`POS_RECEIPT`) and corporate invoicing (`B2B_INVOICE`) with payment terms.
- **Branch Petty Cash & Expenses:** Expense logging with receipt attachments and category allocations.
- **Immutable Double-Entry Ledger:** Non-destructive financial tracking recording all transactions (`POS_REVENUE`, `B2B_REVENUE`, `SALARY_PAID`, `EWA_ADVANCE`, `BOUNTY_CREDITED`, `REFUND_PROCESSED`, `EXPENSE_RECORDED`).

### 8. Enterprise e-Filing & Hierarchical Approvals
- **Soft-File Routing:** Centralized document upload (PDF, DOCX, XLSX, Images) to cloud storage with automatic garbage collection rollbacks.
- **Zero-Copy Chain-of-Command:** Multi-step digital approval desks (`Inbox` / `Outbox`) with escalation, approval, or rejection actions without duplicate file uploads.
- **Circular Routing Shield:** Prevents infinite escalation loops within document approval chains.

### 9. AI Time-Travel & Financial Simulation
- **Scenario Simulation:** Uses database branching alongside Google Gemini API to model "what-if" PnL scenarios and return structured business insights.

---

## 🛠️ Tech Stack

- **Runtime:** Node.js (ES Modules)
- **Framework:** Express.js 5.x
- **Database & ORM:** PostgreSQL, Prisma ORM
- **Cache & Rate Limiting:** Upstash Redis / Redis Cloud (`ioredis`)
- **File Storage:** Cloudinary (with automated transaction rollback handling)
- **Authentication & Security:** JWT, bcrypt, Google Auth Library
- **Mailing:** Nodemailer (Asynchronous, non-blocking delivery)
- **AI Integration:** Google Gemini API (`@google/generative-ai`)
- **Frontend (Upcoming):** Scheduled to be built following completion of backend services.

---

## 📊 Development Progress & Git Workflow

The project is actively being developed using feature-driven Git branches:

| Branch | Focus Area | Status |
| :--- | :--- | :--- |
| `backend/feat-auth` | Core engine utilities, JWT & Google Auth, Tenant middleware | Completed |
| `backend/feat-org-admin` | Branch creation, Staff provisioning, Manager assignments | Completed |
| `feat-staff` *(Active)* | Staff dashboard, Branch Manager operations, EWA requests | In Progress |
| `backend/feat-hr` | Central HR directory, promotions, salary increments | Scheduled |
| `backend/feat-billing-ledger` | Universal catalog, POS/B2B billing, Expenses, Ledger | Scheduled |
| `backend/feat-workflow` | Enterprise e-filing & hierarchical document approvals | Scheduled |
| `backend/feat-ai` | AI PnL simulation via Gemini API & DB branching | Scheduled |
| `frontend/*` | Client-side dashboard & user interfaces | Planned post-backend |

---

## ⚡ Execution & Getting Started

### Prerequisites
- Node.js (v18+)
- PostgreSQL database
- Upstash Redis account (or local Redis instance)
- Cloudinary credentials
- Google OAuth Client ID & Gemini API key

### Backend Setup
1. **Navigate to the backend directory:**
   ```bash
   cd Backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Ensure a `.env` file exists in `Backend/` containing:
   ```env
   PORT=8000
   DATABASE_URL="postgresql://user:password@host:port/nexacommand"
   UPSTASH_REDIS_URL="rediss://..."
   ACCESS_TOKEN_SECRET="your_access_token_secret"
   REFRESH_TOKEN_SECRET="your_refresh_token_secret"
   CLOUDINARY_CLOUD_NAME="your_cloud_name"
   CLOUDINARY_API_KEY="your_api_key"
   CLOUDINARY_API_SECRET="your_api_secret"
   GOOGLE_CLIENT_ID="your_google_client_id"
   GEMINI_API_KEY="your_gemini_api_key"
   ```

4. **Initialize Database & Prisma Client:**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

5. **Start Development Server:**
   ```bash
   npm run dev
   ```
   The backend API will run on `http://localhost:8000`.

---

## 📌 Note
This README serves as a temporary living document for development tracking and will be updated as modules transition to production and when frontend architecture is initialized.
